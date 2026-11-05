import contextlib
import os
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('adapter', ROOT/'ops/deploy-abigail-update.py')
a = importlib.util.module_from_spec(spec); spec.loader.exec_module(a)

class SchemaGates(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.db = self.root/'fixture.sqlite'
        with sqlite3.connect(self.db) as db: db.execute('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)'); db.execute("INSERT INTO sample(value) VALUES ('preserve')")
        self.update = a.prepare_review(*a.read_inputs())

    def test_digest_uses_exact_attestation_canonical_projection(self):
        with sqlite3.connect(self.db) as db:
            rows = db.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall()
            expected = hashlib.sha256(json.dumps(rows,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
            self.assertEqual(a.schema_digest(db, time.monotonic()+15),expected)

    def test_unattested_copy_schema_refused_and_unchanged(self):
        before = self.db.read_bytes()
        with self.assertRaises(ValueError): a.require_copy_schema(self.db)
        self.assertEqual(self.db.read_bytes(),before)

    def test_live_gate_reads_committed_wal_and_preserves_rows(self):
        writer = sqlite3.connect(self.db); self.addCleanup(writer.close)
        writer.execute('PRAGMA journal_mode=WAL'); writer.execute("INSERT INTO sample(value) VALUES ('committed WAL')");writer.commit()
        guards = types.SimpleNamespace(database_identity=mock.Mock(return_value=('same',)))
        update = types.SimpleNamespace(guards=guards)
        seen = []
        def inspect(db, deadline):
            seen.extend(db.execute('SELECT value FROM sample ORDER BY id').fetchall())
            return a.SCHEMA_BEFORE
        with mock.patch.object(a,'schema_digest',side_effect=inspect): a.require_live_schema(update,self.db,object())
        self.assertEqual(seen,[('preserve',),('committed WAL',)])
        self.assertEqual(writer.execute('SELECT count(*) FROM sample').fetchone(),(2,))
        self.assertEqual(guards.database_identity.call_count,2)

    def test_live_schema_or_identity_drift_refused(self):
        guards=types.SimpleNamespace(database_identity=mock.Mock(return_value=('same',)))
        with self.assertRaises(ValueError): a.require_live_schema(types.SimpleNamespace(guards=guards),self.db,object())
        guards.database_identity.side_effect=[('before',),('after',)]
        with mock.patch.object(a,'schema_digest',return_value=a.SCHEMA_BEFORE),self.assertRaises(ValueError): a.require_live_schema(types.SimpleNamespace(guards=guards),self.db,object())

    def test_cleanly_stopped_wal_missing_sidecars_refuses_without_creating(self):
        writer=sqlite3.connect(self.db);writer.execute('PRAGMA journal_mode=WAL');writer.execute("INSERT INTO sample(value) VALUES ('closed')");writer.commit();writer.close()
        self.assertEqual(self.db.read_bytes()[18:20], b'\x02\x02')
        for suffix in ('-wal','-shm'): self.assertFalse(Path(str(self.db)+suffix).exists())
        guards=types.SimpleNamespace(database_identity=mock.Mock(return_value=('same',)))
        with self.assertRaises(ValueError):a.require_live_schema(types.SimpleNamespace(guards=guards),self.db,object())
        for suffix in ('-wal','-shm'): self.assertFalse(Path(str(self.db)+suffix).exists())

    def test_bounded_rehearsal_callback_cannot_be_replaced(self):
        callback=self.update.core.rehearse
        with self.assertRaises(ValueError):callback(*([None]*7))
        with self.assertRaises(ValueError):callback(*([None]*6+[object()]),prepare_snapshot=lambda _:None)

    def test_expired_schema_deadline_refused(self):
        with sqlite3.connect(self.db) as db, self.assertRaises(ValueError):
            a.schema_digest(db,time.monotonic()-1)

    def test_oversize_backup_progress_refused_and_connections_closed(self):
        guards=types.SimpleNamespace(database_identity=mock.Mock(return_value=('same',)))
        source=mock.MagicMock();target=mock.MagicMock()
        source.execute.return_value.fetchone.return_value=(4096,)
        source.backup.side_effect=lambda target,**kw:kw['progress'](0,1,a.MAX_SNAPSHOT//4096+1)
        with mock.patch.object(a.sqlite3,'connect',side_effect=[source,target]),self.assertRaises(ValueError):
            a.require_live_schema(types.SimpleNamespace(guards=guards),self.db,object())
        source.close.assert_called_once();target.close.assert_called_once()

    def test_schema_query_failure_closes_copy_connection(self):
        connection=mock.MagicMock();connection.execute.side_effect=sqlite3.OperationalError('fixture')
        with mock.patch.object(a.sqlite3,'connect',return_value=connection),self.assertRaises(sqlite3.OperationalError):
            a.require_copy_schema(self.db)
        connection.close.assert_called_once()

    def test_callback_runs_inside_real_bounded_copy_rehearsal(self):
        core=self.update.core;candidate=self.root/'candidate';(candidate/'.next').mkdir(parents=True);(candidate/'.next/BUILD_ID').write_text('fixture')
        runtime=self.root/'runtime';runtime.mkdir();owner=types.SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid())
        with sqlite3.connect(self.db) as db:expected=a.schema_digest(db,time.monotonic()+15)
        report=core.RehearsalReport()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(core,'RUNTIME',runtime))
            stack.enter_context(mock.patch.object(a,'SCHEMA_BEFORE',expected))
            callback=stack.enter_context(mock.patch.object(a,'require_copy_schema',wraps=a.require_copy_schema))
            for name in ('command','network_command','health','check_runtime'):
                stack.enter_context(mock.patch.object(core,name))
            stack.enter_context(mock.patch.object(core,'probe_state',return_value={'LoadState':'not-found','ActiveState':'inactive','MainPID':'0'}))
            stack.enter_context(mock.patch.object(core,'verify_private_network',return_value=123))
            stack.enter_context(mock.patch.object(core.signal,'setitimer'))
            core.rehearse(candidate,{},self.db,self.root/'status',owner,'fixture',report)
            callback.assert_called_once()
        self.assertTrue(report.cleanup);self.assertIsNone(report.failure);self.assertEqual(list(runtime.iterdir()),[])

    def activation(self, checker, fail_stop=False, fail_candidate=False):
        old=self.root/'old';new=self.root/'new';old.mkdir();new.mkdir();current=self.root/'current';current.symlink_to(old)
        events=[]
        marker=self.root/'marker';marker.write_text('old')
        def service(action, name):
            events.append(action)
            if fail_stop and len(events)==1:raise RuntimeError('uncertain stop')
        def validate(target):
            events.append('validate-'+target.name)
            marker.write_text(target.name)
            if fail_candidate and target==new:raise RuntimeError('candidate failed')
        invoke=self.update.review_activation(checker)
        return current,old,new,events,lambda:invoke(current,new,service,validate)

    def test_success_checks_before_switch_and_after_validation(self):
        checker=mock.Mock();current,old,new,events,invoke=self.activation(checker);invoke()
        self.assertEqual(current.resolve(),new);self.assertEqual(events,['stop','start','validate-new']);self.assertEqual(checker.call_count,2)

    def test_precheck_failure_does_not_stop_or_switch(self):
        checker=mock.Mock(side_effect=ValueError('schema'));current,old,new,events,invoke=self.activation(checker)
        with self.assertRaisesRegex(ValueError,'schema'):invoke()
        self.assertEqual(current.resolve(),old);self.assertEqual(events,[]);self.assertEqual(checker.call_count,1)

    def test_persistent_schema_failure_still_runs_rollback_validation(self):
        checker=mock.Mock(side_effect=[None,ValueError('schema'),ValueError('schema')]);current,old,new,events,invoke=self.activation(checker)
        with self.assertRaisesRegex(ValueError,'schema'):invoke()
        self.assertEqual(current.resolve(),old);self.assertEqual(events,['stop','start','validate-new','stop','restart','validate-old']);self.assertEqual(checker.call_count,3)
        self.assertEqual((self.root/'marker').read_text(),'old')

    def test_uncertain_stop_recovers_old_pointer(self):
        checker=mock.Mock();current,old,new,events,invoke=self.activation(checker,fail_stop=True)
        with self.assertRaisesRegex(RuntimeError,'uncertain stop'):invoke()
        self.assertEqual(current.resolve(),old);self.assertEqual(events,['stop','stop','restart','validate-old'])
        self.assertEqual(checker.call_count,2)

    def test_candidate_failure_uses_original_code_only_recovery(self):
        checker=mock.Mock();current,old,new,events,invoke=self.activation(checker,fail_candidate=True)
        with self.assertRaisesRegex(RuntimeError,'candidate failed'):invoke()
        self.assertEqual(current.resolve(),old);self.assertEqual(events,['stop','start','validate-new','stop','restart','validate-old'])

if __name__=='__main__':unittest.main()
