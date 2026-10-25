import contextlib
import importlib.util
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock
ROOT=Path(__file__).resolve().parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
base=load('base',ROOT/'ops/exact-cleanup-host.py')
r=load('recovery',ROOT/'ops/recover-exact-cleanup.py')
class RecoveryTests(unittest.TestCase):
    def test_no_deletion_or_environment_writer_in_recovery(self):
        text=(ROOT/'ops/recover-exact-cleanup.py').read_text()
        for token in ('apply_in_transaction(','.mutate(','.recovery_copy(','.commit(', 'atomic_env(', 'DELETE FROM', 'INSERT INTO', 'UPDATE '):self.assertNotIn(token,text)
    def test_check_only_and_changed_snapshot_do_not_start(self):
        for activate,changed in ((False,False),(True,True),(True,False)):
            calls=[]
            @contextlib.contextmanager
            def lock():yield
            host=types.SimpleNamespace(locked=lock,preflight=lambda:b'env',committed_snapshot=lambda:('changed' if changed and calls else calls.append('read') or 'snapshot'),resume=lambda raw:calls.append('start'))
            if changed:
                with self.assertRaises(ValueError):r.run_recovery(host,base,activate)
            else:r.run_recovery(host,base,activate)
            self.assertEqual('start' in calls,activate and not changed)
    def test_resume_waits_before_strict_identity_and_reholds_all_failures(self):
        for failure in (None,'start','health','strict','stable'):
            with self.subTest(failure=failure),tempfile.TemporaryDirectory() as tmp:
                events=[];state=Path(tmp);(state/'app-hold').write_bytes(b'held\n')
                with mock.patch.object(base,'STATE',state):
                    cls=r.recovery_class(base);host=object.__new__(cls)
                host.owner=object();host.env_id=('snapshot',);raw=b'env';host.held_identity=base.file_identity(state/'app-hold')
                def event(name):
                    events.append(name)
                    if failure==name:raise ValueError('private error')
                host.quiet=lambda:event('quiet')
                host.guards=types.SimpleNamespace(environment_snapshot=lambda *a:(raw,host.env_id))
                host.host=types.SimpleNamespace(service=lambda *a:event('start'))
                host.controller=types.SimpleNamespace(core=types.SimpleNamespace(APP='app'))
                host.core=types.SimpleNamespace(health=lambda p:event('health'),parse=lambda raw:{})
                host.effective=lambda v:event('strict');host.stable=lambda:event('stable')
                def hold():events.append('hold');(state/'app-hold').write_bytes(b'held\n')
                host.emergency_hold_stop=hold
                if failure:
                    with self.assertRaises(ValueError):host.resume(raw)
                    self.assertTrue((state/'app-hold').exists());self.assertEqual(events[-1],'hold')
                else:
                    host.resume(raw);self.assertLess(events.index('health'),events.index('strict'));self.assertFalse((state/'app-hold').exists())
    def test_real_sqlite_committed_snapshot_rejects_extra_rows_and_never_writes(self):
        import test_test_data_cleanup_core as c
        fixture=c.CleanupTests();self.addCleanup(fixture.doCleanups);db,raw=fixture.fixture();plan=c.m.inspect(db,raw)
        db.execute('BEGIN IMMEDIATE');c.m.apply_in_transaction(db,raw,plan['fingerprint'],c.m.CONFIRMATION);db.commit()
        cls=r.recovery_class(base);host=object.__new__(cls);host.quiet=lambda:None;host.owner=object();host.original=raw;host.env_id=();host.db_id=();host.dbpath=Path('/unused')
        host.guards=types.SimpleNamespace(environment_snapshot=lambda *a:(raw,()),database_identity=lambda *a:())
        @contextlib.contextmanager
        def database(readonly):
            self.assertTrue(readonly);db.execute('PRAGMA query_only=ON');yield db
        host.database=database;host.as_app=lambda f:f();host.cleanup=c.m
        before=c.m.database_state(db);first=host.committed_snapshot();self.assertEqual(first,host.committed_snapshot());self.assertEqual(before,c.m.database_state(db))
        db.execute('PRAGMA query_only=OFF');db.execute("DELETE FROM staff_accounts WHERE status='active'")
        with self.assertRaises(ValueError):host.committed_snapshot()
