"""Local completion acceptance: real SQLite/CLIs, frozen journal, simulated host."""
import copy
from contextlib import contextmanager, redirect_stdout
import io
import json
import multiprocessing
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import test_reference_migration as fixtures

a, c = fixtures.adapter, fixtures.frozen.c


class ConfirmationTests(unittest.TestCase):
    def test_missing_wrong_or_stale_confirmation_precedes_all_host_access(self):
        digest = 'a' * 64
        with patch.object(a, 'load_controller', side_effect=AssertionError('host access before confirmation')):
            for value in ('', None, True, 'complete-migration:' + 'b' * 64, 'complete-migration:' + digest + '\n'):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    a.run_plan({}, 'complete-migration', value, digest)
            for mode in ('inspect', 'execute', 'recover', 'unknown'):
                with self.subTest(mode=mode), self.assertRaises(ValueError):
                    a.run_plan({}, mode, 'complete-migration:' + digest, digest)

    def test_main_checks_actual_plan_file_digest_and_confirmation_before_run(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'plan.json'; path.write_text('{"fixture":"reviewed"}\n')
            digest = fixtures.contracts.digest(path)
            base = ['host_adapter', '--plan', str(path), '--plan-sha256', digest,
                    '--mode', 'complete-migration']
            # Root-protected ancestry is separately covered by bootstrap tests;
            # this disposable path tests the real parser, file hash and JSON load.
            with patch.object(a, 'protected'), patch.object(a, 'run_plan', return_value='already-complete-held-use-recover') as run:
                for args in (base, base + ['--completion-confirmation', 'complete-migration:' + 'b' * 64],
                             [value if value != digest else 'b' * 64 for value in base] + ['--completion-confirmation', 'complete-migration:' + 'b' * 64]):
                    with patch.object(sys, 'argv', args), self.assertRaises(ValueError): a.main()
                    run.assert_not_called()
                output = io.StringIO()
                with patch.object(sys, 'argv', base + ['--completion-confirmation', 'complete-migration:' + digest]), patch.object(a.signal, 'signal'), redirect_stdout(output):
                    a.main()
                run.assert_called_once_with({'fixture': 'reviewed'}, 'complete-migration', 'complete-migration:' + digest, digest)
                self.assertEqual(json.loads(output.getvalue()), {'ok': True, 'result': 'already-complete-held-use-recover', 'maintenanceResumed': False, 'databaseRestored': False})

    def test_workflow_confirmation_guard_is_before_tailnet_and_default_is_inspect(self):
        workflow = (fixtures.ROOT / '.github/workflows/integration-code-deploy.yml').read_text()
        self.assertIn('default: inspect', workflow)
        shell = workflow.split('run: |', 1)[1].split('      - uses:', 1)[0]
        shell = '\n'.join(line[10:] for line in shell.splitlines() if line.strip())
        common = {**os.environ, 'CANDIDATE_SHA': 'c' * 40, 'GITHUB_SHA': 'c' * 40,
                  'FALLBACK_SHA': 'f' * 40, 'PLAN_ID': '1' * 64, 'PLAN_SHA256': 'a' * 64,
                  'PREPARATION_PINS': '', 'MATERIALIZATION_REVIEW': ''}
        for mode, token, success in [('complete-migration', '', False), ('complete-migration', 'complete-migration:' + 'b' * 64, False),
                                     ('complete-migration', 'complete-migration:' + 'a' * 64, True), ('inspect', '', True),
                                     ('execute', 'complete-migration:' + 'a' * 64, False), ('recover', '', True)]:
            result = subprocess.run(['bash', '-c', shell], env={**common, 'RELEASE_MODE': mode, 'COMPLETION_CONFIRMATION': token}, capture_output=True, timeout=10)
            self.assertEqual(result.returncode == 0, success)
            self.assertEqual(result.stdout, b'')
        self.assertLess(workflow.index('COMPLETION_CONFIRMATION" =='), workflow.index('uses: tailscale/'))

    def test_stream_requires_exact_confirmation_and_emits_no_payload_on_refusal(self):
        command = [sys.executable, '-I', '-B', str(fixtures.ADAPTER / 'stream_host.py'),
                   '--plan-id', '1' * 64, '--plan-sha256', 'a' * 64,
                   '--candidate-sha', 'c' * 40, '--fallback-sha', '80ec00902fcc5fe16a17ab814c7d191ad44afb64',
                   '--mode', 'complete-migration']
        # -I deliberately does not add the script directory; use the supported
        # ordinary local entrypoint with bytecode writes disabled instead.
        command.remove('-I')
        for value in ('', 'complete-migration:' + 'b' * 64):
            result = subprocess.run(command + ['--completion-confirmation', value], capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, '')
        # Supply a synthetic reviewed receipt only inside the disposable test
        # process. The published C1 constant remains None and refuses execution.
        script = ("import sys,runpy;sys.path.insert(0," + repr(str(fixtures.ADAPTER)) + ");import contracts;"
                  "contracts.FALLBACK_CONTROL_PROOF={'controlSha':'c'*40,'runId':123,'artifactId':456,'artifactSha256':'d'*64};"
                  "sys.argv=['stream_host',*sys.argv[1:]];runpy.run_path(" + repr(str(fixtures.ADAPTER/'stream_host.py')) + ",run_name='__main__')")
        result = subprocess.run([sys.executable,'-B','-c',script] + command[3:] + ['--completion-confirmation', 'complete-migration:' + 'a' * 64], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        compile(result.stdout, '<reviewed-bootstrap>', 'exec')
        self.assertIn("'--mode', 'complete-migration'", result.stdout)
        self.assertIn("'--completion-confirmation', 'complete-migration:" + 'a' * 64 + "'", result.stdout)


class PreparationTransportTests(unittest.TestCase):
    def request(self):
        return {'runId':'123','runAttempt':1,
                'candidateSha':'5f256800d65dbe3b69f54e95afa0e8ab30b5e881',
                'fallbackSha':'80ec00902fcc5fe16a17ab814c7d191ad44afb64',
                'backupSha256':'a'*64,'receiptRun':'124','storeSha':'b'*40,'storeId':1,
                'node':{'path':'/usr/bin/node','sha256':'c'*64}}

    def test_missing_proof_refuses_before_program_generation(self):
        import stream_host
        with patch.object(fixtures.contracts, 'FALLBACK_CONTROL_PROOF', None), patch.object(stream_host, 'public_package', side_effect=AssertionError('serialized before proof')):
            with self.assertRaises(ValueError):stream_host.preparation_bootstrap('prepare',self.request())

    def test_prepare_input_is_exact_and_retries_are_refused(self):
        import stream_host
        contract=fixtures.contracts.read_json(fixtures.ADAPTER/'source-contracts.json')
        self.assertEqual(stream_host.validate_preparation_request(self.request(),contract),self.request())
        for key,value in [('runAttempt',2),('runAttempt',True),('runId','../123'),
                          ('storeId',True),('backupSha256','bad'),('candidateSha','f'*40)]:
            with self.subTest(key=key),self.assertRaises(ValueError):
                stream_host.validate_preparation_request({**self.request(),key:value},contract)
        with self.assertRaises(ValueError):stream_host.validate_preparation_request({**self.request(),'environment':'private'},contract)

    def test_preparation_emitter_is_code_only_and_compiles_without_host_action(self):
        import stream_host
        with patch.object(fixtures.contracts, 'FALLBACK_CONTROL_PROOF', {'controlSha':'c'*40,'runId':123,'artifactId':456,'artifactSha256':'d'*64}):
            body=stream_host.preparation_bootstrap('prepare',self.request())
        compile(body,'<synthetic-prepare>','exec')
        self.assertIn("base.mkdir(mode=0o755)",body)
        self.assertIn("path.open('xb')",body)
        self.assertIn("integration_preparation",body)
        self.assertIn("prepare_pair(request",body)
        self.assertNotIn("host_adapter.main()",body)
        self.assertIn("__source_verified__=True",body)

    def test_bootstrap_failure_is_fixed_metadata_without_private_traceback(self):
        import stream_host
        with patch.object(fixtures.contracts, 'FALLBACK_CONTROL_PROOF', {'controlSha':'c'*40,'runId':123,'artifactId':456,'artifactSha256':'d'*64}):
            body=stream_host.preparation_bootstrap('prepare',self.request())
        # Refuse before any host filesystem action, even on a privileged runner.
        body=body.replace('require(os.geteuid()==0 and os.getegid()==0)',"require(False)",1)
        result=subprocess.run([sys.executable,'-I','-B','-'],input=body,capture_output=True,text=True,timeout=10)
        self.assertNotEqual(result.returncode,0);self.assertEqual(result.stdout,'')
        self.assertEqual(json.loads(result.stderr),{'ok':False,'status':'control-bootstrap-refused-or-incomplete','inspectBeforeRetry':True,'automaticRetry':False})

    def test_unknown_mode_and_mixed_request_cli_emit_nothing(self):
        command=[sys.executable,'-B',str(fixtures.ADAPTER/'stream_host.py')]
        for args in [ ['--mode','unknown'], ['--mode','prepare'],
                      ['--mode','inspect-host-evidence','--preparation-request','/nonexistent'] ]:
            result=subprocess.run(command+args,capture_output=True,text=True,timeout=10)
            self.assertNotEqual(result.returncode,0);self.assertEqual(result.stdout,'')


class CompletionTests(fixtures.RealMigrationTests):
    def setUp(self):
        super().setUp()
        # Bind the real coordinated policy before the first journal phase.
        policy = fixtures.contracts.load_controller().CoordinatedController
        self.enterContext(patch.object(c, 'Controller', policy))
        self.enterContext(patch.object(c, 'CoordinatedController', policy, create=True))
        self.fixture.plan.pop('externalInvokersExcluded')
        self.fixture.plan['coordinatedWriterHold'] = {
            'schema': 'bubblewash-coordinated-writer-hold/v1',
            'knownUnits': list(fixtures.contracts.COORDINATED_UNITS),
            'knownInvokersSha256': 'b' * 64, 'riskApprovalSha256': 'a' * 64,
            'residualAccessAcknowledged': True,
            'residualAssumptionSha256': fixtures.contracts.RESIDUAL_ASSUMPTION_SHA256,
        }
        policy_path = Path(fixtures.contracts.__file__).resolve()
        self.fixture.plan['controllerPins'][str(policy_path)] = fixtures.contracts.digest(policy_path)
        self.control = self.fixture.make_controller()
        self.assertIsInstance(self.control, policy)
        self.host.journal_plan, self.host.journal_hash = self.fixture.plan, self.control.plan_hash

    def labels_only(self):
        actual = self.host.node
        def interrupt(root, args, database):
            value = actual(root, args, database)
            if args[0] == fixtures.LABELS: raise OSError('Synthetic interrupted initial execute')
            return value
        self.host.node = interrupt
        try:
            with self.assertRaises(OSError): self.control.execute()
        finally:
            self.host.node = actual
        self.assertEqual(self.schema_state(), (2, False))
        self.assertEqual(self.fixture.state.read()['phase'], 'MIGRATING')
        self.calls.clear(); self.fixture.events.clear()

    def complete(self):
        return a.complete_labels_only(self.fixture.make_controller(), self.host)

    @contextmanager
    def routed_host(self):
        runtime = self.fixture.root / 'route-runtime'; runtime.mkdir()
        (runtime / 'deploy.lock').write_bytes(b'')
        env = self.fixture.root / 'env'
        env.write_text('BUBBLEWASH_STAFF_AUTH_DISABLED=false\nBUBBLEWASH_BOOKINGS_DISABLED=true\nBUBBLEWASH_DISABLE_DEMO_LOGIN=true\nNEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED=false\n')
        self.host.uid = os.getuid()
        self.host.roots = (self.fixture.old, self.fixture.candidate, self.fixture.fallback)
        self.host.service = self.fixture.service
        self.host.quiet = lambda: True
        self.host.loaded = lambda _state: True
        self.host.capture = lambda: None
        self.host.readiness = lambda _target: self.fail('completion started readiness')
        self.guard_checks = 0
        outer = self
        class Guard:
            def __init__(self, *_args): pass
            @contextmanager
            def locked(self):
                with c.guards_module().deployment_lock(runtime, os.getuid()):
                    def verify():
                        outer.guard_checks += 1
                        return True
                    verify.database_path = outer.fixture.db
                    verify.marker_path = outer.fixture.marker
                    yield verify
        with patch.object(a, 'load_controller', return_value=c), \
             patch.object(a, 'STATE', self.fixture.state.directory), \
             patch.object(a, 'RUNTIME', runtime), patch.object(a, 'ENV', env), \
             patch.object(a, 'Host', return_value=self.host), \
             patch.object(a, 'validate_plan', return_value=True), \
             patch.object(a, 'durable_plan', return_value=self.fixture.plan), \
             patch.object(c, 'DurableState', return_value=self.fixture.state), \
             patch.object(c, 'HostGuards', Guard):
            yield

    def test_complete_route_confirms_then_holds_without_selecting_or_starting(self):
        self.labels_only()
        marker = self.fixture.marker.read_bytes()
        snapshot = fixtures.contracts.digest(self.fixture.plan['snapshot'])
        with self.routed_host():
            plan = {**self.fixture.plan, 'guards': {}}
            self.assertEqual(a.run_plan(plan, 'complete-migration', 'complete-migration:' + 'a' * 64, 'a' * 64),
                             'migration-completed-held-use-recover')
        self.assertGreaterEqual(self.guard_checks, 3)
        self.assert_held()
        self.assertEqual(self.fixture.state.read()['phase'], 'MIGRATED')
        self.assertEqual(self.schema_state(), (2, True))
        self.assertEqual(self.fixture.current.resolve(), self.fixture.old)
        self.assertEqual(self.fixture.marker.read_bytes(), marker)
        self.assertEqual(fixtures.contracts.digest(self.fixture.plan['snapshot']), snapshot)
        self.assertEqual(self.protected_rows(), self.before)
        self.assertEqual(self.fixture.make_controller().recover(), 'fallback-ready')

    def test_successful_completion_retry_is_held_readonly_noop_only(self):
        self.labels_only(); self.assertEqual(self.complete(), 'migration-completed-held-use-recover')
        before = c.core.database_fingerprint(self.fixture.db)
        journal = self.fixture.state.journal.read_bytes(); self.calls.clear()
        self.assertEqual(self.complete(), 'already-complete-held-use-recover')
        self.assert_held(); self.assertEqual(c.core.database_fingerprint(self.fixture.db), before)
        self.assertEqual(self.fixture.state.journal.read_bytes(), journal)
        self.assertNotIn(fixtures.LABELS, self.calls); self.assertNotIn(fixtures.OUTBOX, self.calls)
        self.fixture.state.record('FALLBACK_SELECTED', self.fixture.make_controller().plan_hash, str(self.fixture.fallback))
        with self.assertRaises(ValueError): self.complete()

    def test_late_plan_validation_failure_restores_holds_before_refusal(self):
        self.labels_only()
        self.fixture.state.app_hold.unlink(); self.fixture.state.maintenance_hold.unlink()
        def refused(_plan):
            self.assertTrue(self.fixture.state.app_hold.exists())
            self.assertTrue(self.fixture.state.maintenance_hold.exists())
            self.assertEqual([(event[0], event[2]) for event in self.fixture.events], list(c.core.UNITS))
            raise ValueError('Synthetic current plan validation refused')
        before = c.core.database_fingerprint(self.fixture.db); journal = self.fixture.state.journal.read_bytes()
        with self.routed_host(), patch.object(a, 'validate_plan', side_effect=refused), self.assertRaises(ValueError):
            a.run_plan({**self.fixture.plan, 'guards': {}}, 'complete-migration', 'complete-migration:' + 'a' * 64, 'a' * 64)
        self.assert_held(); self.assertEqual(self.calls, [])
        self.assertEqual(c.core.database_fingerprint(self.fixture.db), before)
        self.assertEqual(self.fixture.state.journal.read_bytes(), journal)

    def test_real_expired_backup_guard_refuses_after_restoring_holds(self):
        self.labels_only()
        evidence = fixtures.frozen.ExistingHostGuardTests('test_expired_status_blocks')
        evidence.setUp(); self.addCleanup(evidence.tearDown)
        values = evidence.env.read_text().replace(str(evidence.db), str(self.fixture.db))
        values += 'BUBBLEWASH_STAFF_AUTH_DISABLED=false\nBUBBLEWASH_BOOKINGS_DISABLED=true\nBUBBLEWASH_DISABLE_DEMO_LOGIN=true\nNEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED=false\n'
        evidence.env.write_text(values)
        evidence.expected.update(envSha256=c.core.digest(evidence.env), database=str(self.fixture.db))
        receipt = json.loads(evidence.receipt.read_text()); receipt['verifiedAt'] = '2000-01-01T00:00:00Z'
        evidence.receipt.write_text(json.dumps(receipt)); evidence.expected['receiptSha256'] = c.core.digest(evidence.receipt)
        self.fixture.state.app_hold.unlink(); self.fixture.state.maintenance_hold.unlink()
        before = c.core.database_fingerprint(self.fixture.db); journal = self.fixture.state.journal.read_bytes()
        real_guard = c.HostGuards
        with self.routed_host(), patch.object(c, 'HostGuards', real_guard), patch.object(a, 'RUNTIME', evidence.runtime), \
             patch.object(a, 'ENV', evidence.env), patch.object(a, 'RECEIPT', evidence.receipt), self.assertRaises(ValueError):
            a.run_plan({**self.fixture.plan, 'guards': evidence.expected}, 'complete-migration', 'complete-migration:' + 'a' * 64, 'a' * 64)
        self.assert_held(); self.assertEqual(self.calls, [])
        self.assertEqual([(event[0], event[2]) for event in self.fixture.events], list(c.core.UNITS))
        self.assertEqual(c.core.database_fingerprint(self.fixture.db), before)
        self.assertEqual(self.fixture.state.journal.read_bytes(), journal)

    def test_wrong_confirmation_leaves_existing_db_journal_holds_and_services_unchanged(self):
        self.labels_only()
        state = self.fixture.state
        files = [self.fixture.db, state.journal, state.app_hold, state.maintenance_hold]
        before = [(p.stat().st_ino, p.read_bytes()) for p in files]
        for confirmation, digest in [('', 'a' * 64), ('complete-migration:' + 'b' * 64, 'a' * 64), ('complete-migration:' + 'a' * 64, 'b' * 64)]:
            with self.assertRaises(ValueError): a.run_plan({}, 'complete-migration', confirmation, digest)
        self.assertEqual([(p.stat().st_ino, p.read_bytes()) for p in files], before)
        self.assertEqual(self.fixture.events, [])
        self.assertEqual(self.calls, [])

    def test_changed_package_or_journal_phase_target_rejects_before_migration(self):
        self.labels_only()
        journal = self.fixture.state.journal.read_bytes()
        original = self.fixture.state.read()
        for key, value in [('planHash', 'b' * 64), ('phase', 'BACKED_UP'), ('target', str(self.fixture.candidate)), ('schema', 2), ('schema', True)]:
            bad = {**original, key: value}
            self.fixture.state.journal.write_text(json.dumps(bad))
            with self.assertRaises(ValueError): self.complete()
            self.assert_held(); self.assertEqual(self.calls, [])
        self.fixture.state.journal.write_bytes(journal[:-1] + b', "phase": "MIGRATING"}')
        with self.assertRaises(ValueError): self.complete()
        self.assert_held(); self.assertEqual(self.calls, [])
        self.fixture.state.journal.write_bytes(journal)
        self.fixture.plan['controllerPins'][str(fixtures.ADAPTER / 'host_adapter.py')] = '0' * 64
        with self.assertRaises(ValueError): self.complete()
        self.assert_held(); self.assertEqual(self.calls, [])

    def test_pointer_and_marker_drift_refuse(self):
        self.labels_only()
        self.fixture.current.unlink(); self.fixture.current.symlink_to(self.fixture.candidate)
        with self.assertRaises(ValueError): self.complete()
        self.fixture.current.unlink(); self.fixture.current.symlink_to(self.fixture.old)
        self.fixture.marker.write_text('unreviewed')
        with self.assertRaises(ValueError): self.complete()
        self.assert_held(); self.assertEqual(self.calls, [])

    def test_guard_gate_or_quiescence_failure_never_migrates(self):
        self.labels_only()
        for name in ('guard', 'verify_gates', 'quiescent'):
            control = self.fixture.make_controller()
            old = getattr(control, name)
            def failed(): raise ValueError('Synthetic current evidence refused')
            if name == 'guard':
                failed.database_path = self.fixture.db; failed.marker_path = self.fixture.marker
            setattr(control, name, failed)
            with self.subTest(name=name), self.assertRaises(ValueError): a.complete_labels_only(control, self.host)
            setattr(control, name, old)
            self.assert_held(); self.assertEqual(self.calls, [])

    def test_consumed_maps_partial_outbox_and_missing_core_reject(self):
        self.labels_only()
        original = self.fixture.db.read_bytes()
        changes = ["INSERT INTO booking_references(order_id) VALUES ('intervening')",
                   "INSERT INTO sqlite_sequence(name,seq) VALUES ('vendor_codes',1)",
                   'ALTER TABLE notification_outbox ADD COLUMN delivery_state TEXT',
                   'CREATE INDEX unexpected ON vendor_codes(code)', 'DROP TABLE submissions']
        for sql in changes:
            self.fixture.db.write_bytes(original)
            with sqlite3.connect(self.fixture.db) as db: db.execute(sql)
            before = c.core.database_fingerprint(self.fixture.db)
            with self.subTest(sql=sql), self.assertRaises(ValueError): self.complete()
            self.assertEqual(c.core.database_fingerprint(self.fixture.db), before)
            self.assertNotIn(fixtures.LABELS, self.calls); self.assertNotIn(fixtures.OUTBOX, self.calls)
            self.assert_held()

    def test_existing_owner_data_or_metadata_drift_against_snapshot_rejects(self):
        self.labels_only()
        original = self.fixture.db.read_bytes()
        for sql in ["UPDATE staff_accounts SET password_hash='changed'", "UPDATE submissions SET source='changed'", 'PRAGMA user_version=9']:
            self.fixture.db.write_bytes(original)
            with sqlite3.connect(self.fixture.db) as db: db.execute(sql)
            before = c.core.database_fingerprint(self.fixture.db)
            with self.subTest(sql=sql), self.assertRaises(ValueError): self.complete()
            self.assertEqual(c.core.database_fingerprint(self.fixture.db), before)
            self.assertNotIn(fixtures.LABELS, self.calls); self.assertNotIn(fixtures.OUTBOX, self.calls)
            self.assert_held()

    def test_unprotected_or_replaced_snapshot_refuses(self):
        self.labels_only()
        snapshot = Path(self.fixture.plan['snapshot'])
        snapshot.chmod(0o644)
        with self.assertRaises(ValueError): self.complete()
        snapshot.chmod(0o600)
        with sqlite3.connect(snapshot) as db: db.execute("UPDATE submissions SET source='changed'")
        with self.assertRaises(ValueError): self.complete()
        self.assertNotIn(fixtures.LABELS, self.calls); self.assertNotIn(fixtures.OUTBOX, self.calls)
        self.assert_held()

    def test_interrupted_completion_retry_stays_labels_only_then_finishes(self):
        self.labels_only()
        def crash():
            actual = self.host.node
            def crashing(root, args, database):
                result = actual(root, args, database)
                if args[0] == fixtures.LABELS: os._exit(93)
                return result
            self.host.node = crashing
            self.complete()
        worker = multiprocessing.get_context('fork').Process(target=crash); worker.start(); worker.join(30)
        if worker.is_alive(): worker.kill(); worker.join(); self.fail('Synthetic completion timed out')
        self.assertEqual(worker.exitcode, 93)
        self.assert_held(); self.assertEqual(self.schema_state(), (2, False))
        self.assertEqual(self.complete(), 'migration-completed-held-use-recover')
        self.assert_held(); self.assertEqual(self.protected_rows(), self.before)

    def test_original_row_changed_during_completion_stays_held(self):
        self.labels_only()
        actual=self.host.node
        def mutate(root,args,database):
            value=actual(root,args,database)
            if args[0]==fixtures.FEATURE and '--verify' in args:
                with sqlite3.connect(database) as db:db.execute("UPDATE staff_accounts SET name='unexpected'")
            return value
        self.host.node=mutate
        with self.assertRaises(ValueError):self.complete()
        self.assert_held()
        self.assertEqual(self.fixture.state.read()['phase'],'MIGRATING')

    def test_already_complete_original_row_mutation_is_not_accepted(self):
        self.labels_only();self.complete()
        with sqlite3.connect(self.fixture.db) as db:db.execute("UPDATE staff_accounts SET name='unexpected'")
        with self.assertRaises(ValueError):self.complete()
        self.assert_held()

    def test_post_commit_retry_reports_already_complete_without_database_or_journal_write(self):
        self.labels_only()
        def crash():
            actual = self.host.node
            def crashing(root, args, database):
                result = actual(root, args, database)
                if args[0] == fixtures.FEATURE and '--preflight' not in args and '--verify' not in args: os._exit(94)
                return result
            self.host.node = crashing
            self.complete()
        worker = multiprocessing.get_context('fork').Process(target=crash); worker.start(); worker.join(30)
        if worker.is_alive(): worker.kill(); worker.join(); self.fail('Synthetic completion timed out')
        self.assertEqual(worker.exitcode, 94)
        self.assertEqual(self.fixture.state.read()['phase'], 'MIGRATING')
        before = c.core.database_fingerprint(self.fixture.db)
        journal = self.fixture.state.journal.read_bytes()
        self.calls.clear()
        self.assertEqual(self.complete(), 'already-complete-held-use-recover')
        self.assert_held()
        self.assertEqual(c.core.database_fingerprint(self.fixture.db), before)
        self.assertEqual(self.fixture.state.journal.read_bytes(), journal)
        self.assertNotIn(fixtures.LABELS, self.calls); self.assertNotIn(fixtures.OUTBOX, self.calls)
        self.assertEqual(self.fixture.make_controller().recover(), 'fallback-ready')


if __name__ == '__main__': unittest.main()
