import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

adapter = load('survey_deploy', ROOT / 'ops/deploy-survey-only.py')
core = load('preserving', ROOT / 'ops/deploy-preserving.py')
adapter.core = core
PINS = json.loads((ROOT / 'ops/survey-only-source-pins.json').read_bytes())
adapter.pins = PINS
SQL = PINS['schemaSql'].encode()
HASH = PINS['schemaSha256']


class Preservation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'existing.sqlite'
        with sqlite3.connect(self.path) as db:
            db.executescript('''
              CREATE TABLE owners(id INTEGER PRIMARY KEY, password TEXT, mfa BLOB);
              INSERT INTO owners VALUES(7,'unchanged-test-hash',x'000102');
              CREATE TABLE bookings(id TEXT PRIMARY KEY, value TEXT);
              INSERT INTO bookings(rowid,id,value) VALUES(91,'b1','unchanged booking');
              CREATE TABLE notification_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT);
              INSERT INTO notification_outbox(state) VALUES('held');
              CREATE TABLE no_rowid(a TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
              INSERT INTO no_rowid VALUES('x','same');
              CREATE INDEX booking_value ON bookings(value);
              CREATE VIEW visible_bookings AS SELECT id,value FROM bookings;
              PRAGMA user_version=3;
              PRAGMA application_id=7;
            ''')
        self.before = core.database_fingerprint(self.path)

    def old_state(self):
        with sqlite3.connect(self.path) as db:
            rows = [row for row in adapter.schema(db) if row[1] not in adapter.OBJECTS]
            return adapter.fingerprint(db, rows)

    def test_adds_exact_objects_and_preserves_all_original_schema_rows_and_metadata(self):
        self.assertEqual(adapter.add_research_schema(self.path, SQL, HASH), 'added')
        self.assertEqual(self.before, self.old_state())
        with sqlite3.connect(self.path) as db:
            names = {row[1] for row in adapter.schema(db)}
            self.assertTrue(adapter.OBJECTS <= names)
            self.assertNotIn('booking_references', names)
            self.assertNotIn('lease_token', {row[1] for row in db.execute('pragma table_info(notification_outbox)')})
            self.assertEqual(db.execute('select rowid from bookings').fetchall(), [(91,)])

    def test_no_initializer_on_missing_database(self):
        missing = self.path.parent / 'missing.sqlite'
        with self.assertRaises((ValueError, OSError)):
            adapter.add_research_schema(missing, SQL, HASH)
        self.assertFalse(missing.exists())

    def test_guard_failure_rolls_back_all_ddl(self):
        def drift():
            raise ValueError('synthetic source drift')
        with self.assertRaises(ValueError):
            adapter.add_research_schema(self.path, SQL, HASH, drift)
        self.assertEqual(core.database_fingerprint(self.path), self.before)

    def test_commit_guard_runs_inside_atomic_transaction(self):
        def while_locked():
            with sqlite3.connect(self.path, timeout=0.01) as other:
                self.assertEqual(other.execute("select name from sqlite_master where name='research_responses'").fetchall(), [])
                with self.assertRaises(sqlite3.OperationalError):
                    other.execute("insert into bookings values('blocked','must not commit')")
        adapter.add_research_schema(self.path, SQL, HASH, while_locked)
        self.assertEqual(self.before, self.old_state())

    def test_exact_already_applied_schema_preserves_new_responses(self):
        adapter.add_research_schema(self.path, SQL, HASH)
        with sqlite3.connect(self.path) as db:
            db.execute("insert into research_responses values('r','k','h','consumer','v','now','{}')")
            db.execute("insert into research_notification_outbox(response_id,state,attempts) values('r','sent',1)")
        before = core.database_fingerprint(self.path)
        self.assertEqual(adapter.add_research_schema(self.path, SQL, HASH), 'retained')
        self.assertEqual(core.database_fingerprint(self.path), before)

    def test_partial_schema_refuses_without_writes(self):
        with sqlite3.connect(self.path) as db:
            db.execute('create table research_responses(id text)')
        before = core.database_fingerprint(self.path)
        with self.assertRaises(ValueError):
            adapter.add_research_schema(self.path, SQL, HASH)
        self.assertEqual(core.database_fingerprint(self.path), before)

    def test_extra_research_trigger_refuses(self):
        adapter.add_research_schema(self.path, SQL, HASH)
        with sqlite3.connect(self.path) as db:
            db.execute("create trigger unexpected after insert on research_responses begin update owners set password='changed'; end")
        before = core.database_fingerprint(self.path)
        with self.assertRaises(ValueError):
            adapter.add_research_schema(self.path, SQL, HASH)
        self.assertEqual(core.database_fingerprint(self.path), before)

    def test_schema_hash_and_statement_count_fail_closed(self):
        with self.assertRaises(ValueError):
            adapter.add_research_schema(self.path, SQL + b' ', HASH)
        altered = SQL + b'CREATE TABLE unrelated(id);'
        with self.assertRaises(ValueError):
            adapter.add_research_schema(self.path, altered, hashlib.sha256(altered).hexdigest())
        self.assertEqual(core.database_fingerprint(self.path), self.before)

    def test_hidden_rowid_shadowing_refuses_rather_than_incomplete_proof(self):
        with sqlite3.connect(self.path) as db:
            db.execute('create table shadow(rowid, _rowid_, oid)')
        with self.assertRaises(ValueError):
            adapter.add_research_schema(self.path, SQL, HASH)
        with sqlite3.connect(self.path) as db:
            self.assertNotIn('research_responses', {row[1] for row in adapter.schema(db)})

    def test_code_rollback_retains_schema_and_new_response(self):
        old = self.path.parent / 'old'
        new = self.path.parent / 'new'
        old.mkdir(); new.mkdir()
        pointer = self.path.parent / 'current'
        pointer.symlink_to(old)
        calls = []
        first = True
        def service(action, unit):
            nonlocal first
            calls.append(action)
            if action == 'stop' and first:
                first = False
                adapter.add_research_schema(self.path, SQL, HASH)
        def validate(target):
            if target == new:
                with sqlite3.connect(self.path) as db:
                    db.execute("insert into research_responses values('retained','k','h','consumer','v','now','{}')")
                raise ValueError('synthetic post-switch failure')
        with self.assertRaises(ValueError):
            core.activate(pointer, new, service, validate)
        self.assertEqual(pointer.resolve(), old)
        self.assertEqual(calls, ['stop', 'start', 'stop', 'restart'])
        self.assertEqual(self.before, self.old_state())
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute('select id from research_responses').fetchall(), [('retained',)])


class Controls(unittest.TestCase):
    def test_flags_are_closed_by_default_and_true_is_rejected(self):
        adapter.closed({})
        adapter.closed({key: 'false' for key in adapter.FLAGS})
        for key in adapter.FLAGS:
            for bad in ('true', '1', '', 'False'):
                with self.assertRaises(ValueError):
                    adapter.closed({key: bad})

    def test_historical_preserving_source_not_modified(self):
        self.assertEqual(core.digest(ROOT / 'ops/deploy-preserving.py'), PINS['preservingSha256'])
        own = (ROOT / 'ops/deploy-survey-only.py').read_text()
        self.assertNotIn('core.main(', own)
        self.assertNotIn('core.verify_source_transition(', own)
        self.assertNotIn('core.LIVE_SOURCE_SHA256 =', own)
        self.assertNotIn('executescript(', own)

    def test_pin_contract_and_runtime_artifact_are_separate(self):
        self.assertEqual(PINS['schema'], 'bubblewash-survey-only/v1')
        self.assertEqual(PINS['baseSha'], '5dc997db0393e1cf88dde29859b7e1c4550ee4ee')
        self.assertRegex(PINS['runtimeTree'], '^[a-f0-9]{40}$')
        self.assertIn('scripts/send-synthetic-research-test.mjs', PINS['runtimeFiles'])
        self.assertNotIn('ops/deploy-survey-only.py', PINS['runtimeFiles'])
        self.assertEqual(hashlib.sha256(SQL).hexdigest(), HASH)

    def test_db_permissions_match_existing_operator_without_requiring_new_mode(self):
        import types
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'existing.sqlite'; path.write_bytes(b'synthetic'); path.chmod(0o644)
            owner = types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
            with mock.patch.object(adapter, 'safe_path', side_effect=lambda p, owner: p.stat()):
                adapter.database_identity(path, owner)
                path.chmod(0o664)
                with self.assertRaises(ValueError):
                    adapter.database_identity(path, owner)

    def test_failure_output_has_only_fixed_stage_and_no_exception_values(self):
        import contextlib
        import io
        output = io.StringIO()
        adapter.stage('migration')
        with mock.patch.object(adapter.signal, 'signal'), mock.patch.object(adapter, 'arguments'), \
             mock.patch.object(adapter, 'main', side_effect=ValueError('private-secret-test-only')), contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit):
                adapter.entry()
        self.assertEqual(json.loads(output.getvalue()), {'ok': False, 'status': 'review-required', 'stage': 'migration', 'automaticRetry': False})
        self.assertNotIn('private-secret', output.getvalue())

    def test_workflow_has_no_automatic_deployment_or_rerun(self):
        text = (ROOT / '.github/workflows/survey-only-deploy.yml').read_text()
        self.assertIn('workflow_dispatch:', text)
        self.assertNotIn('push:', text)
        self.assertIn("inputs.mode == 'deploy'", text)
        self.assertIn('needs: verify', text)
        self.assertIn('GITHUB_RUN_ATTEMPT', text)
        self.assertIn('runtimeTree', text)
        self.assertIn('runtimeFiles', text)
        self.assertNotIn('BUBBLEWASH_RESEARCH_RESEND_KEY:', text)

    def test_environment_matches_installer_two_parent_policy_and_inode_binding(self):
        import types
        with tempfile.TemporaryDirectory() as directory:
            outer = Path(directory)
            parent = outer / '.config' / 'bubblewash'
            parent.mkdir(parents=True)
            path = parent / 'env'
            raw = b'NODE_ENV=production\n'
            path.write_bytes(raw); path.chmod(0o600)
            owner = types.SimpleNamespace(pw_uid=os.getuid())
            digest = hashlib.sha256(raw).hexdigest()
            # The existing installer checks the two protected config parents,
            # not unrelated /tmp ancestry. This is deliberate, not a mode change.
            first = adapter.environment_snapshot(path, owner, digest)
            self.assertEqual(first[0], raw)
            new = parent / 'replacement'; new.write_bytes(raw); new.chmod(0o600)
            os.replace(new, path)
            self.assertNotEqual(first[1], adapter.environment_snapshot(path, owner, digest)[1])
            path.chmod(0o640)
            with self.assertRaises(ValueError):
                adapter.environment_snapshot(path, owner, digest)

    def test_environment_rejects_symlink_and_wrong_hash(self):
        import types
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory) / '.config' / 'bubblewash'; parent.mkdir(parents=True)
            source = parent / 'real'; source.write_bytes(b'x=y\n'); source.chmod(0o600)
            path = parent / 'env'; path.symlink_to(source)
            owner = types.SimpleNamespace(pw_uid=os.getuid())
            with self.assertRaises(OSError):
                adapter.environment_snapshot(path, owner, hashlib.sha256(source.read_bytes()).hexdigest())
            with self.assertRaises(ValueError):
                adapter.environment_snapshot(source, owner, '0' * 64)

class PrivilegeProtocol(unittest.TestCase):
    def test_groups_gid_uid_drop_precedes_operation_and_real_effective_ids_are_verified(self):
        import types
        owner = types.SimpleNamespace(pw_uid=1001, pw_gid=1002)
        order = []
        with mock.patch.object(adapter.resource, 'setrlimit'), \
             mock.patch.object(adapter.os, 'setgroups', side_effect=lambda groups: order.append(('groups', groups))), \
             mock.patch.object(adapter.os, 'setgid', side_effect=lambda gid: order.append(('gid', gid))), \
             mock.patch.object(adapter.os, 'setuid', side_effect=lambda uid: order.append(('uid', uid))), \
             mock.patch.object(adapter.os, 'getuid', return_value=1001), \
             mock.patch.object(adapter.os, 'geteuid', return_value=1001), \
             mock.patch.object(adapter.os, 'getgid', return_value=1002), \
             mock.patch.object(adapter.os, 'getegid', return_value=1002), \
             mock.patch.object(adapter.os, 'getgroups', return_value=[]):
            adapter.app_operation(owner, lambda: order.append(('database', None)))
        self.assertEqual(order, [('groups', []), ('gid', 1002), ('uid', 1001), ('database', None)])

    def protocol(self, status=0, result=b'OK', pending=False):
        import contextlib
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(mock.patch.object(adapter.os, 'pipe', return_value=(901, 902)))
        stack.enter_context(mock.patch.object(adapter.os, 'fork', return_value=12345))
        stack.enter_context(mock.patch.object(adapter.os, 'close'))
        waiter = stack.enter_context(mock.patch.object(adapter.os, 'waitpid', side_effect=[(0, 0), (12345, 9)] if pending else [(12345, status)]))
        stack.enter_context(mock.patch.object(adapter.os, 'read', return_value=result))
        killer = stack.enter_context(mock.patch.object(adapter.os, 'kill'))
        stack.enter_context(mock.patch.object(adapter.time, 'monotonic', side_effect=[0, 91] if pending else [0]))
        return waiter, killer

    def test_success_is_bounded_ack_without_killing_reaped_pid(self):
        waiter, killer = self.protocol()
        adapter.migrate_as_app(None, lambda: self.fail('must not execute in parent'))
        waiter.assert_called_once_with(12345, os.WNOHANG)
        killer.assert_not_called()

    def test_child_failure_is_not_retried(self):
        waiter, killer = self.protocol(status=256, result=b'')
        with self.assertRaises(ValueError):
            adapter.migrate_as_app(None, lambda: None)
        self.assertEqual(waiter.call_count, 1)
        killer.assert_not_called()

    def test_unknown_commit_eof_is_not_retried(self):
        waiter, killer = self.protocol(result=b'')
        with self.assertRaises(ValueError):
            adapter.migrate_as_app(None, lambda: None)
        self.assertEqual(waiter.call_count, 1)
        killer.assert_not_called()

    def test_timeout_kills_and_reaps_child_without_retry(self):
        waiter, killer = self.protocol(pending=True)
        with self.assertRaises(TimeoutError):
            adapter.migrate_as_app(None, lambda: None)
        killer.assert_called_once_with(12345, adapter.signal.SIGKILL)
        self.assertEqual(waiter.call_args_list, [mock.call(12345, os.WNOHANG), mock.call(12345, 0)])

    def test_migration_exception_restores_old_code_and_does_not_repeat_ddl(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); old = root / 'old'; new = root / 'new'; old.mkdir(); new.mkdir()
            pointer = root / 'current'; pointer.symlink_to(old)
            operation = mock.Mock()
            with mock.patch.object(core, 'ctl') as ctl, mock.patch.object(adapter, 'stopped'), \
                 mock.patch.object(adapter, 'migrate_as_app', side_effect=TimeoutError()) as migration:
                service = adapter.migration_service(None, operation, lambda: None, lambda: None)
                with self.assertRaises(TimeoutError):
                    core.activate(pointer, new, service, lambda target: self.assertEqual(target, old))
                migration.assert_called_once()
                operation.assert_not_called()
                self.assertEqual([call.args[0] for call in ctl.call_args_list], ['stop', 'stop', 'restart'])
            self.assertEqual(pointer.resolve(), old)


class Activation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.raw = (b'# preserve comments and unrelated bytes\n'
                    b'BUBBLEWASH_STAFF_AUTH_DISABLED=false\nBUBBLEWASH_BOOKINGS_DISABLED=true\n'
                    b'BUBBLEWASH_RESEARCH_RESEND_KEY=re_abcdefghijklmnopqrst\n'
                    b'BUBBLEWASH_RESEARCH_EMAIL_ENABLED=false\n')

    def test_only_two_research_flags_change(self):
        after = adapter.activation_bytes(self.raw)
        self.assertEqual(after, self.raw.replace(b'BUBBLEWASH_RESEARCH_EMAIL_ENABLED=false',
                         b'BUBBLEWASH_RESEARCH_EMAIL_ENABLED=true') + b'BUBBLEWASH_RESEARCH_OPEN=true\n')
        self.assertEqual(after.count(b'BUBBLEWASH_RESEARCH_EMAIL_ENABLED='), 1)
        self.assertIn(b'BUBBLEWASH_BOOKINGS_DISABLED=true', after)
        self.assertIn(b'BUBBLEWASH_STAFF_AUTH_DISABLED=false', after)

    def test_enabled_duplicate_missing_key_and_expired_window_refuse(self):
        cases = [self.raw.replace(b'EMAIL_ENABLED=false', b'EMAIL_ENABLED=true'),
                 self.raw + b'BUBBLEWASH_RESEARCH_EMAIL_ENABLED=false\n',
                 self.raw.replace(b'BUBBLEWASH_RESEARCH_RESEND_KEY=re_abcdefghijklmnopqrst\n', b''),
                 self.raw + b'BUBBLEWASH_RESEARCH_CLOSES_AT=2000-01-01T00:00:00Z\n']
        for raw in cases:
            with self.assertRaises(ValueError):
                adapter.activation_bytes(raw)

    def test_app_owned_atomic_replace_and_exact_config_rollback(self):
        import types
        parent = self.root / '.config' / 'bubblewash'; parent.mkdir(parents=True)
        path = parent / 'env'; path.write_bytes(self.raw); path.chmod(0o600)
        owner = types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        replacement = adapter.activation_bytes(self.raw)
        before = path.stat().st_ino
        guard = mock.Mock()
        adapter.replace_environment(path, owner, self.raw, replacement, guard)
        self.assertEqual(path.read_bytes(), replacement)
        self.assertNotEqual(path.stat().st_ino, before)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(guard.call_count, 2)
        adapter.replace_environment(path, owner, replacement, self.raw, lambda: None)
        self.assertEqual(path.read_bytes(), self.raw)
        self.assertEqual([p.name for p in parent.iterdir()], ['env'])

    def test_environment_drift_guard_prevents_replace_and_leaves_no_temporary(self):
        import types
        parent = self.root / '.config' / 'bubblewash'; parent.mkdir(parents=True)
        path = parent / 'env'; path.write_bytes(self.raw); path.chmod(0o600)
        owner = types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        def drift():
            raise ValueError('synthetic binding drift')
        with self.assertRaises(ValueError):
            adapter.replace_environment(path, owner, self.raw, adapter.activation_bytes(self.raw), drift)
        self.assertEqual(path.read_bytes(), self.raw)
        self.assertEqual([p.name for p in parent.iterdir()], ['env'])

    def synthetic_db(self):
        path = self.root / 'research.sqlite'
        sqlite3.connect(path).close()
        adapter.add_research_schema(path, SQL, HASH)
        payload = json.dumps({'adultEligible': True, 'instrument': 'consumer', 'reference': 'operator-test-v1',
                              'identity': {'email': 'synthetic-test@example.invalid'}})
        with sqlite3.connect(path) as db:
            db.execute('INSERT INTO research_responses VALUES(?,?,?,?,?,?,?)', ('r', '20b2f9aa-77dd-4c7a-8efe-b23f176c77f1',
                hashlib.sha256(payload.encode()).hexdigest(), 'consumer', 'v', 'now', payload))
            db.execute("INSERT INTO research_notification_outbox(response_id,state,attempts,recipient,provider_message_id,sent_at) VALUES('r','sent',1,'operator-test-only','synthetic-provider-id','now')")
        return path

    def test_marked_test_requires_recorded_accepted_single_attempt_and_no_writes(self):
        path = self.synthetic_db()
        before = core.database_fingerprint(path)
        adapter.marked_test_accepted(path, SQL, HASH)
        self.assertEqual(core.database_fingerprint(path), before)
        for column, value in [('state', 'failed'), ('attempts', 2), ('provider_message_id', None),
                              ('recipient', 'info@bubblewash.co'), ('last_error_kind', 'uncertain')]:
            with sqlite3.connect(path) as db:
                prior = db.execute('SELECT ' + column + ' FROM research_notification_outbox').fetchone()[0]
                db.execute('UPDATE research_notification_outbox SET ' + column + '=?', (value,))
            with self.assertRaises(ValueError):
                adapter.marked_test_accepted(path, SQL, HASH)
            with sqlite3.connect(path) as db:
                db.execute('UPDATE research_notification_outbox SET ' + column + '=?', (prior,))

    def test_missing_marked_test_blocks_activation(self):
        path = self.root / 'research.sqlite'; sqlite3.connect(path).close()
        adapter.add_research_schema(path, SQL, HASH)
        with self.assertRaises(ValueError):
            adapter.marked_test_accepted(path, SQL, HASH)

    def test_hosted_evidence_is_terminal_exact_first_attempt_and_runtime_bound(self):
        control = 'a' * 40; runtime = 'b' * 40
        run = {'head_sha': control, 'event': 'workflow_dispatch', 'path': '.github/workflows/survey-only-deploy.yml',
               'head_repository': {'full_name': 'bechirobob/bubble-wash'}, 'repository': {'full_name': 'bechirobob/bubble-wash'},
               'head_branch': 'main', 'status': 'completed', 'conclusion': 'success', 'run_attempt': 1,
               'display_title': 'Survey-only deploy ' + runtime}
        adapter.verify_hosted_run(run, control, runtime)
        for key, value in [('head_sha', 'c' * 40), ('event', 'pull_request'), ('path', 'other.yml'), ('head_branch', 'other'),
                           ('status', 'in_progress'), ('conclusion', 'failure'), ('run_attempt', 2),
                           ('display_title', 'Survey-only deploy ' + 'c' * 40), ('display_title', 'Survey-only activate ' + runtime)]:
            with self.assertRaises(ValueError):
                adapter.verify_hosted_run({**run, key: value}, control, runtime)
        for key in ('head_repository', 'repository'):
            with self.assertRaises(ValueError):
                adapter.verify_hosted_run({**run, key: {'full_name': 'other/repo'}}, control, runtime)

    def test_workflow_never_stages_or_extracts_as_root_or_repeats_browser_on_activate(self):
        text = (ROOT / '.github/workflows/survey-only-deploy.yml').read_text()
        self.assertIn('/usr/sbin/runuser -u ubuntu --', text)
        self.assertNotIn('chown -R', text)
        self.assertIn("inputs.mode != 'activate'", text)
        self.assertIn('--check-hosted-run', text)
        self.assertNotIn('config_sha256:', text)
        self.assertNotIn('database_path:', text)


class ActivationOrchestration(unittest.TestCase):
    def setup_activation(self):
        import contextlib
        import types
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        directory = stack.enter_context(tempfile.TemporaryDirectory())
        root = Path(directory); current = root / 'release'; current.mkdir()
        (current / 'db/proposed').mkdir(parents=True)
        (current / 'db/proposed/research-v1.sql').write_bytes(SQL)
        pointer = root / 'current'; pointer.symlink_to(current)
        runtime = root / 'runtime'; runtime.mkdir()
        sha = 'd' * 40
        (runtime / 'current-release').write_text(f'sha={sha}\npath={current}\n')
        parent = root / '.config' / 'bubblewash'; parent.mkdir(parents=True)
        env = parent / 'env'
        db = root / 'existing.sqlite'; db.write_bytes(b'synthetic unchanged DB bytes')
        status = root / 'status'; status.write_text('{}')
        archive = root / 'archive.enc'; archive.write_bytes(b'encrypted synthetic bytes')
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        receipt = root / 'receipt'; receipt.write_text(json.dumps({'filename': archive.name, 'sha256': digest, 'size': archive.stat().st_size}))
        raw = (f'NODE_ENV=production\nBUBBLEWASH_STAFF_AUTH_DISABLED=false\nBUBBLEWASH_BOOKINGS_DISABLED=true\n'
               f'BUBBLEWASH_DISABLE_DEMO_LOGIN=true\nBUBBLEWASH_DATABASE_PATH={db}\nBUBBLEWASH_BACKUP_STATUS_PATH={status}\n'
               f'BUBBLEWASH_BACKUP_OFFSITE_DIR={root}\nBUBBLEWASH_RESEARCH_RESEND_KEY=re_abcdefghijklmnopqrst\n'
               'BUBBLEWASH_RESEARCH_EMAIL_ENABLED=false\n').encode()
        env.write_bytes(raw); env.chmod(0o600)
        owner = types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        args = types.SimpleNamespace(sha=sha, backup_sha256=digest, receipt_run='1', store_sha='a'*40, store_id='1')
        for name, value in [('CURRENT', pointer), ('RUNTIME', runtime), ('ENV', env), ('RECEIPT', receipt)]:
            stack.enter_context(mock.patch.object(core, name, value))
        stack.enter_context(mock.patch.object(adapter.os, 'geteuid', return_value=0))
        stack.enter_context(mock.patch.object(adapter.pwd, 'getpwnam', return_value=owner))
        @contextlib.contextmanager
        def lock(*_):
            yield lambda: None
        stack.enter_context(mock.patch.object(core, 'deployment_lock', lock))
        stack.enter_context(mock.patch.object(core, 'source_manifest', return_value=PINS['candidateSource']))
        stack.enter_context(mock.patch.object(adapter, 'file_identity', return_value=('fixed-source',)))
        stack.enter_context(mock.patch.object(adapter, 'database_identity', return_value=('fixed-database',)))
        stack.enter_context(mock.patch.object(core, 'verify_receipt'))
        stack.enter_context(mock.patch.object(adapter, 'migrate_as_app', side_effect=lambda owner, operation: operation()))
        # The real descriptor/atomic helper is independently tested above. Here
        # capture the orchestration's exact compare-and-replace contract only.
        def replacement(path, owner, expected, new, guard):
            self.assertEqual(path.read_bytes(), expected)
            guard()
            path.write_bytes(new)
            guard()
        replace = stack.enter_context(mock.patch.object(adapter, 'replace_environment', side_effect=replacement))
        marked = stack.enter_context(mock.patch.object(adapter, 'marked_test_accepted'))
        ctl = stack.enter_context(mock.patch.object(core, 'ctl'))
        health = stack.enter_context(mock.patch.object(core, 'health'))
        flags = stack.enter_context(mock.patch.object(adapter, 'runtime_flags'))
        stack.enter_context(mock.patch.object(core, 'public_health'))
        return types.SimpleNamespace(args=args, env=env, raw=raw, db=db, replace=replace,
                                     marked=marked, ctl=ctl, health=health, flags=flags)

    def test_post_restart_health_failure_restores_exact_flags_without_database_restore(self):
        f = self.setup_activation()
        original_db = f.db.read_bytes()
        f.health.side_effect = [None, ValueError('synthetic restart health failure'), None]
        with self.assertRaises(ValueError):
            adapter.activate_flags(f.args)
        self.assertEqual(f.env.read_bytes(), f.raw)
        self.assertEqual(f.db.read_bytes(), original_db)
        self.assertEqual(f.replace.call_count, 2)
        self.assertEqual(f.replace.call_args_list[1].args[2:4], (adapter.activation_bytes(f.raw), f.raw))
        self.assertEqual([call.args for call in f.ctl.call_args_list], [('restart', core.UNIT), ('restart', core.UNIT)])
        self.assertEqual(f.flags.call_args_list[-1].args[2], False)

    def test_rejected_marked_test_causes_no_config_write_or_restart(self):
        f = self.setup_activation()
        f.marked.side_effect = ValueError('synthetic missing accepted test')
        with self.assertRaises(ValueError):
            adapter.activate_flags(f.args)
        self.assertEqual(f.env.read_bytes(), f.raw)
        f.replace.assert_not_called()
        f.ctl.assert_not_called()

    def test_unknown_configuration_drift_refuses_overwrite(self):
        f = self.setup_activation()
        unknown = f.raw + b'UNRELATED_DRIFT=must-not-overwrite\n'
        def drift(*_):
            f.env.write_bytes(unknown)
            raise ValueError('synthetic unknown config')
        f.marked.side_effect = drift
        with self.assertRaises(ValueError):
            adapter.activate_flags(f.args)
        self.assertEqual(f.env.read_bytes(), unknown)
        f.replace.assert_not_called()
        f.ctl.assert_not_called()


class ReadOnlyInspection(unittest.TestCase):
    def setUp(self):
        import contextlib
        import types
        self.stack = contextlib.ExitStack(); self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix='inspect-test-', dir=ROOT)))
        self.home = self.root / 'home'; self.home.mkdir()
        self.releases = self.home / 'bubblewash-releases'; self.releases.mkdir()
        self.old = self.releases / 'old-baseline'; self.old.mkdir()
        self.sha = 'd' * 40
        self.candidate = self.releases / ('20261024T014545Z-' + self.sha[:12]); self.candidate.mkdir()
        for release in (self.old, self.candidate):
            for name in (*core.CRITICAL_FILES, 'package.json', 'package-lock.json', 'next.config.mjs', 'tsconfig.json'):
                p = release / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text('synthetic identical source\n')
        def file_map(release):
            return {p.relative_to(release).as_posix(): core.digest(p) for p in sorted(release.rglob('*')) if p.is_file()}
        self.pins = {**PINS, 'baselineFiles': file_map(self.old), 'runtimeFiles': file_map(self.candidate),
                     'baselineSource': core.source_manifest(self.old), 'candidateSource': core.source_manifest(self.candidate)}
        (self.old / '.release-sha').write_text(PINS['baseSha'] + '\n')
        (self.candidate / '.release-sha').write_text(self.sha + '\n')
        self.current = self.home / 'current'; self.current.symlink_to(self.old)
        self.runtime = self.home / 'runtime'; self.runtime.mkdir()
        self.marker = self.runtime / 'current-release'; self.marker.write_text(f"sha={PINS['baseSha']}\npath={self.old}\n")
        self.db = self.root / 'existing.sqlite'
        with sqlite3.connect(self.db) as db: db.execute('create table existing(id integer primary key, value text)')
        self.db.chmod(0o600)
        env_parent = self.home / '.config' / 'bubblewash'; env_parent.mkdir(parents=True)
        self.env = env_parent / 'env'
        self.env.write_text(f'BUBBLEWASH_DATABASE_PATH={self.db}\nBUBBLEWASH_RESEARCH_RESEND_KEY=private-sentinel-not-for-output\n')
        self.env.chmod(0o600)
        self.receipt = self.root / 'receipt.json'
        self.receipt.write_text(json.dumps({'sha256': 'a'*64, 'runId': '4', 'storageSha': 'b'*40, 'storageRepositoryId': 7}))
        self.owner = types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        self.args = types.SimpleNamespace(mode='inspect', candidate=str(self.candidate), sha=self.sha,
            expected_live=PINS['baseSha'], backup_sha256='a'*64, receipt_run='4', store_sha='b'*40, store_id='7')
        for name, value in [('HOME', self.home), ('CURRENT', self.current), ('RUNTIME', self.runtime), ('ENV', self.env), ('RECEIPT', self.receipt)]:
            self.stack.enter_context(mock.patch.object(core, name, value))
        self.stack.enter_context(mock.patch.object(adapter, 'pins', self.pins))
        self.stack.enter_context(mock.patch.object(adapter.os, 'geteuid', return_value=0))
        self.stack.enter_context(mock.patch.object(adapter.pwd, 'getpwnam', return_value=self.owner))
        self.locked = False
        @contextlib.contextmanager
        def lock(*_):
            self.locked = True
            try: yield lambda: self.assertTrue(self.locked)
            finally: self.locked = False
        self.stack.enter_context(mock.patch.object(core, 'deployment_lock', lock))
        def app(owner, operation):
            self.assertTrue(self.locked)
            operation()
        self.drop = self.stack.enter_context(mock.patch.object(adapter, 'app_operation', side_effect=app))
        self.forbidden = []
        for module, names in [(core, ('command', 'ctl', 'activate', 'rehearse')),
                              (adapter, ('migrate_as_app', 'add_research_schema', 'activate_flags', 'marked_test_accepted'))]:
            for name in names:
                self.forbidden.append(self.stack.enter_context(mock.patch.object(module, name, side_effect=AssertionError('mutation route reached'))))

    def run_inspection(self):
        import contextlib, io
        output = io.StringIO()
        with contextlib.redirect_stdout(output): result = adapter.main(self.args)
        self.assertEqual(json.loads(output.getvalue()), result)
        for operation in self.forbidden: operation.assert_not_called()
        self.assertNotIn('private-sentinel', output.getvalue())
        self.assertNotIn(str(self.root), output.getvalue())
        self.drop.assert_called_once()
        return result

    def test_full_inspect_never_reaches_build_service_ddl_or_row_read(self):
        before = self.db.read_bytes(); statements = []; real_connect = sqlite3.connect
        def connect(target, *args, **kwargs):
            result = real_connect(target, *args, **kwargs)
            if isinstance(target, str) and target.startswith('file:'):
                self.assertTrue(target.endswith('?mode=ro')); self.assertTrue(kwargs['uri'])
                result.set_trace_callback(statements.append)
            return result
        with mock.patch.object(adapter.sqlite3, 'connect', side_effect=connect):
            result = self.run_inspection()
        self.assertTrue(result['ok']); self.assertEqual(result['researchSchema'], 'absent')
        self.assertEqual(result['binding'], {'pointerClaim': 'baseline', 'markerClaim': 'baseline', 'markerPathMatchesPointer': True})
        self.assertEqual(result['receipt'], 'matches-input-pins')
        self.assertEqual(before, self.db.read_bytes())
        self.assertEqual(statements, ['PRAGMA query_only=ON', 'BEGIN', 'SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name'])

    def test_actual_core_parser_selects_only_database_path_bytes(self):
        real_parse = core.parse; seen = []
        def parse(raw): seen.append(raw); return real_parse(raw)
        with mock.patch.object(core, 'parse', side_effect=parse):
            path, digest, identity = adapter.inspect_database_path(self.owner)
        self.assertEqual(path, self.db)
        self.assertEqual(seen, [f'BUBBLEWASH_DATABASE_PATH={self.db}'.encode()])
        self.assertEqual(len(digest), 64); self.assertTrue(identity)

    def test_source_failure_still_reports_pointer_schema_and_receipt(self):
        self.candidate.chmod(0o770)
        result = self.run_inspection()
        self.assertFalse(result['ok']); self.assertEqual(result['source']['candidate'], 'refused')
        failure = next(x for x in result['failures'] if x['scope'] == 'candidate')
        self.assertEqual(failure['guard'], 'ANCESTOR_MODE'); self.assertIsInstance(failure['ancestorDepth'], int)
        self.assertEqual(result['researchSchema'], 'absent'); self.assertEqual(result['receipt'], 'matches-input-pins')
        self.assertEqual(result['binding']['pointerClaim'], 'baseline')

    def test_file_hash_failure_has_fixed_map_index_not_filename(self):
        (self.candidate / 'package.json').write_text('changed synthetic bytes')
        result = self.run_inspection()
        failure = next(x for x in result['failures'] if x['guard'] == 'FILE_HASH')
        self.assertEqual(failure['scope'], 'candidate'); self.assertIsInstance(failure['fileIndex'], int)
        self.assertNotIn('package.json', json.dumps(result))

    def test_extra_source_file_reports_manifest_mismatch(self):
        (self.candidate / 'src/extra.ts').write_text('unexpected source')
        result = self.run_inspection()
        self.assertIn('SOURCE_MANIFEST_MISMATCH', [x['guard'] for x in result['failures']])

    def test_candidate_marker_and_receipt_pin_fail_independently(self):
        (self.candidate / '.release-sha').write_text('e' * 40)
        self.args.backup_sha256 = 'c' * 64
        result = self.run_inspection(); guards = [x['guard'] for x in result['failures']]
        self.assertIn('CANDIDATE_MARKER', guards); self.assertIn('RECEIPT_PIN', guards)
        self.assertEqual(result['researchSchema'], 'absent')

    def test_current_candidate_and_complete_schema_are_observed_without_old_source_assumption(self):
        self.current.unlink(); self.current.symlink_to(self.candidate)
        self.marker.write_text(f'sha={self.sha}\npath={self.candidate}\n')
        with sqlite3.connect(self.db) as db: db.executescript(SQL.decode())
        result = self.run_inspection()
        self.assertEqual(result['binding']['pointerClaim'], 'candidate')
        self.assertEqual(result['source']['baseline'], 'not-current')
        self.assertEqual(result['researchSchema'], 'complete')

    def test_partial_schema_is_reported_without_repair(self):
        with sqlite3.connect(self.db) as db: db.execute('create table research_responses(id text)')
        before = self.db.read_bytes(); result = self.run_inspection()
        self.assertEqual(result['researchSchema'], 'partial'); self.assertEqual(before, self.db.read_bytes())

    def test_missing_wal_sidecars_refuse_before_sqlite_connection(self):
        with sqlite3.connect(self.db) as db: db.execute('pragma journal_mode=WAL')
        self.assertFalse(Path(str(self.db) + '-wal').exists())
        with mock.patch.object(adapter.sqlite3, 'connect') as connect:
            with self.assertRaises(adapter.InspectRefusal) as raised: adapter.inspect_schema(self.db, self.owner)
            self.assertEqual(raised.exception.result['guard'], 'DATABASE_WAL_UNAVAILABLE')
            connect.assert_not_called()
        self.assertFalse(Path(str(self.db) + '-wal').exists()); self.assertFalse(Path(str(self.db) + '-shm').exists())

    def test_existing_wal_reads_committed_schema_without_writing_wal(self):
        writer = sqlite3.connect(self.db)
        try:
            writer.execute('pragma journal_mode=WAL'); writer.executescript(SQL.decode()); writer.commit()
            wal = Path(str(self.db) + '-wal'); before = wal.read_bytes(); main = self.db.read_bytes()
            self.assertEqual(adapter.inspect_schema(self.db, self.owner), 'complete')
            self.assertEqual(wal.read_bytes(), before); self.assertEqual(self.db.read_bytes(), main)
        finally: writer.close()

    def test_inspect_workflow_is_isolated_from_staging_build_and_activation(self):
        text = (ROOT / '.github/workflows/survey-only-deploy.yml').read_text()
        self.assertIn("inputs.mode != 'inspect'", text)
        blocks = text.split('      - name:')
        for block in blocks:
            if any(term in block for term in ('git -C runtime-artifact archive', '--mode activate', "--candidate '$RELEASE_DIR'")):
                self.assertTrue("if: inputs.mode == 'deploy'" in block or "if: inputs.mode == 'activate'" in block)
        inspect_step = next(block for block in blocks if '--mode inspect' in block)
        self.assertIn("if: inputs.mode == 'inspect'", inspect_step)
        self.assertIn("--candidate '$STAGED_CANDIDATE'", inspect_step)
        self.assertLess(text.index('Test exact read-only inspection controls'), text.index('Connect through existing approved production tailnet'))

    def test_candidate_directory_symlink_refuses_before_marker_read(self):
        outside = self.root / 'outside'; outside.mkdir(); (outside / '.release-sha').write_text(self.sha)
        import shutil
        shutil.rmtree(self.candidate); self.candidate.symlink_to(outside, target_is_directory=True)
        real_read = adapter.inspect_read
        def read(path, *args, **kwargs):
            self.assertNotEqual(path, self.candidate / '.release-sha')
            return real_read(path, *args, **kwargs)
        with mock.patch.object(adapter, 'inspect_read', side_effect=read): result = self.run_inspection()
        self.assertIn('CANDIDATE_CANONICAL', [x['guard'] for x in result['failures']])

    def test_metadata_read_does_not_mistake_its_own_atime_update_for_mutation(self):
        path = self.root / 'metadata'; path.write_bytes(b'fixed public metadata')
        os.utime(path, (1, path.stat().st_mtime))
        self.assertEqual(adapter.inspect_read(path, self.owner, 'current'), b'fixed public metadata')

    def test_metadata_read_rejects_size_and_inode_drift(self):
        import types
        path = self.root / 'metadata'; path.write_bytes(b'fixed public metadata')
        before = path.stat()
        fields = (*adapter.IDENTITY, 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        for changed in ('st_size', 'st_ino'):
            values = {key: getattr(before, key) for key in fields}; values[changed] += 1
            after = types.SimpleNamespace(**values)
            with mock.patch.object(adapter.os, 'fstat', side_effect=[before, after]):
                with self.assertRaises(adapter.InspectRefusal) as failure: adapter.inspect_read(path, self.owner, 'current')
            self.assertEqual(failure.exception.result['guard'], 'METADATA_CHANGED')

    def test_unknown_current_release_is_explicitly_refused(self):
        (self.old / '.release-sha').write_text('e' * 40)
        result = self.run_inspection()
        self.assertEqual(result['binding']['pointerClaim'], 'other')
        self.assertIn('CURRENT_RELEASE_IDENTITY', [x['guard'] for x in result['failures']])

    def test_metadata_bound_and_leaf_symlink_refuse_before_content_read(self):
        large = self.root / 'large'; large.write_bytes(b'x' * 129)
        with self.assertRaises(adapter.InspectRefusal) as failure: adapter.inspect_read(large, self.owner, 'candidate', 128)
        self.assertEqual(failure.exception.result['guard'], 'METADATA_BOUND')
        link = self.root / 'link'; link.symlink_to(large)
        with self.assertRaises(OSError): adapter.inspect_read(link, self.owner, 'candidate')


class BaselineNormalization(unittest.TestCase):
    setUp = ReadOnlyInspection.setUp

    def prepare(self, apply=True):
        self.args.mode = 'normalize-baseline'
        self.args.apply_normalization = apply
        directories = {str(parent) for name in self.pins['baselineFiles'] for parent in Path(name).parents if str(parent) != '.'}
        self.stack.enter_context(mock.patch.object(adapter, 'NORMALIZE_COUNTS', (len(self.pins['baselineFiles']), len(directories))))
        self.file = self.old / 'package.json'; self.file.chmod(0o666)
        self.directory = self.old / 'src'; self.directory.chmod(0o777)
        self.extra = self.old / 'untracked-private'; self.extra.write_text('never read or normalize this'); self.extra.chmod(0o666)
        self.before = {name: (core.digest(self.old / name), (self.old / name).stat().st_uid, (self.old / name).stat().st_gid)
                       for name in self.pins['baselineFiles']}
        for name in ('environment_snapshot', 'inspect_schema'):
            self.forbidden.append(self.stack.enter_context(mock.patch.object(adapter, name, side_effect=AssertionError('private read forbidden'))))
        self.forbidden.append(self.stack.enter_context(mock.patch.object(adapter.sqlite3, 'connect', side_effect=AssertionError('database forbidden'))))

    def run_normalization(self):
        import contextlib, io
        output = io.StringIO()
        with contextlib.redirect_stdout(output): result = adapter.main(self.args)
        lines = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(lines[-1], result)
        self.assertNotIn(str(self.root), output.getvalue())
        self.assertNotIn('private-sentinel', output.getvalue())
        for operation in self.forbidden: operation.assert_not_called()
        self.drop.assert_called_once()
        return result, lines

    def test_validation_reports_all_modes_before_any_opt_in_change(self):
        self.prepare(False)
        with mock.patch.object(adapter.os, 'fchmod') as chmod: result, lines = self.run_normalization()
        chmod.assert_not_called()
        self.assertTrue(result['ok']); self.assertTrue(result['prevalidated'])
        self.assertEqual(result['status'], 'validated-no-change'); self.assertEqual(result['needsChange'], 2)
        self.assertEqual(lines[0]['phase'], 'prevalidated')
        self.assertEqual(result['observedModes']['files']['0666'], 1)
        self.assertEqual(result['observedModes']['directories']['0777'], 1)
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o666)

    def test_only_pinned_descriptors_lose022_and_preserve_bytes_owner_and_other_bits(self):
        self.prepare()
        root_mode = self.old.stat().st_mode
        result, lines = self.run_normalization()
        self.assertTrue(result['ok']); self.assertEqual(result['changed'], 2)
        self.assertEqual(result['status'], 'normalized'); self.assertFalse(result['automaticRetry'])
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o644)
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.old.stat().st_mode, root_mode)
        self.assertEqual(self.extra.stat().st_mode & 0o777, 0o666)
        self.assertEqual(self.before, {name: (core.digest(self.old / name), (self.old / name).stat().st_uid, (self.old / name).stat().st_gid)
                                      for name in self.pins['baselineFiles']})
        self.assertEqual(lines[0]['phase'], 'prevalidated')
        self.assertEqual(self.current.resolve(), self.old)

    def assert_zero_change(self):
        with mock.patch.object(adapter.os, 'fchmod') as chmod: result, lines = self.run_normalization()
        chmod.assert_not_called(); self.assertFalse(result['ok'])
        self.assertEqual(result['attemptedChanges'], 0); self.assertEqual(result['changed'], 0)
        self.assertEqual(result['status'], 'refused-no-change')
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o777)
        self.assertFalse(any(line.get('phase') == 'prevalidated' for line in lines))
        return result

    def test_all_hashes_validated_before_any_chmod(self):
        self.prepare(); (self.old / sorted(self.pins['baselineFiles'])[-1]).write_text('changed last file')
        self.assertEqual(self.assert_zero_change()['guard'], 'FILE_HASH')

    def test_full_manifest_is_verified_independently_of_permission_bits(self):
        self.prepare(); self.pins['baselineSource'] = {**self.pins['baselineSource'], 'src': 'f'*64}
        self.assertEqual(self.assert_zero_change()['guard'], 'SOURCE_MANIFEST_MISMATCH')

    def test_critical_byte_mismatch_refuses_before_permissions(self):
        self.prepare(); name = core.CRITICAL_FILES[0]
        (self.candidate / name).write_text('different critical bytes')
        self.pins['runtimeFiles'][name] = core.digest(self.candidate / name)
        self.pins['candidateSource'] = core.source_manifest(self.candidate)
        self.assertEqual(self.assert_zero_change()['guard'], 'CRITICAL_BYTES')

    def test_untracked_source_refuses_without_opening_or_traversing_it(self):
        self.prepare(); extra = self.old / 'src' / 'unknown'; extra.mkdir(); (extra / 'private').write_text('must never open')
        real_open = os.open
        def guarded(path, *args, **kwargs):
            self.assertNotIn(str(path), ('unknown', 'private'))
            return real_open(path, *args, **kwargs)
        with mock.patch.object(adapter.os, 'open', side_effect=guarded):
            self.assertEqual(self.assert_zero_change()['guard'], 'SOURCE_MANIFEST_MISMATCH')

    def test_symlink_file_refuses_before_read_and_no_chmod(self):
        self.prepare(); self.file.unlink(); self.file.symlink_to(self.extra)
        self.assert_zero_change()

    def test_hard_link_file_refuses(self):
        self.prepare(); os.link(self.file, self.old / 'extra-link')
        self.assertEqual(self.assert_zero_change()['guard'], 'NORMALIZE_TYPE_LINK')

    def test_special_mode_refuses_before_fchmod_can_clear_unrelated_bits(self):
        self.prepare(); self.file.chmod(0o4666)
        self.assertEqual(self.assert_zero_change()['guard'], 'NORMALIZE_METADATA')

    def test_acl_or_unknown_extended_metadata_refuses(self):
        self.prepare()
        with mock.patch.object(adapter.os, 'listxattr', return_value=['system.posix_acl_access']):
            self.assertEqual(self.assert_zero_change()['guard'], 'NORMALIZE_METADATA')

    def test_owner_mismatch_refuses_before_mutation(self):
        import types
        self.prepare(); real_fstat = os.fstat; inode = self.file.stat().st_ino
        def changed(fd):
            value = real_fstat(fd)
            if value.st_ino != inode: return value
            fields = (*adapter.IDENTITY, 'st_size', 'st_mtime_ns', 'st_ctime_ns')
            return types.SimpleNamespace(**{key: value.st_uid + 12345 if key == 'st_uid' else getattr(value, key) for key in fields})
        with mock.patch.object(adapter.os, 'fstat', side_effect=changed):
            self.assertEqual(self.assert_zero_change()['guard'], 'NORMALIZE_OWNER')

    def test_current_pointer_drift_refuses_before_any_chmod(self):
        self.prepare(); original = adapter.baseline_binding; calls = 0
        def changed(*args):
            nonlocal calls
            calls += 1
            current, marker = original(*args)
            return current, marker if calls == 1 else marker + b'changed'
        with mock.patch.object(adapter, 'baseline_binding', side_effect=changed):
            self.assertEqual(self.assert_zero_change()['guard'], 'CURRENT_CHANGED')

    def test_named_file_replacement_after_open_refuses(self):
        self.prepare(); real_read = os.read; inode = self.file.stat().st_ino; replaced = False
        def changed(fd, size):
            nonlocal replaced
            data = real_read(fd, size)
            if os.fstat(fd).st_ino == inode and not replaced:
                replaced = True
                replacement = self.old / 'replacement'; replacement.write_bytes(self.file.read_bytes())
                os.replace(replacement, self.file)
            return data
        with mock.patch.object(adapter.os, 'read', side_effect=changed):
            self.assertEqual(self.assert_zero_change()['guard'], 'NORMALIZE_IDENTITY_CHANGED')

    def test_renamed_ancestor_refuses_before_any_permission_change(self):
        self.prepare(); original = adapter.baseline_binding; calls = 0
        def replaced(*args):
            nonlocal calls
            result = original(*args); calls += 1
            if calls == 3:
                old = self.old / 'src'; old.rename(self.old / 'renamed-src'); old.mkdir()
            return result
        with mock.patch.object(adapter, 'baseline_binding', side_effect=replaced):
            with mock.patch.object(adapter.os, 'fchmod') as chmod: result, _ = self.run_normalization()
        chmod.assert_not_called(); self.assertFalse(result['ok'])
        self.assertEqual(result['attemptedChanges'], 0)
        self.assertIn(result['guard'], ('NORMALIZE_ROOT_CHANGED', 'NORMALIZE_IDENTITY_CHANGED'))

    def test_no_staged_candidate_is_required_or_read_for_baseline_normalization(self):
        self.prepare(); self.args.candidate = None
        import shutil
        shutil.rmtree(self.candidate)
        result, _ = self.run_normalization()
        self.assertTrue(result['ok']); self.assertEqual(result['changed'], 2)

    def test_root_and_external_ancestors_are_never_chmod_targets(self):
        self.prepare(); real_chmod = os.fchmod; root_inode = self.old.stat().st_ino
        external_inodes = {path.stat().st_ino for path in self.old.parents}
        def target(fd, mode):
            self.assertNotEqual(os.fstat(fd).st_ino, root_inode)
            self.assertNotIn(os.fstat(fd).st_ino, external_inodes)
            return real_chmod(fd, mode)
        with mock.patch.object(adapter.os, 'fchmod', side_effect=target): result, _ = self.run_normalization()
        self.assertTrue(result['ok'])

    def test_partial_failure_counts_attempts_never_retries_or_restores_write_bits(self):
        self.prepare(); real_chmod = os.fchmod; calls = []
        def fail_second(fd, mode):
            calls.append(mode)
            if len(calls) == 2: raise OSError('private exception must not be printed')
            return real_chmod(fd, mode)
        with mock.patch.object(adapter.os, 'fchmod', side_effect=fail_second): result, _ = self.run_normalization()
        self.assertFalse(result['ok']); self.assertEqual(result['status'], 'partial-or-uncertain')
        self.assertEqual(result['changed'], 1); self.assertEqual(result['attemptedChanges'], 2)
        self.assertEqual(calls, [0o755, 0o644])
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o666)

    def test_post_chmod_mismatch_is_uncertain_not_success(self):
        self.prepare()
        with mock.patch.object(adapter.os, 'fchmod'): result, _ = self.run_normalization()
        self.assertFalse(result['ok']); self.assertEqual(result['status'], 'partial-or-uncertain')
        self.assertEqual(result['changed'], 0); self.assertEqual(result['attemptedChanges'], 1)
        self.assertEqual(result['guard'], 'NORMALIZE_POST_CHANGE')

    def test_full_scope_is_fixed_and_rejects_missing_pin(self):
        self.prepare(); self.pins['baselineFiles'].pop('package.json')
        self.assertEqual(self.assert_zero_change()['guard'], 'NORMALIZE_SCOPE')

    def test_normalization_workflow_has_explicit_opt_in_and_no_deploy_chaining(self):
        text = (ROOT / '.github/workflows/survey-only-deploy.yml').read_text()
        self.assertIn("inputs.mode != 'normalize-baseline'", text)
        self.assertIn('apply_normalization:', text)
        self.assertIn("if [[ \"$APPLY_NORMALIZATION\" == 'true' ]]; then apply='--apply-normalization'; fi", text)
        step = next(block for block in text.split('      - name:') if '--mode normalize-baseline' in block)
        self.assertIn("if: inputs.mode == 'normalize-baseline'", step)
        self.assertNotIn('chmod -R', step); self.assertNotIn('systemctl', step)
        for block in text.split('      - name:'):
            if any(term in block for term in ('git -C runtime-artifact archive', '--mode activate', "--candidate '$RELEASE_DIR'")):
                self.assertTrue("if: inputs.mode == 'deploy'" in block or "if: inputs.mode == 'activate'" in block)


if __name__ == '__main__':
    unittest.main()
