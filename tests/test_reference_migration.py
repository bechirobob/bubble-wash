"""Local SQLite/real-CLI and frozen-controller tests; all host callbacks are synthetic."""
import json
import multiprocessing
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
ADAPTER = ROOT / 'ops/integration-release'
sys.path.insert(0, str(ADAPTER))
import host_adapter as adapter
import contracts

sys.path.insert(0, str(ADAPTER / 'vendor/bubblewash-durable-controller'))
import test_controller as frozen

LABELS = 'scripts/migrate-booking-references.mjs'
OUTBOX = 'scripts/migrate-notification-outbox.mjs'
LABEL_RESULT = {'ok': True, 'migration': 'permanent-booking-vendor-labels-v1', 'historicalBackfill': False}
OUTBOX_RESULT = {'ok': True, 'migration': 'notification-outbox-exact-additive-v1'}


class CallbackTests(unittest.TestCase):
    def host(self, node):
        host = object.__new__(adapter.Host)
        host.plan = {'candidate': '/synthetic/candidate'}
        host.node = node
        return host

    def test_exact_label_first_order_and_same_database(self):
        calls = []
        def node(target, args, database):
            calls.append((target, args, database))
            return json.dumps(LABEL_RESULT if args[0] == LABELS else OUTBOX_RESULT)
        database = Path('/synthetic/existing.sqlite')
        self.assertTrue(self.host(node).migrate(database))
        self.assertEqual(calls, [(Path('/synthetic/candidate'), [name, '--database', str(database)], database)
                                 for name in (LABELS, OUTBOX)])

    def test_label_exception_or_unconfirmed_result_never_calls_outbox(self):
        for response in ('', '{}', 'null', json.dumps(OUTBOX_RESULT),
                         json.dumps({**LABEL_RESULT, 'historicalBackfill': True}),
                         json.dumps({**LABEL_RESULT, 'extra': 'unreviewed'})):
            calls = []
            def node(_target, args, _database):
                calls.append(args[0])
                return response
            with self.subTest(response=response), self.assertRaises(ValueError):
                self.host(node).migrate(Path('/synthetic/db'))
            self.assertEqual(calls, [LABELS])
        calls = []
        def failed(_target, args, _database):
            calls.append(args[0])
            raise OSError('synthetic command failure')
        with self.assertRaises(OSError): self.host(failed).migrate(Path('/synthetic/db'))
        self.assertEqual(calls, [LABELS])

    def test_outbox_uncertainty_never_reports_success(self):
        calls = []
        def node(_target, args, _database):
            calls.append(args[0])
            return json.dumps(LABEL_RESULT if args[0] == LABELS else {'ok': False})
        with self.assertRaises(ValueError): self.host(node).migrate(Path('/synthetic/db'))
        self.assertEqual(calls, [LABELS, OUTBOX])

    def test_acknowledgements_reject_duplicate_keys_and_wrong_types(self):
        for stage, expected in ((LABELS, LABEL_RESULT), (OUTBOX, OUTBOX_RESULT)):
            malformed = [json.dumps({**expected, 'ok': value}) for value in (1, 1.0, 'true', [], None)]
            valid = json.dumps(expected)
            malformed += ['{"ok":false,' + valid[1:], '{"ok":true,' + valid[1:],
                          json.dumps({**expected, 'extra': False})]
            if stage == LABELS:
                malformed += [json.dumps({**expected, 'historicalBackfill': value}) for value in (0, 0.0, 'false', None)]
                malformed.append('{"historicalBackfill":true,' + valid[1:])
            for response in malformed:
                calls = []
                def node(_target, args, _database):
                    calls.append(args[0])
                    return response if args[0] == stage else json.dumps(LABEL_RESULT)
                with self.subTest(stage=stage, response=response), self.assertRaises(ValueError):
                    self.host(node).migrate(Path('/synthetic/db'))
                self.assertEqual(calls, [LABELS] if stage == LABELS else [LABELS, OUTBOX])


class RealMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Explicit local source roots, not host paths or unreviewed default commits.
        cls.candidate = Path(os.environ['BW_TEST_CANDIDATE']).resolve(strict=True)
        cls.fallback = Path(os.environ['BW_TEST_FALLBACK']).resolve(strict=True)
        cls.node_binary = str(Path(os.environ['BW_TEST_NODE']).resolve(strict=True))
        cls.template_dir = tempfile.TemporaryDirectory(prefix='bw-reference-template-')
        cls.template = Path(cls.template_dir.name) / 'synthetic.sqlite'
        code = """
import { operationalDatabase } from './src/lib/operational-store.ts';
import { initializeStaffAccountsSchema } from './src/lib/staff-accounts.ts';
const db = operationalDatabase(); initializeStaffAccountsSchema(db);
db.exec("CREATE TABLE staff_owner_capabilities (email TEXT PRIMARY KEY COLLATE NOCASE REFERENCES staff_accounts(email), all_staff_access INTEGER NOT NULL CHECK (all_staff_access = 1))");
db.prepare("INSERT INTO staff_accounts VALUES ('owner@example.invalid','Owner','admin','','preserved-hash','preserved-version','active','','','time')").run();
db.prepare("INSERT INTO staff_owner_capabilities VALUES ('owner@example.invalid',1)").run();
db.prepare("INSERT INTO admin_mfa_settings VALUES ('owner@example.invalid','preserved-ciphertext','enrolled',NULL,NULL,'time','time')").run();
db.prepare("INSERT INTO submissions VALUES ('legacy','time','synthetic',?)").run(JSON.stringify({submissionType:'pickup-booking',email:'synthetic@example.invalid'}));
db.prepare("INSERT INTO submissions VALUES ('payment','time','synthetic',?)").run(JSON.stringify({submissionType:'checkout-request',orderId:'legacy',paymentReference:'BW-PAY-preserved'}));
db.prepare("INSERT INTO booking_requests VALUES ('legacy-request','preserved-hash','legacy','time')").run();
for (const status of ['pending','sent','skipped']) db.prepare("INSERT INTO notification_outbox(id,dedupe_key,channel,target,payload,status,attempts,next_attempt_at,provider_id,created_at,updated_at) VALUES (?,?,'email','customer','{}',?,1,'time','preserved-provider','time','time')").run(status,status,status);
db.exec('DROP TABLE booking_references; DROP TABLE vendor_codes');
db.close();
"""
        cls.invoke(cls.candidate, ['--experimental-loader=./tests/alias-loader.mjs', '--input-type=module', '-e', code], cls.template)
        cls.template_bytes = cls.template.read_bytes()

    @classmethod
    def tearDownClass(cls): cls.template_dir.cleanup()

    @classmethod
    def invoke(cls, root, args, database):
        environment = {'PATH': str(Path(cls.node_binary).parent) + ':/usr/bin:/bin',
                       'HOME': str(database.parent), 'NODE_ENV': 'production',
                       'NEXT_TELEMETRY_DISABLED': '1', 'NODE_NO_WARNINGS': '1',
                       'BUBBLEWASH_DATABASE_PATH': str(database), 'BUBBLEWASH_DISABLE_DEMO_LOGIN': 'true'}
        result = subprocess.run([cls.node_binary, '--conditions=react-server', '--experimental-strip-types', *args],
                                cwd=root, env=environment, capture_output=True, text=True, timeout=20)
        if result.returncode:
            raise ValueError('Synthetic migration subprocess refused')
        return result.stdout.strip()

    def setUp(self):
        self.fixture = frozen.DurableTests('test_success_leaves_maintenance_inhibited_and_owner_aware_pointer')
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.fixture.db.write_bytes(self.template_bytes)
        self.fixture.plan['databaseIdentity'] = list(frozen.c.file_identity(self.fixture.db)[:2])
        self.fixture.plan['controllerPins'][str(ADAPTER / 'host_adapter.py')] = contracts.digest(ADAPTER / 'host_adapter.py')
        self.calls = []
        self.host = object.__new__(adapter.Host)
        self.host.plan = {'candidate': str(self.candidate), 'fallback': str(self.fallback)}
        def node(root, args, database):
            self.calls.append(args[0])
            return self.invoke(root, args, database)
        self.host.node = node
        self.fixture.migrate = self.host.migrate
        self.fixture.verify = self.host.verify_database
        self.control = self.fixture.make_controller()
        self.before = self.protected_rows()

    def protected_rows(self):
        with sqlite3.connect(self.fixture.db) as db:
            names = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('booking_references','vendor_codes','sqlite_sequence','notification_outbox') ORDER BY name")]
            return [(name, db.execute('SELECT rowid,* FROM "' + name.replace('"', '""') + '" ORDER BY rowid').fetchall()) for name in names]

    def schema_state(self):
        with sqlite3.connect(self.fixture.db) as db:
            labels = db.execute("SELECT count(*) FROM sqlite_master WHERE name IN ('booking_references','vendor_codes')").fetchone()[0]
            outbox = any(row[1] == 'delivery_state' for row in db.execute('PRAGMA table_info(notification_outbox)'))
            return labels, outbox

    def assert_held(self):
        self.assertTrue(self.fixture.state.app_hold.exists())
        self.assertTrue(self.fixture.state.maintenance_hold.exists())
        self.assertFalse(any(row[1] == 'start' for row in self.fixture.events))

    def test_real_success_preserves_owner_mfa_records_and_no_historical_backfill(self):
        self.assertEqual(self.control.execute(), 'candidate-ready')
        self.assertEqual(self.schema_state(), (2, True))
        self.assertEqual(self.calls[:2], [LABELS, OUTBOX])
        self.assertEqual(self.protected_rows(), self.before)
        with sqlite3.connect(self.fixture.db) as db:
            for table in ('booking_references', 'vendor_codes'):
                self.assertEqual(db.execute('SELECT count(*) FROM ' + table).fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT id,status,delivery_state,provider_id FROM notification_outbox ORDER BY id').fetchall(),
                             [('pending', 'failed', 'manual_review', 'preserved-provider'),
                              ('sent', 'sent', 'accepted', 'preserved-provider'),
                              ('skipped', 'skipped', 'skipped', 'preserved-provider')])
        self.assertTrue(self.fixture.state.maintenance_hold.exists())

    def crash_after_labels(self):
        actual = self.host.node
        def crashing(root, args, database):
            output = actual(root, args, database)
            if args[0] == LABELS: os._exit(91)
            return output
        self.host.node = crashing
        self.fixture.make_controller().execute()

    def test_abrupt_between_commit_crash_and_recover_remain_held_without_retry(self):
        worker = multiprocessing.get_context('fork').Process(target=self.crash_after_labels)
        worker.start(); worker.join(30)
        if worker.is_alive(): worker.kill(); worker.join(); self.fail('Synthetic child timed out')
        self.assertEqual(worker.exitcode, 91)
        self.assertEqual(self.fixture.state.read()['phase'], 'MIGRATING')
        self.assertEqual(self.schema_state(), (2, False))
        before = frozen.c.core.database_fingerprint(self.fixture.db)
        self.assertEqual(self.protected_rows(), self.before)
        with self.assertRaises(ValueError): self.fixture.make_controller().recover()
        self.assert_held()
        self.assertEqual(self.fixture.current.resolve(), self.fixture.old)
        self.assertEqual(frozen.c.core.database_fingerprint(self.fixture.db), before)
        self.assertNotIn(LABELS, self.calls)
        self.assertNotIn(OUTBOX, self.calls)

    def test_separate_idempotent_completion_then_recovery_keeps_current_data(self):
        worker = multiprocessing.get_context('fork').Process(target=self.crash_after_labels)
        worker.start(); worker.join(30)
        if worker.is_alive(): worker.kill(); worker.join(); self.fail('Synthetic child timed out')
        self.assertEqual(worker.exitcode, 91)
        with self.assertRaises(ValueError): self.fixture.make_controller().recover()
        self.assert_held()
        snapshot = contracts.digest(self.fixture.plan['snapshot'])
        # This is a separate synthetic operator action, NOT part of recover().
        # Production completion requires renewed exact approval/guards/exclusion.
        runtime = self.fixture.root / 'completion-lock'; runtime.mkdir()
        (runtime / 'deploy.lock').write_bytes(b'')
        with frozen.c.guards_module().deployment_lock(runtime, os.getuid()):
            self.assert_held()
            self.assertTrue(self.host.migrate(self.fixture.db))
            before = frozen.c.core.database_fingerprint(self.fixture.db)
            self.assertTrue(self.host.migrate(self.fixture.db))
            self.assertEqual(frozen.c.core.database_fingerprint(self.fixture.db), before)
            self.assertTrue(self.host.verify_database(self.fixture.db))
        with sqlite3.connect(self.fixture.db) as db:
            db.execute("INSERT INTO submissions VALUES ('post-snapshot','time','synthetic','{}')")
            db.execute("INSERT INTO booking_references(order_id) VALUES ('post-snapshot')")
            db.execute("INSERT INTO vendor_codes(vendor_id,code) VALUES ('current-vendor','CUR')")
        current = frozen.c.core.database_fingerprint(self.fixture.db)
        self.assertEqual(self.fixture.make_controller().recover(), 'fallback-ready')
        self.assertEqual(frozen.c.core.database_fingerprint(self.fixture.db), current)
        self.assertEqual(contracts.digest(self.fixture.plan['snapshot']), snapshot)
        self.assertEqual(self.fixture.current.resolve(), self.fixture.fallback)
        self.assertTrue(self.fixture.state.maintenance_hold.exists())
        self.assertFalse(any(row[1] == 'start' and row[3] == 'old' for row in self.fixture.events))

    def test_first_stage_refusal_is_noop_and_stays_held(self):
        with sqlite3.connect(self.fixture.db) as db:
            db.execute('CREATE TABLE booking_references(unreviewed TEXT)')
        before = frozen.c.core.database_fingerprint(self.fixture.db)
        with self.assertRaises(ValueError): self.control.execute()
        self.assert_held()
        self.assertEqual(self.calls, [LABELS])
        self.assertEqual(frozen.c.core.database_fingerprint(self.fixture.db), before)

    def test_second_stage_failure_keeps_completed_labels_held(self):
        actual = self.host.node
        def failing(root, args, database):
            if args[0] == OUTBOX: raise OSError('Synthetic second command failure')
            return actual(root, args, database)
        self.host.node = failing
        with self.assertRaises(OSError): self.control.execute()
        self.assert_held()
        self.assertEqual(self.schema_state(), (2, False))
        self.assertEqual(self.protected_rows(), self.before)
        with self.assertRaises(ValueError): self.fixture.make_controller().recover()
        self.assert_held()

    def test_unconfirmed_label_stdout_after_commit_stays_held(self):
        actual = self.host.node
        def uncertain(root, args, database):
            actual(root, args, database)
            return '{}'
        self.host.node = uncertain
        with self.assertRaises(ValueError): self.control.execute()
        self.assert_held()
        self.assertEqual(self.calls, [LABELS])
        self.assertEqual(self.schema_state(), (2, False))
        self.assertEqual(self.protected_rows(), self.before)

    def test_abrupt_after_outbox_commit_recovers_without_rerunning_migration(self):
        def crash():
            actual = self.host.node
            def crashing(root, args, database):
                output = actual(root, args, database)
                if args[0] == OUTBOX: os._exit(92)
                return output
            self.host.node = crashing
            self.fixture.make_controller().execute()
        worker = multiprocessing.get_context('fork').Process(target=crash)
        worker.start(); worker.join(30)
        if worker.is_alive(): worker.kill(); worker.join(); self.fail('Synthetic child timed out')
        self.assertEqual(worker.exitcode, 92)
        self.assertEqual(self.fixture.state.read()['phase'], 'MIGRATING')
        self.assertEqual(self.schema_state(), (2, True))
        before = frozen.c.core.database_fingerprint(self.fixture.db)
        self.assertEqual(self.fixture.make_controller().recover(), 'fallback-ready')
        self.assertEqual(frozen.c.core.database_fingerprint(self.fixture.db), before)
        self.assertEqual(self.protected_rows(), self.before)
        self.assertTrue(self.fixture.state.maintenance_hold.exists())
        self.assertNotIn(LABELS, self.calls)
        self.assertNotIn(OUTBOX, self.calls)


if __name__ == '__main__': unittest.main()
