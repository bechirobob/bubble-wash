import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'ops' / filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module
repair = load('repair', 'repair-staff-schema.py')
deploy = load('preserving', 'deploy-preserving.py')

CORE = '''CREATE TABLE existing_roles (id TEXT PRIMARY KEY, role TEXT NOT NULL, credential TEXT NOT NULL);
CREATE TABLE driver_locations (driver TEXT, captured_at TEXT);
CREATE INDEX location_time ON driver_locations(captured_at);
CREATE TABLE with_rowid (value TEXT);
CREATE TABLE no_rowid (id TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;'''
STAFF = 'CREATE TABLE IF NOT EXISTS staff_accounts (email TEXT PRIMARY KEY COLLATE NOCASE, name TEXT NOT NULL, role TEXT NOT NULL, entity_id TEXT NOT NULL, password_hash TEXT NOT NULL, credential_version TEXT NOT NULL, status TEXT NOT NULL, token_hash TEXT NOT NULL, token_expires_at TEXT NOT NULL, updated_at TEXT NOT NULL)'


class SingleTableTransaction(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'synthetic.sqlite'
        self.db = sqlite3.connect(self.path); self.addCleanup(self.db.close)
        self.db.executescript(CORE)
        self.db.execute('INSERT INTO existing_roles VALUES (?, ?, ?)', ('legacy', 'admin', 'synthetic-credential'))
        self.db.execute('INSERT INTO driver_locations VALUES (?, ?)', ('synthetic', '2000-01-01'))
        self.db.execute("INSERT INTO with_rowid(rowid,value) VALUES (7,'a'),(91,'b')")
        self.db.execute("INSERT INTO no_rowid VALUES ('a','synthetic')")
        self.db.execute('PRAGMA user_version=71'); self.db.execute('PRAGMA application_id=95'); self.db.commit()
        self.before = deploy.database_fingerprint(self.path)
        self.version = self.db.execute('PRAGMA schema_version').fetchone()[0]

    def rejected(self, expected):
        with self.assertRaises(repair.RepairRejected) as caught:
            repair.repair_transaction(self.db, CORE, STAFF)
        self.assertEqual(str(caught.exception), expected)
        self.assertFalse(self.db.in_transaction)

    def test_fingerprint_matches_unmodified_deploy_guard(self):
        self.assertEqual(repair.fingerprint(self.db), self.before)

    def test_single_empty_addition_preserves_all_preexisting_schema_rows_and_metadata(self):
        before_schema = repair.schema(self.db)
        self.assertEqual(repair.repair_transaction(self.db, CORE, STAFF), 'CREATED_EMPTY')
        required, added = repair.reference_objects(CORE, STAFF)
        self.assertEqual(repair.schema(self.db), sorted(before_schema + added))
        self.assertEqual(self.db.execute('SELECT count(*) FROM staff_accounts').fetchone(), (0,))
        self.assertEqual(repair.fingerprint(self.db, tuple(row[1] for row in added)), self.before)
        self.assertEqual(self.db.execute('PRAGMA schema_version').fetchone()[0], self.version + 1)
        self.assertNotEqual(deploy.database_fingerprint(self.path), self.before)

    def test_exact_empty_existing_table_is_explicit_noop(self):
        repair.repair_transaction(self.db, CORE, STAFF)
        before = deploy.database_fingerprint(self.path); version = self.db.execute('PRAGMA schema_version').fetchone()
        self.assertEqual(repair.repair_transaction(self.db, CORE, STAFF), 'ALREADY_EXACT_EMPTY')
        self.assertEqual(deploy.database_fingerprint(self.path), before)
        self.assertEqual(self.db.execute('PRAGMA schema_version').fetchone(), version)

    def test_existing_nonempty_table_is_never_overwritten_or_reset(self):
        repair.repair_transaction(self.db, CORE, STAFF)
        self.db.execute('INSERT INTO staff_accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        ('synthetic@example.test', 'Synthetic', 'admin', '', 'synthetic', 'v1', 'active', '', '', ''))
        self.db.commit(); before = deploy.database_fingerprint(self.path)
        self.rejected('STAFF_TABLE_NOT_EMPTY'); self.assertEqual(deploy.database_fingerprint(self.path), before)

    def test_wrong_existing_table_or_case_variant_is_rejected(self):
        for sql in ('CREATE TABLE staff_accounts (id TEXT)', 'CREATE VIEW STAFF_ACCOUNTS AS SELECT role FROM existing_roles'):
            with self.subTest(sql=sql):
                self.db.execute(sql); self.db.commit(); before = deploy.database_fingerprint(self.path)
                self.rejected('EXISTING_STAFF_SCHEMA_MISMATCH')
                self.assertEqual(deploy.database_fingerprint(self.path), before)
                self.db.execute('DROP ' + ('VIEW' if 'VIEW' in sql else 'TABLE') + ' staff_accounts'); self.db.commit()

    def test_missing_or_changed_other_required_schema_blocks_repair(self):
        self.db.execute('DROP INDEX location_time'); self.db.commit(); before = deploy.database_fingerprint(self.path)
        self.rejected('CORE_SCHEMA_MISMATCH'); self.assertEqual(deploy.database_fingerprint(self.path), before)

    def test_unrelated_legacy_objects_are_preserved(self):
        self.db.execute('CREATE TABLE legacy_extra (payload BLOB)'); self.db.execute("INSERT INTO legacy_extra VALUES (X'012345')"); self.db.commit()
        before = deploy.database_fingerprint(self.path)
        repair.repair_transaction(self.db, CORE, STAFF)
        added = repair.reference_objects(CORE, STAFF)[1]
        self.assertEqual(repair.fingerprint(self.db, tuple(row[1] for row in added)), before)

    def test_unexpected_data_or_rowid_or_metadata_change_rolls_back_creation(self):
        original = repair.fingerprint
        for mutate in ("UPDATE existing_roles SET credential='unexpected'", 'UPDATE with_rowid SET rowid=rowid+100', 'PRAGMA user_version=72'):
            calls = 0
            def fingerprint(connection, excluded=()):
                nonlocal calls
                calls += 1
                if calls == 2: connection.execute(mutate)
                return original(connection, excluded)
            with patch.object(repair, 'fingerprint', side_effect=fingerprint):
                self.rejected('EXISTING_DATA_CHANGED')
            self.assertEqual(deploy.database_fingerprint(self.path), self.before)
            self.assertEqual(self.db.execute('PRAGMA schema_version').fetchone()[0], self.version)

    def test_post_create_exception_or_cancellation_rolls_back(self):
        original = repair.fingerprint
        for failure in (RuntimeError('synthetic'), KeyboardInterrupt()):
            def fingerprint(connection, excluded=()):
                if excluded: raise failure
                return original(connection, excluded)
            with patch.object(repair, 'fingerprint', side_effect=fingerprint), self.assertRaises(type(failure)):
                repair.repair_transaction(self.db, CORE, STAFF)
            self.assertFalse(self.db.in_transaction)
            self.assertEqual(deploy.database_fingerprint(self.path), self.before)

    def test_transaction_does_not_use_executescript_on_live_connection(self):
        statements = []; self.db.set_trace_callback(statements.append)
        repair.repair_transaction(self.db, CORE, STAFF)
        persistent = [item for item in statements if item.lstrip().upper().startswith(('CREATE', 'INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP'))]
        self.assertEqual(persistent, [STAFF])
        self.assertEqual(statements.count('BEGIN IMMEDIATE'), 1); self.assertEqual(statements.count('COMMIT'), 1)
        self.assertLess(statements.index('BEGIN IMMEDIATE'), statements.index(STAFF))

    def test_busy_writer_prevents_mutation(self):
        other = sqlite3.connect(self.path, timeout=0.01); self.addCleanup(other.close)
        self.db.execute('BEGIN IMMEDIATE')
        with self.assertRaises(sqlite3.OperationalError): repair.repair_transaction(other, CORE, STAFF)
        self.db.rollback(); self.assertEqual(deploy.database_fingerprint(self.path), self.before)


class RepairBoundaries(unittest.TestCase):
    def setUp(self):
        import os
        from types import SimpleNamespace
        self.directory = tempfile.TemporaryDirectory(dir=ROOT); self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name); self.path = self.root / 'synthetic.sqlite'
        self.db = sqlite3.connect(self.path); self.addCleanup(self.db.close)
        self.db.execute('PRAGMA journal_mode=WAL'); self.db.executescript(CORE)
        self.db.execute("INSERT INTO existing_roles VALUES('legacy','admin','synthetic')"); self.db.commit()
        self.owner = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        self.report = SimpleNamespace(outcome='NOT_COMMITTED', safe_to_remove=True)
        self.before = deploy.database_fingerprint(self.path)
        repair.REPAIR_SOURCE = (ROOT / 'ops/repair-staff-schema.py').read_text()

    def test_inspect_only_reads_metadata_and_never_opens_sqlite_or_launches_worker(self):
        from types import SimpleNamespace
        report = SimpleNamespace(stage='', path_flags=None)
        with patch.object(repair.sqlite3, 'connect') as sql, patch.object(repair, 'worker_transaction') as worker:
            repair.run_action(deploy, 'inspect', self.root, {}, self.path, self.root/'status', self.owner, 'unit', report, lambda: None)
        sql.assert_not_called(); worker.assert_not_called()
        self.assertEqual(set(report.path_flags), {'directoryOwnersTrusted', 'directoriesRootOwned', 'directoryModesSafe',
            'databaseFilesRegular', 'databaseFilesSingleLink', 'databaseFileOwnersTrusted', 'databaseFileModesSafe', 'walModeExisting', 'repairPathTrusted'})
        self.assertTrue(all(type(value) is bool for value in report.path_flags.values()))

    def test_normal_cli_cannot_select_repair_entrypoint(self):
        import sys
        with patch.object(sys, 'argv', ['deploy', '--repair-staff-schema']), self.assertRaises(ValueError):
            deploy.main(lambda: None)

    def test_core_validator_runs_under_transaction_before_ddl_and_before_commit(self):
        states=[]
        def validate(): states.append((self.db.in_transaction, bool(self.db.execute("SELECT 1 FROM sqlite_master WHERE name='staff_accounts'").fetchone())))
        repair.repair_transaction(self.db, CORE, STAFF, validate)
        self.assertEqual(states, [(True,False),(True,True),(True,True)])

    def test_precommit_identity_failure_rolls_back(self):
        calls=0
        def validate():
            nonlocal calls
            calls+=1
            if calls==2: raise repair.RepairRejected('DATABASE_IDENTITY_CHANGED')
        with self.assertRaises(repair.RepairRejected): repair.repair_transaction(self.db,CORE,STAFF,validate)
        self.assertEqual(deploy.database_fingerprint(self.path),self.before)

    def test_trusted_parent_modes_fail_closed_without_chmod(self):
        import os
        old=self.root.stat().st_mode
        os.chmod(self.root,0o777)
        try:
            with repair.DatabaseBinding(self.path,self.owner.pw_uid) as binding:
                self.assertFalse(binding.flags()['repairPathTrusted'])
                with self.assertRaisesRegex(repair.RepairRejected,'UNTRUSTED_DATABASE_PATH'): binding.require_trusted()
            self.assertEqual(self.root.stat().st_mode & 0o777,0o777)
        finally: os.chmod(self.root,old)

    def test_leaf_symlink_and_hardlink_are_refused(self):
        import os
        alias=self.root/'alias.sqlite';alias.symlink_to(self.path)
        with self.assertRaises(OSError): repair.DatabaseBinding(alias,self.owner.pw_uid)
        os.link(self.path,self.root/'hardlink')
        with repair.DatabaseBinding(self.path,self.owner.pw_uid) as binding:
            self.assertFalse(binding.flags()['databaseFilesSingleLink'])
            with self.assertRaises(repair.RepairRejected): binding.require_trusted()

    def test_ancestor_and_main_swap_fail_identity_check(self):
        with repair.DatabaseBinding(self.path,self.owner.pw_uid) as binding:
            moved=self.root/'moved.sqlite';self.path.rename(moved);self.path.write_bytes(b'not a database')
            with self.assertRaisesRegex(repair.RepairRejected,'DATABASE_IDENTITY_CHANGED'):binding.verify()
            self.path.unlink();moved.rename(self.path)
        link=self.root/'ancestor';link.symlink_to(self.root,target_is_directory=True)
        with self.assertRaises(OSError): repair.DatabaseBinding(link/self.path.name,self.owner.pw_uid)

    def test_missing_or_replaced_sidecar_is_refused(self):
        wal=Path(str(self.path)+'-wal');moved=self.root/'held-wal'
        with repair.DatabaseBinding(self.path,self.owner.pw_uid) as binding:
            wal.rename(moved);wal.write_bytes(b'')
            with self.assertRaises(repair.RepairRejected):binding.verify()
            wal.unlink();moved.rename(wal)
        shm=Path(str(self.path)+'-shm');held=self.root/'held-shm';shm.rename(held)
        try:
            with repair.DatabaseBinding(self.path,self.owner.pw_uid) as binding:
                self.assertFalse(binding.flags()['repairPathTrusted'])
        finally:held.rename(shm)

    def test_unexpected_rollback_journal_is_refused(self):
        Path(str(self.path)+'-journal').write_bytes(b'synthetic')
        with self.assertRaisesRegex(repair.RepairRejected,'UNEXPECTED_JOURNAL'):repair.DatabaseBinding(self.path,self.owner.pw_uid)

    def test_copy_binding_pins_only_exact_main_and_parent_before_own_sidecar_creation(self):
        target=self.root/'copy.sqlite'
        copied=sqlite3.connect(target);self.db.backup(copied);copied.close()
        with repair.DatabaseBinding(target,self.owner.pw_uid,copy_mode=True) as binding:
            binding.require_trusted()
            self.assertEqual(len(binding.files),1)
            self.assertEqual(binding.files[0][3].st_ino,target.stat().st_ino)

    def launch(self,*args,**kwargs):
        # Real worker runs with the actual unprivileged real/effective/saved UID,
        # GID and empty groups in this local environment. Only the root-only
        # Popen privilege-setting syscalls are omitted when already unprivileged.
        import os,subprocess
        self.assertEqual(kwargs['user'],self.owner.pw_uid)
        self.assertEqual(kwargs['group'],self.owner.pw_gid)
        self.assertEqual(kwargs['extra_groups'],[])
        self.assertTrue(kwargs['close_fds']);self.assertEqual(kwargs['cwd'],'/')
        self.assertEqual(kwargs['env'],{'PATH':'/usr/bin:/bin','LC_ALL':'C'})
        if os.geteuid()!=0:
            if os.getgroups()!=[]:self.skipTest('Actual unprivileged worker requires an empty-group local executor; root-drop syscall remains an integration check')
            kwargs.pop('user');kwargs.pop('group');kwargs.pop('extra_groups')
        return self.real_popen(*args,**kwargs)

    def worker(self,verify=lambda:None,source=None):
        import subprocess
        self.real_popen=subprocess.Popen
        with repair.DatabaseBinding(self.path,self.owner.pw_uid) as binding, patch.object(repair.subprocess,'Popen',side_effect=self.launch):
            if source is not None:repair.REPAIR_SOURCE=source
            return repair.worker_transaction(self.owner,binding,CORE,STAFF,verify,self.report)

    def test_actual_unprivileged_worker_creates_only_expected_empty_table(self):
        calls=[]
        self.assertEqual(self.worker(lambda:calls.append(True)),'CREATED_EMPTY')
        self.assertEqual(calls,[True]);self.assertEqual(self.report.outcome,'COMMIT_UNCERTAIN')
        self.assertEqual(repair.fingerprint(self.db,('staff_accounts','sqlite_autoindex_staff_accounts_1')),self.before)

    def test_actual_worker_exact_empty_noop_never_requests_commit(self):
        repair.repair_transaction(self.db,CORE,STAFF)
        before=deploy.database_fingerprint(self.path)
        self.assertEqual(self.worker(lambda:self.fail('No-op requested a write acknowledgement')),'ALREADY_EXACT_EMPTY')
        self.assertEqual(self.report.outcome,'NOT_COMMITTED')
        self.assertEqual(deploy.database_fingerprint(self.path),before)

    def test_parent_precommit_rejection_kills_and_rolls_back_worker(self):
        def reject():raise repair.RepairRejected('DATABASE_IDENTITY_CHANGED')
        with self.assertRaises(repair.RepairRejected):self.worker(reject)
        self.assertEqual(deploy.database_fingerprint(self.path),self.before)
        self.assertEqual(self.report.outcome,'NOT_COMMITTED')

    def test_commit_acknowledgement_then_lost_result_is_explicitly_uncertain(self):
        source=repair.REPAIR_SOURCE.replace("            print(outcome, flush=True)","            os._exit(7)")
        with self.assertRaisesRegex(repair.RepairRejected,'WORKER_PROTOCOL'):self.worker(source=source)
        self.assertEqual(self.report.outcome,'COMMIT_UNCERTAIN')
        self.assertEqual(self.db.execute('SELECT count(*) FROM staff_accounts').fetchone(),(0,))
        self.assertEqual(repair.fingerprint(self.db,('staff_accounts','sqlite_autoindex_staff_accounts_1')),self.before)

    def test_copy_worker_is_reaped_before_cleanup_becomes_safe(self):
        import subprocess
        target=self.root/'copy.sqlite';copied=sqlite3.connect(target);self.db.backup(copied);copied.close()
        self.real_popen=subprocess.Popen
        with repair.DatabaseBinding(target,self.owner.pw_uid,copy_mode=True) as binding, patch.object(repair.subprocess,'Popen',side_effect=self.launch):
            def check():self.assertFalse(self.report.safe_to_remove)
            self.assertEqual(repair.worker_transaction(self.owner,binding,CORE,STAFF,check,self.report),'CREATED_EMPTY')
        self.assertTrue(self.report.safe_to_remove)
        self.assertEqual(self.report.outcome,'NOT_COMMITTED')
        self.assertEqual(deploy.database_fingerprint(self.path),self.before)

    def test_copy_worker_cancellation_reaps_worker_and_rolls_back_before_cleanup(self):
        import subprocess
        target=self.root/'copy.sqlite';copied=sqlite3.connect(target);self.db.backup(copied);copied.close()
        before=deploy.database_fingerprint(target);self.real_popen=subprocess.Popen
        with repair.DatabaseBinding(target,self.owner.pw_uid,copy_mode=True) as binding, patch.object(repair.subprocess,'Popen',side_effect=self.launch):
            def cancel():raise KeyboardInterrupt()
            with self.assertRaises(KeyboardInterrupt):repair.worker_transaction(self.owner,binding,CORE,STAFF,cancel,self.report)
        self.assertTrue(self.report.safe_to_remove);self.assertEqual(deploy.database_fingerprint(target),before)

    def test_uncertain_copy_worker_launch_never_authorizes_cleanup(self):
        target=self.root/'copy.sqlite';copied=sqlite3.connect(target);self.db.backup(copied);copied.close()
        with repair.DatabaseBinding(target,self.owner.pw_uid,copy_mode=True) as binding, patch.object(repair.subprocess,'Popen',side_effect=OSError('DO_NOT_PRINT')):
            with self.assertRaises(OSError):repair.worker_transaction(self.owner,binding,CORE,STAFF,lambda:None,self.report)
        self.assertFalse(self.report.safe_to_remove)

    def test_worker_invalid_ids_emit_only_fixed_error_before_database_open(self):
        import json,subprocess,sys
        program="__name__='repair_worker'\n"+repair.REPAIR_SOURCE+"\nsys.exit(worker_main())\n"
        completed=subprocess.run([sys.executable,'-I','-B','-c',program],input=json.dumps({'uid':0,'gid':0,'path':'DO_NOT_PRINT'}).encode()+b'\n',capture_output=True,timeout=5)
        self.assertEqual(completed.stdout,b'ERROR:WORKER_PRIVILEGES\n');self.assertEqual(completed.stderr,b'')
        self.assertEqual(deploy.database_fingerprint(self.path),self.before)

    def protocol(self,reply,timeout=False):
        import json,os,subprocess,sys
        if os.getgroups()!=[]:self.skipTest('Requires actual empty supplementary groups')
        with repair.DatabaseBinding(self.path,self.owner.pw_uid) as binding:
            payload={'uid':os.getuid(),'gid':os.getgid(),'path':str(self.path),'copy':False,
                     'files':[[x[3].st_dev,x[3].st_ino] for x in binding.files],
                     'directories':[[x[3].st_dev,x[3].st_ino] for x in binding.directories], 'core':CORE,'staff':STAFF}
        source=repair.REPAIR_SOURCE.replace('signal.alarm(60)','signal.alarm(1)') if timeout else repair.REPAIR_SOURCE
        program="__name__='repair_worker'\n"+source+"\nsys.exit(worker_main())\n"
        process=subprocess.Popen([sys.executable,'-I','-B','-c',program],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            process.stdin.write(json.dumps(payload).encode()+b'\n');process.stdin.flush()
            self.assertEqual(process.stdout.readline(),b'PRECOMMIT\n')
            if reply is not None:process.stdin.write(reply);process.stdin.flush()
            if not timeout:process.stdin.close()
            self.assertEqual(process.wait(timeout=5),1)
            result=process.stdout.read();self.assertEqual(process.stderr.read(),b'')
            self.assertEqual(deploy.database_fingerprint(self.path),self.before)
            return result
        finally:
            if process.poll() is None:process.kill();process.wait()
            process.stdin.close();process.stdout.close();process.stderr.close()

    def test_parent_eof_never_defaults_to_commit(self):
        self.assertEqual(self.protocol(None),b'ERROR:WORKER_PROTOCOL\n')

    def test_invalid_commit_acknowledgement_rolls_back(self):
        self.assertEqual(self.protocol(b'COMMIT_MORE\n'),b'ERROR:WORKER_PROTOCOL\n')

    def test_waiting_for_ack_timeout_rolls_back(self):
        self.assertEqual(self.protocol(None,timeout=True),b'ERROR:WORKER_TIMEOUT\n')

    def test_workflow_default_inspect_existing_protection_and_bundled_sources(self):
        workflow=(ROOT/'.github/workflows/production-staff-schema-repair.yml').read_text()
        for text in ('default: inspect','group: bubblewash-production','environment: backup-storage',
                     'permissions:\n  contents: read','TARGET_SHA="$GITHUB_SHA" python3 ops/check-release-ci.py',
                     "REPAIR_SOURCE = ", '--repair-staff-schema --operation', 'extra_groups=[]'):
            self.assertIn(text,workflow if text!='extra_groups=[]' else repair.REPAIR_SOURCE)
        self.assertNotIn('activate(',repair.REPAIR_SOURCE)
        self.assertNotIn('getDatabase',repair.REPAIR_SOURCE)


class ExistingEngineHooks(unittest.TestCase):
    def fixture(self):
        spec=importlib.util.spec_from_file_location('existing_tests',ROOT/'tests/test_preserving_deploy.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        fixture=module.RehearsalOnly(methodName='runTest');fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        return fixture,module.deploy

    def test_separate_callback_requires_explicit_flag_and_returns_before_build_or_activation(self):
        import contextlib,sys
        fixture,engine=self.fixture();calls=[]
        args=[item if item!='--rehearsal-only' else '--repair-staff-schema' for item in fixture.args]
        with contextlib.ExitStack() as stack:
            for name,value in [('HOME',fixture.root),('CURRENT',fixture.current),('ENV',fixture.env),('RUNTIME',fixture.runtime),('RECEIPT',fixture.receipt)]:
                stack.enter_context(patch.object(engine,name,value))
            stack.enter_context(patch.object(sys,'argv',args));stack.enter_context(patch.object(engine.os,'geteuid',return_value=0))
            stack.enter_context(patch.object(engine.pwd,'getpwnam',return_value=fixture.owner))
            stack.enter_context(patch.object(engine,'verify_source_transition'));stack.enter_context(patch.object(engine,'REVIEWED_READER_TRANSITIONS',{}))
            for name in ('check_runtime','health'):stack.enter_context(patch.object(engine,name))
            for name in ('command','rehearse','activate','ctl','public_health'):
                stack.enter_context(patch.object(engine,name,side_effect=AssertionError('forbidden production action')))
            def callback(*values):
                self.assertEqual(values[2],fixture.db);values[-1]();calls.append(True)
            engine.main(lambda:None,engine.RehearsalReport(),repair_action=callback)
        self.assertEqual(calls,[True]);self.assertEqual(engine.database_fingerprint(fixture.db),fixture.before)
        self.assertEqual(fixture.current.resolve(),fixture.old)

    def test_copy_preparation_runs_before_full_fingerprint_and_probe_without_changing_live(self):
        import contextlib
        fixture,engine=self.fixture();report=engine.RehearsalReport();events=[]
        original=engine.database_fingerprint
        def prepare(snapshot):
            events.append('prepare');self.assertNotEqual(snapshot,fixture.db)
            with sqlite3.connect(snapshot) as connection:
                repair.repair_transaction(connection,'CREATE TABLE synthetic(id INTEGER PRIMARY KEY, value TEXT)',STAFF)
        def fingerprint(path):
            events.append('fingerprint')
            with sqlite3.connect(path) as connection:self.assertEqual(connection.execute('SELECT count(*) FROM staff_accounts').fetchone(),(0,))
            return original(path)
        def command(args,timeout=30):
            if args[0]=='systemd-run':events.append('probe')
            return fixture.command(args,timeout)
        with patch.object(engine,'RUNTIME',fixture.runtime),patch.object(engine,'probe_state',side_effect=fixture.state), \
             patch.object(engine,'verify_private_network',return_value=321),patch.object(engine,'check_runtime'),patch.object(engine,'health'), \
             patch.object(engine,'network_command',side_effect=fixture.network),patch.object(engine,'command',side_effect=command), \
             patch.object(engine,'database_fingerprint',side_effect=fingerprint),patch.object(engine.signal,'setitimer'):
            engine.rehearse(fixture.candidate,{},fixture.db,fixture.status,fixture.owner,'bubblewash-rehearsal-123-1',report,prepare_snapshot=prepare)
        self.assertEqual(events,['prepare','fingerprint','probe','fingerprint'])
        self.assertTrue(report.cleanup);self.assertEqual(original(fixture.db),fixture.before)

    def test_invalid_operation_output_is_fixed_and_never_echoes_argument(self):
        import contextlib,io,sys
        output=io.StringIO()
        with patch.object(sys,'argv',['repair','--operation','DO_NOT_PRINT_SECRET']),patch.object(repair.signal,'setitimer'),contextlib.redirect_stdout(output):
            self.assertEqual(repair.main(deploy),1)
        self.assertNotIn('DO_NOT_PRINT',output.getvalue())
        self.assertIn('INVALID_OPERATION',output.getvalue())
        self.assertIn('"operation": "inspect"',output.getvalue())


if __name__ == '__main__':
    unittest.main()
