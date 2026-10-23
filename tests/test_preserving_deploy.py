import copy
import importlib.util
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).resolve().parents[1] / 'ops/deploy-preserving.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class Gates(unittest.TestCase):
    def setUp(self):
        self.receipt = dict(schema='becore-encrypted-backup-release/v2', repository='bechirobob/bubble-wash',
                            storageRepository='bechirobob/becore-backups', storage='private-github-release',
                            storageSha='a' * 40, storageRepositoryId=12, runId='99', encrypted=True,
                            restoreTested=True, downloadVerified=True, automaticExpiry=False, retentionDays=None,
                            filename='bubblewash-2026-10-22T09:00:00.sqlite.enc', sha256='b' * 64,
                            sourceSha='c' * 40, size=20, verifiedAt='2026-10-22T09:02:00Z')
        self.status = dict(ok=True, filename=self.receipt['filename'], sha256='b' * 64,
                           createdAt='2026-10-22T09:00:00Z', restoreVerifiedAt='2026-10-22T09:01:00Z',
                           offsiteStoredAt='2026-10-22T09:03:00Z')
        self.now = deploy.dt.datetime.fromisoformat('2026-10-22T10:00:00+00:00').timestamp()

    def verify(self):
        deploy.verify_receipt(self.receipt, self.status, self.now, '99', 'a' * 40, 12)

    def test_valid_receipt(self):
        self.verify()

    def test_rejects_identity_proof_and_retention_changes(self):
        for key, value in [('runId', '100'), ('storageSha', 'e' * 40), ('storageRepositoryId', 13),
                           ('repository', 'other/repo'), ('storageRepository', 'other/repo'),
                           ('storage', 'public-artifact'), ('encrypted', False), ('restoreTested', False),
                           ('downloadVerified', False), ('automaticExpiry', True), ('retentionDays', 30),
                           ('filename', '../backup.enc'), ('size', 0), ('sourceSha', 'main')]:
            with self.subTest(key=key):
                original = self.receipt[key]
                self.receipt[key] = value
                with self.assertRaises((ValueError, KeyError)):
                    self.verify()
                self.receipt[key] = original

    def test_mismatched_status(self):
        for key in ('filename', 'sha256', 'ok'):
            original = self.status[key]
            self.status[key] = False
            with self.assertRaises(ValueError):
                self.verify()
            self.status[key] = original

    def test_expired_future_or_out_of_order(self):
        self.now += 31 * 3600
        with self.assertRaises(ValueError): self.verify()
        self.now -= 33 * 3600
        with self.assertRaises(ValueError): self.verify()
        self.now += 2 * 3600
        self.status['restoreVerifiedAt'] = '2026-10-22T09:04:00Z'
        with self.assertRaises(ValueError): self.verify()

    def test_parser_preserves_values_and_rejects_ambiguous_syntax(self):
        raw = b'A="secret value"\nB=false\n# comment\n'
        self.assertEqual(deploy.parse(raw), {'A': 'secret value', 'B': 'false'})
        for raw in (b'A=a\nA=b', b'A="unterminated', b'A=`command`', b'not an assignment'):
            with self.assertRaises(ValueError): deploy.parse(raw)

    def test_snapshot_fingerprint_detects_schema_or_account_mutation(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'db.sqlite'
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE staff(id TEXT, password_hash TEXT)')
                db.execute("INSERT INTO staff VALUES('existing', 'unchanged')")
            original = deploy.database_fingerprint(path)
            self.assertEqual(original, deploy.database_fingerprint(path))
            with sqlite3.connect(path) as db:
                db.execute("UPDATE staff SET password_hash='changed'")
            self.assertNotEqual(original, deploy.database_fingerprint(path))
            with sqlite3.connect(path) as db:
                db.execute("UPDATE staff SET password_hash='unchanged'")
                db.execute('CREATE TABLE new_table(id TEXT)')
            self.assertNotEqual(original, deploy.database_fingerprint(path))

    def test_success_and_code_only_rollback(self):
        for failure in (None, 'start', 'validate', 'stop', 'interrupt'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                previous = root / 'previous'; previous.mkdir()
                candidate = root / 'candidate'; candidate.mkdir()
                current = root / 'current'; current.symlink_to(previous)
                calls = []; failed = False
                def service(action, _):
                    nonlocal failed
                    calls.append(action)
                    if action == failure and not failed:
                        failed = True
                        raise RuntimeError('injected service failure')
                def validate(target):
                    if target == candidate:
                        if failure == 'validate': raise ValueError('injected health/config failure')
                        if failure == 'interrupt': raise KeyboardInterrupt()
                if failure:
                    with self.assertRaises(BaseException):
                        deploy.activate(current, candidate, service, validate)
                    self.assertEqual(current.resolve(), previous)
                else:
                    deploy.activate(current, candidate, service, validate)
                    self.assertEqual(current.resolve(), candidate)
                self.assertTrue(previous.is_dir())
                self.assertTrue(candidate.is_dir())
                self.assertEqual(calls[-1], 'restart' if failure else 'start')

    def test_rejects_non_symlink_current(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            with self.assertRaises(ValueError):
                deploy.activate(path, path, lambda *_: None, lambda *_: None)

    def test_no_legacy_transport_or_config_writers(self):
        root = Path(__file__).resolve().parents[1]
        workflow = (root / '.github/workflows/production-deploy.yml').read_text()
        self.assertNotIn('workflow_run:', workflow)
        self.assertNotIn('upload-artifact', workflow)
        self.assertNotIn('BUBBLEWASH_BACKUP_ENCRYPTION_KEY', workflow)
        self.assertIn('"$TARGET_SHA" == "$GITHUB_SHA"', workflow)
        self.assertIn('environment: backup-storage', workflow)
        script = (root / 'ops/deploy-preserving.py').read_text()
        self.assertNotIn('db:production-reset', script)
        self.assertNotIn('ENV.write', script)
        self.assertNotIn('daemon-reload', script)
        self.assertNotIn('enable --now', script)


class RowIdentityFingerprint(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / 'snapshot.sqlite'

    def sql(self, script):
        with sqlite3.connect(self.path) as db:
            db.executescript(script)

    def fingerprint(self):
        return deploy.database_fingerprint(self.path)

    def test_hidden_rowid_change_is_detected(self):
        self.sql("CREATE TABLE submissions(data TEXT); INSERT INTO submissions VALUES('same');")
        before = self.fingerprint()
        self.sql('UPDATE submissions SET rowid=100 WHERE rowid=1;')
        self.assertNotEqual(before, self.fingerprint())

    def test_swapping_rowid_value_pairs_is_detected(self):
        self.sql("CREATE TABLE submissions(data TEXT); INSERT INTO submissions VALUES('first'),('second');")
        before = self.fingerprint()
        self.sql('UPDATE submissions SET rowid=100 WHERE rowid=1; UPDATE submissions SET rowid=1 WHERE rowid=2; UPDATE submissions SET rowid=2 WHERE rowid=100;')
        self.assertNotEqual(before, self.fingerprint())

    def test_integer_primary_key_alias_is_supported(self):
        self.sql("CREATE TABLE records(id INTEGER PRIMARY KEY, data TEXT); INSERT INTO records VALUES(1,'same');")
        before = self.fingerprint()
        self.assertEqual(before, self.fingerprint())
        self.sql('UPDATE records SET id=100 WHERE id=1;')
        self.assertNotEqual(before, self.fingerprint())

    def test_shadowed_rowid_uses_an_unshadowed_case_insensitive_alias(self):
        self.sql("""CREATE TABLE records("RoWiD" TEXT, "_RoWiD_" TEXT, data TEXT); INSERT INTO records VALUES('visible','also visible','same');""")
        before = self.fingerprint()
        self.sql('UPDATE records SET oid=100 WHERE oid=1;')
        self.assertNotEqual(before, self.fingerprint())

    def test_all_rowid_aliases_shadowed_fails_closed(self):
        self.sql('CREATE TABLE records("rowid" TEXT, "_rowid_" TEXT, "OID" TEXT);')
        with self.assertRaisesRegex(ValueError, 'shadowed'):
            self.fingerprint()

    def test_without_rowid_table_supported_and_values_remain_paired(self):
        self.sql("CREATE TABLE records(id TEXT PRIMARY KEY, data TEXT) WITHOUT ROWID; INSERT INTO records VALUES('a','first'),('b','second');")
        before = self.fingerprint()
        self.assertEqual(before, self.fingerprint())
        self.sql("UPDATE records SET data=CASE id WHEN 'a' THEN 'second' ELSE 'first' END;")
        self.assertNotEqual(before, self.fingerprint())

    def test_without_rowid_may_have_all_alias_names(self):
        self.sql("""CREATE TABLE records("rowid" TEXT PRIMARY KEY, "_rowid_" TEXT, "oid" TEXT) WITHOUT ROWID; INSERT INTO records VALUES('a','b','c');""")
        self.assertEqual(self.fingerprint(), self.fingerprint())

    def test_virtual_table_fails_closed(self):
        self.sql('CREATE VIRTUAL TABLE records USING fts5(data);')
        with self.assertRaisesRegex(ValueError, 'completely fingerprinted'):
            self.fingerprint()


class PrivateNetwork(unittest.TestCase):
    def test_only_verified_private_loopback_is_accepted(self):
        deploy.verify_network_shape(2, 1, [{'ifname': 'lo'}], [[{'dev': 'lo', 'dst': '127.0.0.0/8'}], []])
        for args in [(1, 1, [{'ifname': 'lo'}], [[], []]),
                     (2, 1, [{'ifname': 'lo'}, {'ifname': 'eth0'}], [[], []]),
                     (2, 1, [{'ifname': 'lo'}], [[{'dev': 'lo', 'dst': 'default'}], []]),
                     (2, 1, [{'ifname': 'lo'}], [[], [{'dev': 'eth0', 'dst': '::/0'}]])]:
            with self.assertRaises(ValueError): deploy.verify_network_shape(*args)

    def test_probe_commands_enter_only_verified_pid_network_namespace(self):
        with patch.object(deploy, 'command', return_value='ok') as run:
            self.assertEqual(deploy.network_command(['curl', 'localhost'], 321), 'ok')
            run.assert_called_once_with(['nsenter', '--target', '321', '--net', '--', 'curl', 'localhost'], timeout=30)
        with patch.object(deploy, 'command', return_value='ok') as run:
            deploy.network_command(['ss'])
            run.assert_called_once_with(['ss'], timeout=30)


class ProbeStartupGuard(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.candidate = self.root / 'candidate'; self.candidate.mkdir()
        self.proc = self.root / 'proc'; (self.proc / '321/ns').mkdir(parents=True)
        self.cwd = self.proc / '321/cwd'; self.cwd.symlink_to(self.candidate)
        (self.proc / '321/ns/net').write_text('synthetic namespace inode')
        self.host_net = self.root / 'host-net'; self.host_net.write_text('different inode')

    def path(self, value):
        return self.proc if value == '/proc' else self.host_net if value == '/proc/self/ns/net' else Path(value)

    def verify(self, state='active', pid='321', expected=None, links=None, routes=None):
        output = f'ActiveState={state}\nMainPID={pid}\n'
        links = [{'ifname': 'lo'}] if links is None else links
        routes = [[], []] if routes is None else routes
        with patch.object(deploy, 'command', return_value=output), patch.object(deploy, 'Path', side_effect=self.path), \
                patch.object(deploy, 'network_command', side_effect=[json.dumps(links), *map(json.dumps, routes)]) as network:
            if expected is None:
                self.assertEqual(deploy.verify_private_network('synthetic.service', self.candidate), 321)
                self.assertEqual(network.call_count, 3)
            else:
                with self.assertRaises(ValueError) as caught:
                    deploy.verify_private_network('synthetic.service', self.candidate)
                report = deploy.RehearsalReport(); report.fail(caught.exception)
                self.assertEqual(report.failure['error'], expected)
                if expected not in ('PROBE_SHARED_NETWORK', 'PROBE_EXTERNAL_LINKS', 'PROBE_EXTERNAL_ROUTES'):
                    network.assert_not_called()

    def test_terminal_state_is_not_confused_with_startup_pending(self):
        for state in ('inactive', 'failed'):
            with self.subTest(state=state):
                self.verify(state=state, pid='0', expected='PROBE_TERMINAL_STATE')
        self.verify(state='deactivating', pid='0', expected='PROBE_PROCESS_STOPPING')
        self.verify(state='activating', pid='0', expected='PROBE_STARTUP_PENDING')
        self.verify(state='unknown', expected='PROBE_STATE_UNSUPPORTED')

    def test_active_state_still_requires_valid_pid_and_exact_available_cwd(self):
        for pid in ('0', '1'):
            with self.subTest(pid=pid): self.verify(pid=pid, expected='PROBE_PID_UNAVAILABLE')
        self.cwd.unlink(); self.verify(expected='PROBE_CWD_UNAVAILABLE')
        self.cwd.symlink_to(self.root); self.verify(expected='PROBE_CWD_MISMATCH')

    def test_fork_return_before_cwd_setup_fails_then_completed_setup_passes(self):
        # Models the documented Type=simple ordering, not a live systemd run.
        # The exact same process can fail before setup and pass after setup.
        self.cwd.unlink(); self.cwd.symlink_to(self.root)
        self.verify(expected='PROBE_CWD_MISMATCH')
        self.cwd.unlink(); self.cwd.symlink_to(self.candidate)
        self.verify()

    def test_setup_barrier_does_not_replace_private_network_checks(self):
        self.verify(links=[{'ifname': 'lo'}, {'ifname': 'eth0'}], expected='PROBE_EXTERNAL_LINKS')
        self.verify(routes=[[{'dev': 'eth0', 'dst': 'default'}], []], expected='PROBE_EXTERNAL_ROUTES')
        net = self.proc / '321/ns/net'; net.unlink(); os.link(self.host_net, net)
        self.verify(expected='PROBE_SHARED_NETWORK')


class IsolatedEntrypoint(unittest.TestCase):
    def test_workflow_streams_reviewed_source_with_all_existing_arguments(self):
        root = Path(__file__).resolve().parents[1]
        workflow = (root / '.github/workflows/production-deploy.yml').read_text()
        launch = next(line.strip() for line in workflow.splitlines() if 'python3 -I -B -' in line)
        words = shlex.split(launch)
        self.assertEqual(words[:3], ['tailscale', 'ssh', 'root@hermes'])
        self.assertEqual(words[4:], ['<', 'ops/deploy-preserving.py'])
        remote = shlex.split(words[3])
        self.assertEqual(remote, ['python3', '-I', '-B', '-', '--candidate', '$RELEASE_DIR',
                                 '--sha', '$TARGET_SHA', '--expected-live', '$EXPECTED_LIVE',
                                 '--backup-sha256', '$BACKUP_SHA', '--receipt-run', '$RECEIPT_RUN',
                                 '--store-sha', '$BACKUP_STORE_SHA', '--store-id', '$BACKUP_STORE_ID'])
        self.assertNotIn("python3 -B '$RELEASE_DIR/ops/deploy-preserving.py'", workflow)
        self.assertNotIn('__file__', (root / 'ops/deploy-preserving.py').read_text())

    def test_isolated_stdin_engine_ignores_cwd_and_pythonpath_shadow_modules(self):
        source = (Path(__file__).resolve().parents[1] / 'ops/deploy-preserving.py').read_text()
        args = ['--candidate', '/home/ubuntu/bubblewash-releases/20261022T000000Z-' + 'a' * 12,
                '--sha', 'a' * 40, '--expected-live', 'b' * 40, '--backup-sha256', 'c' * 64,
                '--receipt-run', '99', '--store-sha', 'd' * 40, '--store-id', '12']
        # Define the real engine without executing its host main, then inspect argv.
        harness = "__name__ = 'isolated_entrypoint_test'\n" + source + "\nimport sys\nprint(json.dumps({'argv': sys.argv, 'engine': callable(main), 'isolated': sys.flags.isolated}))\n"
        with tempfile.TemporaryDirectory() as directory:
            for name in ('argparse', 'json', 'pathlib', 'pwd', 'sqlite3'):
                (Path(directory) / (name + '.py')).write_text("raise RuntimeError('application-owned shadow module executed')\n")
            result = subprocess.run([sys.executable, '-I', '-B', '-', *args], input=harness, text=True,
                                    capture_output=True, check=True, cwd=directory,
                                    env={**os.environ, 'PYTHONPATH': directory}, timeout=10)
            self.assertEqual(json.loads(result.stdout), {'argv': ['-', *args], 'engine': True, 'isolated': 1})
            self.assertFalse((Path(directory) / '__pycache__').exists())


class ReleaseSafety(unittest.TestCase):
    def test_public_health_requires_expected_json_and_exact_200(self):
        good = '{"ok":true,"service":"Bubble Wash","status":"alive"}'
        with patch.object(deploy, 'command', return_value=good + '\n200') as call:
            deploy.public_health()
            self.assertNotIn('--location', call.call_args.args[0])
            self.assertIn('https://bubblewash.co/api/health', call.call_args.args[0])
        for result in (good + '\n301', good + '\n503', '{}\n200', '[]\n200', '<html>edge</html>\n200'):
            with self.subTest(result=result), patch.object(deploy, 'command', return_value=result), self.assertRaises(ValueError):
                deploy.public_health()

    def test_public_failure_rolls_back_before_candidate_marker_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); previous = root / 'old'; candidate = root / 'new'
            previous.mkdir(); candidate.mkdir(); current = root / 'current'; current.symlink_to(previous)
            marker = root / 'marker'; marker.write_text('old')
            validated = []
            def validate(target):
                validated.append(target)
                if target == candidate:
                    deploy.public_health()
                    marker.write_text('new')
                else:
                    self.assertEqual(current.resolve(), previous)
                    self.assertEqual(marker.read_text(), 'old')
            with patch.object(deploy, 'command', return_value='{}\n503'), self.assertRaises(ValueError):
                deploy.activate(current, candidate, lambda *_: None, validate)
            self.assertEqual(current.resolve(), previous)
            self.assertEqual(marker.read_text(), 'old')
            self.assertEqual(validated, [candidate, previous])
        source = (Path(__file__).resolve().parents[1] / 'ops/deploy-preserving.py').read_text()
        validation = source.split('    def validate(target):', 1)[1].split('    unchanged()', 1)[0]
        self.assertIn('public_health()', validation)
        self.assertNotIn('Verify public liveness', (Path(__file__).resolve().parents[1] / '.github/workflows/production-deploy.yml').read_text())

    def test_existing_shared_lock_contends_without_modifying_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); lock = root / 'deploy.lock'; lock.write_text('unchanged')
            with deploy.deployment_lock(root, os.getuid()) as unchanged:
                unchanged()
                with self.assertRaises(BlockingIOError):
                    with deploy.deployment_lock(root, os.getuid()): pass
            self.assertEqual(lock.read_text(), 'unchanged')

    def test_lock_rejects_symlink_fifo_hardlink_missing_and_unsafe_modes(self):
        for kind in ('symlink', 'fifo', 'hardlink', 'missing', 'worldwrite', 'groupwrite'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); lock = root / 'deploy.lock'; target = root / 'target'; target.write_text('intact')
                if kind == 'symlink': lock.symlink_to(target)
                elif kind == 'fifo': os.mkfifo(lock)
                elif kind == 'hardlink': os.link(target, lock)
                elif kind != 'missing': lock.write_text(''); lock.chmod(0o666 if kind == 'worldwrite' else 0o660)
                with self.assertRaises((ValueError, OSError)):
                    with deploy.deployment_lock(root, os.getuid()): pass
                self.assertEqual(target.read_text(), 'intact')

    def test_lock_detects_inode_directory_or_metadata_replacement(self):
        for kind in ('inode', 'directory', 'mode'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory) / 'runtime'; root.mkdir(); lock = root / 'deploy.lock'; lock.touch()
                with deploy.deployment_lock(root, os.getuid()) as unchanged:
                    if kind == 'inode': lock.unlink(); lock.touch()
                    elif kind == 'directory': root.rename(root.with_name('old')); root.mkdir(); (root / 'deploy.lock').touch()
                    else: lock.chmod(0o666)
                    with self.assertRaises(ValueError): unchanged()

    def test_source_manifest_rejects_changed_added_removed_and_symlink_files(self):
        for kind in ('changed', 'added', 'removed', 'symlink', 'directory_symlink', 'package'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); (root / 'src').mkdir(); file = root / 'src/example.ts'; file.write_text('old')
                (root / 'package.json').write_text('{}'); (root / 'package-lock.json').write_text('{}')
                (root / 'next.config.mjs').write_text('{}'); (root / 'tsconfig.json').write_text('{}')
                expected = deploy.source_manifest(root)
                with patch.object(deploy, 'LIVE_SOURCE_SHA256', expected), patch.object(deploy, 'CANDIDATE_SOURCE_SHA256', expected):
                    deploy.verify_source_transition(root, root)
                    if kind == 'changed': file.write_text('new')
                    elif kind == 'added': (root / 'src/new.ts').write_text('new')
                    elif kind == 'removed': file.unlink()
                    elif kind == 'symlink': file.unlink(); file.symlink_to(root / 'package.json')
                    elif kind == 'directory_symlink': (root / 'src/link').symlink_to(root, target_is_directory=True)
                    else: (root / 'package.json').write_text('{"changed":true}')
                    with self.assertRaises(ValueError): deploy.verify_source_transition(root, root)



class ReviewedReaderTransition(unittest.TestCase):
    def test_exact_pair_and_unchanged_critical_files_only(self):
        with tempfile.TemporaryDirectory() as directory:
            current = Path(directory) / 'old'; candidate = Path(directory) / 'new'
            for root in (current, candidate):
                for relative in deploy.CRITICAL_FILES:
                    file = root / relative; file.parent.mkdir(parents=True, exist_ok=True); file.write_text('old')
            changed = 'src/lib/data-store.ts'
            (candidate / changed).write_text('reviewed')
            pins = {changed: (deploy.digest(current / changed), deploy.digest(candidate / changed))}
            with patch.object(deploy, 'REVIEWED_READER_TRANSITIONS', pins):
                deploy.verify_critical_transition(current, candidate)
                for relative in deploy.CRITICAL_FILES:
                    for root in (current, candidate):
                        file = root / relative; previous = file.read_bytes(); file.write_text('unreviewed')
                        with self.assertRaises(ValueError): deploy.verify_critical_transition(current, candidate)
                        file.write_bytes(previous)
                (candidate / changed).write_text('old')
                with self.assertRaises(ValueError): deploy.verify_critical_transition(current, candidate)


class ExactCi(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('ci', Path(__file__).resolve().parents[1] / 'ops/check-release-ci.py')
        self.ci = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.ci)
        self.sha = '4d2bf0e13426a526f0184394a4604f14af17bb60'
        # Safe fields from the actual repository collection observed 2026-10-22.
        # Includes unrelated failed Deploy/Preflight runs; these cannot qualify as CI.
        self.fixture = json.loads(r"""{
  "total_count": 6,
  "workflow_runs": [
    {
      "id": 39810914857,
      "name": "Production Deploy",
      "head_sha": "4d2bf0e13426a526f0184394a4604f14af17bb60",
      "head_branch": "main",
      "path": ".github/workflows/production-deploy.yml",
      "event": "workflow_dispatch",
      "status": "completed",
      "conclusion": "failure",
      "run_number": 88,
      "run_attempt": 1,
      "head_repository": {
        "id": 1253289367,
        "full_name": "bechirobob/bubble-wash"
      }
    },
    {
      "id": 39809844095,
      "name": "Read-only Release Preflight",
      "head_sha": "4d2bf0e13426a526f0184394a4604f14af17bb60",
      "head_branch": "main",
      "path": ".github/workflows/release-preflight.yml",
      "event": "workflow_dispatch",
      "status": "completed",
      "conclusion": "failure",
      "run_number": 7,
      "run_attempt": 1,
      "head_repository": {
        "id": 1253289367,
        "full_name": "bechirobob/bubble-wash"
      }
    },
    {
      "id": 39808444351,
      "name": "Pilot CI",
      "head_sha": "4d2bf0e13426a526f0184394a4604f14af17bb60",
      "head_branch": "main",
      "path": ".github/workflows/pilot-ci.yml",
      "event": "push",
      "status": "completed",
      "conclusion": "success",
      "run_number": 206,
      "run_attempt": 1,
      "head_repository": {
        "id": 1253289367,
        "full_name": "bechirobob/bubble-wash"
      }
    },
    {
      "id": 39808444734,
      "name": "Verify encrypted backup transport",
      "head_sha": "4d2bf0e13426a526f0184394a4604f14af17bb60",
      "head_branch": "main",
      "path": ".github/workflows/backup-transport-checks.yml",
      "event": "push",
      "status": "completed",
      "conclusion": "success",
      "run_number": 32,
      "run_attempt": 1,
      "head_repository": {
        "id": 1253289367,
        "full_name": "bechirobob/bubble-wash"
      }
    },
    {
      "id": 39808444395,
      "name": "Read-only Release Preflight",
      "head_sha": "4d2bf0e13426a526f0184394a4604f14af17bb60",
      "head_branch": "main",
      "path": ".github/workflows/release-preflight.yml",
      "event": "push",
      "status": "completed",
      "conclusion": "success",
      "run_number": 6,
      "run_attempt": 1,
      "head_repository": {
        "id": 1253289367,
        "full_name": "bechirobob/bubble-wash"
      }
    },
    {
      "id": 39808444405,
      "name": "Browser workflow regression",
      "head_sha": "4d2bf0e13426a526f0184394a4604f14af17bb60",
      "head_branch": "main",
      "path": ".github/workflows/browser-regression.yml",
      "event": "push",
      "status": "completed",
      "conclusion": "success",
      "run_number": 21,
      "run_attempt": 1,
      "head_repository": {
        "id": 1253289367,
        "full_name": "bechirobob/bubble-wash"
      }
    }
  ]
}
""")

    def response(self, url):
        self.assertEqual(url, f'https://api.github.com/repos/bechirobob/bubble-wash/actions/runs?head_sha={self.sha}&per_page=100&page=1')
        return copy.deepcopy(self.fixture)

    def pilot(self, data):
        return next(run for run in data['workflow_runs'] if run['path'] == '.github/workflows/pilot-ci.yml')

    def paginated(self, first, second, total=None):
        pages = [first, second]
        count = len(first) + len(second) if total is None else total
        calls = []
        def fetch(url):
            page = int(url.rsplit('&page=', 1)[1])
            calls.append(page)
            self.assertEqual(page, len(calls))
            return {'total_count': count, 'workflow_runs': copy.deepcopy(pages[page - 1])}
        return fetch, calls

    def noise(self, count):
        template = self.fixture['workflow_runs'][0]
        return [dict(copy.deepcopy(template), id=1000 + i) for i in range(count)]

    def test_actual_repository_metadata_passes_all_exact_main_checks(self):
        self.ci.check(self.sha, self.response)
        with self.assertRaises(ValueError): self.ci.check('main', self.response)

    def test_empty_listing_and_each_missing_required_workflow_fail(self):
        with self.assertRaises(ValueError):
            self.ci.check(self.sha, lambda _: {'total_count': 0, 'workflow_runs': []})
        for workflow in ('pilot-ci.yml', 'browser-regression.yml', 'backup-transport-checks.yml'):
            data = copy.deepcopy(self.fixture)
            data['workflow_runs'] = [run for run in data['workflow_runs'] if run['path'] != '.github/workflows/' + workflow]
            data['total_count'] -= 1
            with self.subTest(workflow=workflow), self.assertRaises(ValueError):
                self.ci.check(self.sha, lambda _: data)

    def test_rejects_old_sha_other_branch_fork_wrong_workflow_and_pr(self):
        for key, value in [('head_sha', 'b' * 40), ('head_branch', 'other'),
                           ('head_repository', {'full_name': 'fork/repo'}), ('event', 'pull_request'),
                           ('path', '.github/workflows/unrelated.yml')]:
            data = copy.deepcopy(self.fixture)
            self.pilot(data)[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.ci.check(self.sha, lambda _: data)

    def test_pending_failed_cancelled_or_skipped_required_run_fails(self):
        for status, conclusion in [('queued', None), ('in_progress', None), ('completed', 'failure'),
                                   ('completed', 'cancelled'), ('completed', 'skipped')]:
            data = copy.deepcopy(self.fixture)
            self.pilot(data).update(status=status, conclusion=conclusion)
            with self.subTest(status=status, conclusion=conclusion), self.assertRaises(ValueError):
                self.ci.check(self.sha, lambda _: data)

    def test_newer_failure_cannot_hide_behind_older_success(self):
        data = copy.deepcopy(self.fixture)
        failed = dict(self.pilot(data), id=999999, run_number=207, conclusion='failure')
        data['workflow_runs'].append(failed)
        data['total_count'] += 1
        with self.assertRaises(ValueError): self.ci.check(self.sha, lambda _: data)

    def test_distinct_ids_with_equal_ordering_fail_closed(self):
        data = copy.deepcopy(self.fixture)
        data['workflow_runs'].append(dict(self.pilot(data), id=999999, conclusion='failure'))
        data['total_count'] += 1
        with self.assertRaises(ValueError): self.ci.check(self.sha, lambda _: data)

    def test_latest_rerun_attempt_must_pass(self):
        data = copy.deepcopy(self.fixture)
        self.pilot(data).update(run_attempt=2, conclusion='failure')
        with self.assertRaises(ValueError): self.ci.check(self.sha, lambda _: data)

    def test_invalid_latest_identity_cannot_hide_behind_older_success(self):
        for change in ({'head_branch': 'other'}, {'head_repository': {'full_name': 'fork/repo'}}):
            data = copy.deepcopy(self.fixture)
            latest = dict(self.pilot(data), id=999999, run_number=207, **change)
            data['workflow_runs'].append(latest); data['total_count'] += 1
            with self.assertRaises(ValueError): self.ci.check(self.sha, lambda _: data)

    def test_required_checks_on_second_page_are_found(self):
        fetch, calls = self.paginated(self.noise(100), self.fixture['workflow_runs'])
        self.ci.check(self.sha, fetch)
        self.assertEqual(calls, [1, 2])

    def test_pagination_does_not_stop_when_first_page_has_all_successes(self):
        first = self.fixture['workflow_runs'] + self.noise(94)
        failed = dict(self.pilot(self.fixture), id=999999, run_number=207, conclusion='failure')
        fetch, calls = self.paginated(first, [failed])
        with self.assertRaises(ValueError): self.ci.check(self.sha, fetch)
        self.assertEqual(calls, [1, 2])

    def test_incomplete_or_malformed_listing_fails_closed(self):
        for data in ({}, {'workflow_runs': []}, {'total_count': True, 'workflow_runs': []},
                     {'total_count': -1, 'workflow_runs': []}, {'total_count': 1001, 'workflow_runs': []},
                     {'total_count': 6, 'workflow_runs': self.fixture['workflow_runs'][:-1]},
                     {'total_count': 5, 'workflow_runs': self.fixture['workflow_runs']},
                     {'total_count': 1, 'workflow_runs': [None]}):
            with self.subTest(data=data), self.assertRaises(ValueError): self.ci.check(self.sha, lambda _: data)

    def test_empty_truncated_second_page_fails_closed(self):
        fetch, calls = self.paginated(self.noise(100), [], total=101)
        with self.assertRaises(ValueError): self.ci.check(self.sha, fetch)
        self.assertEqual(calls, [1, 2])

    def test_count_drift_duplicate_ids_and_fetch_failure_fail_closed(self):
        first = self.noise(100)
        for mode in ('count', 'duplicate', 'network'):
            def fetch(url):
                if url.endswith('&page=1'): return {'total_count': 106, 'workflow_runs': first}
                if mode == 'network': raise OSError('fixture transport failure')
                return {'total_count': 107 if mode == 'count' else 106,
                        'workflow_runs': [first[0], *self.fixture['workflow_runs'][:5]] if mode == 'duplicate' else self.fixture['workflow_runs']}
            with self.subTest(mode=mode), self.assertRaises((ValueError, OSError)):
                self.ci.check(self.sha, fetch)

    def test_malformed_newer_failure_cannot_be_filtered_out(self):
        for field in ('head_sha', 'head_branch', 'path', 'event', 'status', 'head_repository',
                      'run_number', 'run_attempt', 'conclusion'):
            for mutation in ('missing', 'null', 'wrong_type'):
                if field == 'conclusion' and mutation == 'null': continue  # pending run convention
                data = copy.deepcopy(self.fixture)
                newer = dict(self.pilot(data), id=999999, run_number=207, conclusion='failure')
                if mutation == 'missing': newer.pop(field)
                else: newer[field] = None if mutation == 'null' else []
                data['workflow_runs'].append(newer); data['total_count'] += 1
                with self.subTest(field=field, mutation=mutation), self.assertRaises(ValueError):
                    self.ci.check(self.sha, lambda _: data)

    def test_ordering_fields_must_be_positive_integers(self):
        for key, value in [('run_number', 0), ('run_number', '207'), ('run_attempt', None), ('run_attempt', True)]:
            data = copy.deepcopy(self.fixture); self.pilot(data)[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                self.ci.check(self.sha, lambda _: data)

    def test_sandbox_and_schema_guards_present(self):
        source = (Path(__file__).resolve().parents[1] / 'ops/deploy-preserving.py').read_text()
        for name in ('data-store', 'operational-store', 'availability-store', 'staff-accounts'):
            self.assertIn('src/lib/' + name + '.ts', source)
        for guard in ('ProtectSystem=strict', 'ProtectHome=tmpfs', 'BindReadOnlyPaths=',
                      'NoNewPrivileges=true', 'StandardError=null', 'PrivateNetwork=true'):
            self.assertIn(guard, source)





class RehearsalOnly(unittest.TestCase):
    """Synthetic host only: no services, credentials, network, or external writes."""
    def setUp(self):
        from types import SimpleNamespace
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runtime = self.root / 'bubblewash-runtime'; self.runtime.mkdir()
        self.releases = self.root / 'bubblewash-releases'; self.releases.mkdir()
        self.old_sha = 'a' * 40; self.sha = 'b' * 40
        self.old = self.releases / ('20261022T190000Z-' + self.old_sha[:12]); self.old.mkdir()
        self.candidate = self.releases / ('20261022T200000Z-' + self.sha[:12]); self.candidate.mkdir()
        for release in (self.old, self.candidate):
            (release / '.next').mkdir(); (release / '.next/BUILD_ID').write_text('synthetic-build')
            for name in ('src/lib/data-store.ts', 'src/lib/operational-store.ts',
                         'src/lib/availability-store.ts', 'src/lib/staff-accounts.ts', 'src/app/api/health/route.ts'):
                path = release / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('identical synthetic source')
        (self.candidate / '.release-sha').write_text(self.sha)
        self.current = self.root / 'bubblewash-pilot'; self.current.symlink_to(self.old)
        (self.runtime / 'current-release').write_text(f'sha={self.old_sha}\npath={self.old}\n')
        self.db = self.root / 'live.sqlite'
        self.live = sqlite3.connect(self.db); self.addCleanup(self.live.close)
        self.live.execute('PRAGMA journal_mode=WAL')
        self.live.execute('CREATE TABLE synthetic(id INTEGER PRIMARY KEY, value TEXT)')
        self.live.execute("INSERT INTO synthetic VALUES(1, 'DO_NOT_PRINT_DATABASE_CONTENT')"); self.live.commit()
        self.before = deploy.database_fingerprint(self.db)
        self.status = self.root / 'status.json'
        self.archive = self.root / 'bubblewash-2026-10-22T09:00:00.sqlite.enc'; self.archive.write_bytes(b'synthetic encrypted archive')
        sha256 = deploy.digest(self.archive)
        stamp = deploy.dt.datetime.now(deploy.dt.timezone.utc).isoformat()
        status = dict(ok=True, filename=self.archive.name, sha256=sha256, createdAt=stamp,
                      restoreVerifiedAt=stamp, offsiteStoredAt=stamp)
        self.status.write_text(json.dumps(status))
        receipt = dict(schema='becore-encrypted-backup-release/v2', repository='bechirobob/bubble-wash',
                       storageRepository='bechirobob/becore-backups', storage='private-github-release',
                       storageSha='c' * 40, storageRepositoryId=12, runId='99', encrypted=True,
                       restoreTested=True, downloadVerified=True, automaticExpiry=False, retentionDays=None,
                       filename=self.archive.name, sha256=sha256, sourceSha=self.old_sha,
                       size=self.archive.stat().st_size, verifiedAt=stamp)
        self.receipt = self.root / 'receipt.json'; self.receipt.write_text(json.dumps(receipt))
        self.env = self.root / 'env'
        self.env.write_text(f'NODE_ENV=production\nBUBBLEWASH_DISABLE_DEMO_LOGIN=true\n'
                            f'BUBBLEWASH_STAFF_AUTH_DISABLED=false\nBUBBLEWASH_BOOKINGS_DISABLED=true\n'
                            f'BUBBLEWASH_DATABASE_PATH={self.db}\nBUBBLEWASH_BACKUP_STATUS_PATH={self.status}\n'
                            f'BUBBLEWASH_BACKUP_OFFSITE_DIR={self.root}\nSECRET=DO_NOT_PRINT_CONFIGURATION\n')
        self.args = ['deploy-preserving.py', '--rehearsal-only', '--run-id', '123', '--run-attempt', '1',
                     '--candidate', str(self.candidate), '--sha', self.sha, '--expected-live', self.old_sha,
                     '--backup-sha256', sha256, '--receipt-run', '99', '--store-sha', 'c' * 40, '--store-id', '12']
        self.owner = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        self.commands = []
        self.routes = []
        self.stages = []
        self.snapshot = None
        self.started = False
        self.stopped = False
        self.fail_stage = None
        self.fail_error = ValueError('DO_NOT_PRINT_EXCEPTION')
        self.bad_stop = False
        self.launch_timeout = False
        self.final_probe_pid = 321
        self.mutate_copy = False
        self.change_env = False
        self.ready_error = False
        self.diagnostic_result = None
        self.diagnostic_error = None
        self.original_marker = (self.runtime / 'current-release').read_bytes()

    def stage(self, report, stage):
        if report is not None:
            report.stage = stage
        self.stages.append(stage)
        if stage == self.fail_stage:
            raise self.fail_error

    def command(self, args, timeout=30):
        self.commands.append(args)
        if args[0] == 'systemd-run':
            self.assertNotIn('--wait', args, 'no build allowed')
            self.assertIn('--property=PrivateNetwork=true', args)
            self.assertIn('--property=KillMode=control-group', args)
            self.assertEqual(args.count('--property=Type=exec'), 1)
            self.assertIn('--property=ProtectHome=tmpfs', args)
            self.assertIn('--property=ProtectSystem=strict', args)
            self.assertIn('--property=StandardOutput=null', args)
            self.assertIn('--property=StandardError=null', args)
            self.assertIn('--property=BindReadOnlyPaths=' + str(self.candidate) + ' ' + str(self.status), args)
            self.snapshot = Path(next(arg.split('=', 1)[1] for arg in args if arg.startswith('BUBBLEWASH_DATABASE_PATH=')))
            self.assertNotEqual(self.snapshot, self.db)
            with sqlite3.connect(self.snapshot) as copied:
                self.assertEqual(copied.execute('SELECT count(*) FROM synthetic').fetchone(), (1,))
                if self.mutate_copy:
                    copied.execute('DELETE FROM synthetic')
            if self.launch_timeout:
                raise subprocess.TimeoutExpired('DO_NOT_PRINT_COMMAND', 30, output=b'DO_NOT_PRINT_OUTPUT')
            self.started = True
            return ''
        self.assertEqual(args, ['systemctl', 'stop', 'bubblewash-rehearsal-123-1-probe.service'])
        if self.bad_stop:
            raise subprocess.CalledProcessError(1, args, output=b'DO_NOT_PRINT_COMMAND_OUTPUT')
        self.stopped = True
        return ''

    def state(self, unit):
        self.assertEqual(unit, 'bubblewash-rehearsal-123-1-probe.service')
        return ({'LoadState': 'loaded', 'ActiveState': 'active', 'MainPID': '321'} if self.started and not self.stopped else
                {'LoadState': 'not-found', 'ActiveState': 'inactive', 'MainPID': '0'})

    def network(self, args, pid=None, timeout=30):
        self.assertEqual(pid, 321)
        self.assertEqual(args[0], 'curl')
        self.routes.append(args[-1])
        if self.ready_error and args[-1].endswith('/api/ready'):
            raise subprocess.CalledProcessError(22, 'DO_NOT_PRINT_COMMAND', output=b'DO_NOT_PRINT_BODY')
        if self.change_env:
            self.env.write_text(self.env.read_text() + 'CHANGED=true\n'); self.change_env = False
        return ''

    def run_rehearsal(self):
        import contextlib
        import io
        report = deploy.RehearsalReport()
        output = io.StringIO()
        with contextlib.ExitStack() as stack:
            for name, value in [('HOME', self.root), ('CURRENT', self.current), ('ENV', self.env),
                                ('RUNTIME', self.runtime), ('RECEIPT', self.receipt)]:
                stack.enter_context(patch.object(deploy, name, value))
            stack.enter_context(patch.object(sys, 'argv', self.args))
            stack.enter_context(patch.object(deploy.os, 'geteuid', return_value=0))
            stack.enter_context(patch.object(deploy.pwd, 'getpwnam', return_value=self.owner))
            stack.enter_context(patch.object(deploy, 'verify_source_transition'))
            stack.enter_context(patch.object(deploy, 'REVIEWED_READER_TRANSITIONS', {}))
            stack.enter_context(patch.object(deploy, 'check_runtime'))
            stack.enter_context(patch.object(deploy, 'health'))
            stack.enter_context(patch.object(deploy, 'verify_private_network', side_effect=[321, self.final_probe_pid]))
            stack.enter_context(patch.object(deploy, 'command', side_effect=self.command))
            stack.enter_context(patch.object(deploy, 'network_command', side_effect=self.network))
            stack.enter_context(patch.object(deploy, 'probe_state', side_effect=self.state))
            diagnostic = stack.enter_context(patch.object(deploy, 'readiness_diagnostic', return_value=self.diagnostic_result, side_effect=self.diagnostic_error))
            stack.enter_context(patch.object(deploy, 'rehearsal_stage', side_effect=self.stage))
            stack.enter_context(patch.object(deploy.signal, 'setitimer'))
            for name in ('activate', 'ctl', 'public_health'):
                stack.enter_context(patch.object(deploy, name, side_effect=AssertionError('forbidden production action')))
            stack.enter_context(patch.object(deploy.os, 'replace', side_effect=AssertionError('forbidden marker/pointer write')))
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                try:
                    deploy.main(lambda: None, report)
                except BaseException as error:
                    report.fail(error)
                report.emit()
        self.diagnostic_calls = diagnostic.call_count
        text = output.getvalue()
        for sentinel in ('DO_NOT_PRINT', str(self.db), str(self.env), str(self.root)):
            self.assertNotIn(sentinel, text)
        self.assertEqual(deploy.database_fingerprint(self.db), self.before)
        self.assertEqual(self.current.resolve(), self.old)
        self.assertEqual((self.runtime / 'current-release').read_bytes(), self.original_marker)
        return json.loads(text)

    def test_success_has_no_activation_and_removes_only_disposable_copy(self):
        sibling = self.runtime / 'unrelated'; sibling.mkdir(); (sibling / 'keep').write_text('keep')
        result = self.run_rehearsal()
        self.assertTrue(result['ok']); self.assertTrue(result['cleanup']); self.assertFalse(result['activationAttempted'])
        self.assertTrue(self.stopped); self.assertFalse(self.snapshot.parent.exists())
        self.assertTrue((sibling / 'keep').is_file())
        self.assertEqual(len(self.routes), 7)
        self.assertEqual(self.routes[-1], 'http://127.0.0.1:3001/api/ready')
        self.assertEqual(len([cmd for cmd in self.commands if cmd[0] == 'systemd-run']), 1)

    def test_ready_failure_adds_categories_but_remains_fatal_and_cleans_up(self):
        self.ready_error = True
        self.diagnostic_result = {'state': 'BLOCKED', 'http': 'HTTP_503', 'categories': ['DB_CHECK']}
        result = self.run_rehearsal()
        self.assertEqual(result['stage'], 'ROUTE_READY')
        self.assertEqual(result['error'], 'COMMAND_FAILED')
        self.assertEqual(result['readinessDiagnostic'], self.diagnostic_result)
        self.assertEqual(self.diagnostic_calls, 1)
        self.assertFalse(result['ok']); self.assertFalse(result['activationAttempted'])
        self.assertTrue(result['cleanup']); self.assertTrue(self.stopped)
        self.assertFalse(self.snapshot.parent.exists())

    def test_ready_after_anonymous_failure_never_forgives_failure(self):
        self.ready_error = True
        self.diagnostic_result = {'state': 'READY', 'http': 'HTTP_200', 'categories': []}
        result = self.run_rehearsal()
        self.assertFalse(result['ok']); self.assertEqual(result['error'], 'COMMAND_FAILED')
        self.assertTrue(result['cleanup']); self.assertEqual(self.diagnostic_calls, 1)

    def test_diagnostic_exception_or_cancellation_keeps_primary_failure_and_cleanup(self):
        self.ready_error = True
        for error in (RuntimeError('DO_NOT_PRINT'), deploy.RehearsalDeadline(), deploy.RehearsalInterrupted()):
            self.started = self.stopped = False; self.diagnostic_error = error
            result = self.run_rehearsal()
            self.assertEqual(result['stage'], 'ROUTE_READY'); self.assertEqual(result['error'], 'COMMAND_FAILED')
            self.assertTrue(result['cleanup']); self.assertTrue(self.stopped)
            self.assertFalse(result['activationAttempted']); self.assertEqual(self.diagnostic_calls, 1)

    def test_non_ready_failure_and_success_never_collect_detail(self):
        result = self.run_rehearsal()
        self.assertNotIn('readinessDiagnostic', result); self.assertEqual(self.diagnostic_calls, 0)
        self.fail_stage = 'ROUTE_HOME'; self.started = self.stopped = False
        result = self.run_rehearsal()
        self.assertNotIn('readinessDiagnostic', result); self.assertEqual(self.diagnostic_calls, 0)

    def test_each_boundary_fails_without_activation_or_sensitive_output(self):
        stages = ('BUILD_ARTIFACT', 'PROBE_ABSENT', 'SNAPSHOT', 'FINGERPRINT_BEFORE', 'PROBE_START',
                  'NAMESPACE_BEFORE', 'HEALTH', 'RUNTIME_BEFORE', 'ROUTE_HOME', 'ROUTE_SERVICES',
                  'ROUTE_BOOK', 'ROUTE_TRACK', 'ROUTE_MANAGE', 'ROUTE_EARLY_ACCESS', 'ROUTE_READY',
                  'RUNTIME_AFTER', 'NAMESPACE_AFTER', 'PROBE_STOP', 'FINGERPRINT_AFTER', 'CLEANUP', 'UNCHANGED')
        for stage in stages:
            with self.subTest(stage=stage):
                self.started = self.stopped = False; self.fail_stage = stage
                result = self.run_rehearsal()
                self.assertFalse(result['ok']); self.assertEqual(result['stage'], stage)
                self.assertFalse(result['activationAttempted'])
                if stage not in ('PROBE_STOP', 'CLEANUP'):
                    self.assertTrue(result['cleanup'])

    def test_unknown_probe_stop_retains_private_copy_and_primary_error(self):
        self.fail_stage = 'ROUTE_READY'; self.bad_stop = True
        result = self.run_rehearsal()
        self.assertEqual(result['stage'], 'ROUTE_READY'); self.assertFalse(result['cleanup'])
        self.assertTrue(self.snapshot.is_file())
        self.assertEqual(self.snapshot.parent.stat().st_mode & 0o777, 0o700)

    def test_uncertain_launch_failed_stop_and_absent_unit_retain_snapshot(self):
        self.launch_timeout = self.bad_stop = True
        result = self.run_rehearsal()
        self.assertEqual(result['stage'], 'PROBE_START'); self.assertEqual(result['error'], 'TIMEOUT')
        self.assertFalse(result['cleanup']); self.assertTrue(self.snapshot.is_file())
        self.assertFalse(self.started); self.assertFalse(self.stopped)

    def test_timeout_and_cancellation_cleanup_and_codes(self):
        for error, expected in [(TimeoutError('DO_NOT_PRINT_TIMEOUT'), 'TIMEOUT'),
                                (KeyboardInterrupt('DO_NOT_PRINT_INTERRUPT'), 'INTERRUPTED'),
                                (deploy.RehearsalDeadline(), 'TIMEOUT'),
                                (deploy.RehearsalInterrupted(), 'INTERRUPTED')]:
            with self.subTest(expected=expected):
                self.started = self.stopped = False; self.fail_stage = 'HEALTH'; self.fail_error = error
                result = self.run_rehearsal()
                self.assertEqual(result['error'], expected); self.assertTrue(result['cleanup']); self.assertTrue(self.stopped)

    def test_snapshot_change_is_detected_without_source_change(self):
        self.mutate_copy = True
        result = self.run_rehearsal()
        self.assertFalse(result['ok']); self.assertEqual(result['stage'], 'FINGERPRINT_AFTER')
        self.assertEqual(result['error'], 'FINGERPRINT_MUTATION')
        self.assertTrue(result['cleanup'])

    def test_environment_drift_aborts_after_rehearsal_without_activation(self):
        self.change_env = True
        result = self.run_rehearsal()
        self.assertFalse(result['ok']); self.assertEqual(result['stage'], 'UNCHANGED'); self.assertTrue(result['cleanup'])

    def test_final_namespace_revalidation_rejects_changed_process_without_retry(self):
        self.final_probe_pid = 322
        result = self.run_rehearsal()
        self.assertEqual(result['stage'], 'NAMESPACE_AFTER')
        self.assertEqual(result['error'], 'PROBE_NAMESPACE_CHANGED')
        self.assertFalse(result['ok']); self.assertTrue(result['cleanup']); self.assertTrue(self.stopped)

    def test_wrong_retained_sha_rejected_before_any_probe_or_snapshot(self):
        (self.candidate / '.release-sha').write_text('f' * 40)
        result = self.run_rehearsal()
        self.assertFalse(result['ok']); self.assertEqual(result['stage'], 'PREFLIGHT')
        self.assertFalse(self.commands); self.assertFalse(list(self.runtime.glob('release-rehearsal-*')))

    def test_wrong_backup_pin_rejected_before_any_probe_or_snapshot(self):
        self.args[self.args.index('--backup-sha256') + 1] = 'f' * 64
        result = self.run_rehearsal()
        self.assertFalse(result['ok']); self.assertEqual(result['stage'], 'PREFLIGHT'); self.assertFalse(self.commands)

    def test_invalid_arguments_never_print_argument_or_usage(self):
        self.args += ['--DO_NOT_PRINT_UNKNOWN', 'DO_NOT_PRINT_ARGUMENT']
        result = self.run_rehearsal()
        self.assertFalse(result['ok']); self.assertEqual(result['stage'], 'PREFLIGHT'); self.assertFalse(self.commands)


class RehearsalCleanup(unittest.TestCase):
    def test_inode_swap_symlink_and_owner_changes_are_rejected_without_deletion(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            original = root / 'release-rehearsal-original'; original.mkdir(mode=0o700)
            (original / 'original').write_text('preserve')
            st = original.stat(); identity = (st.st_dev, st.st_ino)
            owner = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
            moved = root / 'moved'; original.rename(moved)
            original.mkdir(mode=0o700); (original / 'replacement').write_text('preserve')
            with patch.object(deploy, 'RUNTIME', root):
                with self.assertRaises(ValueError): deploy.remove_rehearsal_directory(original, identity, owner)
                self.assertTrue((original / 'replacement').is_file()); self.assertTrue((moved / 'original').is_file())
                replacement = root / 'replacement'; original.rename(replacement); original.symlink_to(moved)
                with self.assertRaises(ValueError): deploy.remove_rehearsal_directory(original, identity, owner)
                self.assertTrue((moved / 'original').is_file())
                original.unlink(); moved.rename(original)
                wrong_owner = SimpleNamespace(pw_uid=os.getuid() + 1, pw_gid=os.getgid())
                with self.assertRaises(ValueError): deploy.remove_rehearsal_directory(original, identity, wrong_owner)
                self.assertTrue((original / 'original').is_file())

    def test_unexpected_nested_entries_are_retained_without_deletion(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); outside = root / 'outside'; outside.mkdir(); (outside / 'keep').write_text('keep')
            disposable = root / 'release-rehearsal-test'; disposable.mkdir(mode=0o700)
            (disposable / 'nested').mkdir(); (disposable / 'nested/link').symlink_to(outside)
            (disposable / 'file-link').symlink_to(outside / 'keep')
            st = disposable.stat(); owner = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
            with patch.object(deploy, 'RUNTIME', root):
                with self.assertRaises(ValueError):
                    deploy.remove_rehearsal_directory(disposable, (st.st_dev, st.st_ino), owner)
            self.assertTrue(disposable.exists()); self.assertEqual((outside / 'keep').read_text(), 'keep')

    def test_collected_unit_requires_explicit_inactive_zero_pid_properties(self):
        for code, output, accepted in [(0, b'LoadState=loaded\nActiveState=inactive\nMainPID=0\n', True),
                                       (1, b'LoadState=not-found\nActiveState=inactive\nMainPID=0\n', True),
                                       (1, b'', False), (2, b'LoadState=not-found\nActiveState=inactive\nMainPID=0\n', False)]:
            with self.subTest(code=code, output=output):
                result = subprocess.CompletedProcess([], code, stdout=output, stderr=b'DO_NOT_PRINT_STDERR')
                with patch.object(deploy.subprocess, 'run', return_value=result):
                    if accepted: self.assertTrue(deploy.probe_stopped(deploy.probe_state('synthetic.service')))
                    else:
                        with self.assertRaises(ValueError): deploy.probe_state('synthetic.service')


class RehearsalErrorCodes(unittest.TestCase):
    def test_normal_deployment_interruption_preserves_exception_derived_handler(self):
        with self.assertRaises(RuntimeError) as caught:
            deploy.release_interrupted(None)
        self.assertIsInstance(caught.exception, Exception)
        with self.assertRaises(deploy.RehearsalInterrupted):
            deploy.release_interrupted(deploy.RehearsalReport())

    def test_allowlisted_guards_are_fixed_and_unknown_text_is_not_emitted(self):
        import contextlib
        import io
        for message, code in deploy.REHEARSAL_GUARD_CODES.items():
            with self.subTest(code=code):
                report = deploy.RehearsalReport(); report.fail(ValueError(message))
                self.assertEqual(report.failure['error'], code)
                self.assertRegex(code, r'^[A-Z_]+$')
        output = io.StringIO(); report = deploy.RehearsalReport()
        report.fail(ValueError('DO_NOT_PRINT_SECRET_DB_ROW_OR_PATH'))
        with contextlib.redirect_stdout(output): report.emit()
        self.assertEqual(json.loads(output.getvalue())['error'], 'CHECK_FAILED')
        self.assertNotIn('DO_NOT_PRINT', output.getvalue())

    def test_deadline_and_cancellation_escape_health_retry(self):
        for error in (deploy.RehearsalDeadline(), deploy.RehearsalInterrupted()):
            with self.subTest(error=type(error).__name__):
                with patch.object(deploy, 'network_command', side_effect=error) as command, patch.object(deploy.time, 'sleep') as sleep:
                    with self.assertRaises(type(error)): deploy.health(3001, 321)
                    self.assertEqual(command.call_count, 1); sleep.assert_not_called()


class RehearsalWorkflow(unittest.TestCase):
    def test_separate_runner_candidate_pins_and_no_stage_build_or_deploy_option(self):
        root = Path(__file__).resolve().parents[1]
        workflow = (root / '.github/workflows/production-rehearsal.yml').read_text()
        self.assertIn('ref: ${{ github.sha }}', workflow)
        self.assertIn('[[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]]', workflow)
        self.assertIn('TARGET_SHA="$GITHUB_SHA" python3 ops/check-release-ci.py', workflow)
        self.assertEqual(workflow.count('python3 ops/check-release-ci.py'), 2)
        self.assertIn('group: bubblewash-production', workflow)
        self.assertIn('environment: backup-storage', workflow)
        self.assertNotIn('schedule:', workflow); self.assertNotIn('push:', workflow)
        for forbidden in ('git archive', 'tar -xf', 'npm ci', 'npm run build', 'upload-artifact', 'continue-on-error'):
            self.assertNotIn(forbidden, workflow)
        launch = next(line.strip() for line in workflow.splitlines() if 'python3 -I -B -' in line)
        words = shlex.split(launch)
        remote = shlex.split(words[3])
        self.assertEqual(remote[:4], ['python3', '-I', '-B', '-'])
        self.assertEqual(remote.count('--rehearsal-only'), 1)
        self.assertIn('/home/ubuntu/bubblewash-releases/$RETAINED_RELEASE', remote)
        production = (root / '.github/workflows/production-deploy.yml').read_text()
        self.assertIn('[[ "$TARGET_SHA" == "$GITHUB_SHA" ]]', production)
        self.assertNotIn('--rehearsal-only', production)




class ReadinessCategoryDiagnostic(unittest.TestCase):
    token = 'SYNTHETIC_ONLY_TOKEN_NOT_REAL_0123456789'

    def setUp(self):
        from types import SimpleNamespace
        self.namespace = {'__name__': 'readiness_fixture', 'CATEGORIES': deploy.READINESS_BLOCKER_CATEGORIES}
        exec(deploy.READINESS_READER, self.namespace)
        self.report = deploy.RehearsalReport()
        self.candidate = Path('/synthetic/candidate')
        self.values = {'BUBBLEWASH_MAINTENANCE_TOKEN': self.token}
        self.result = {'state': 'BLOCKED', 'http': 'HTTP_503', 'categories': ['DB_CHECK']}
        self.completed = SimpleNamespace(returncode=0, stdout=json.dumps(self.result).encode())

    def body(self, checks, ok=False):
        return json.dumps({'ok': ok, 'service': 'Bubble Wash operations app',
                           'readiness': 'ready' if ok else 'blocked', 'checks': checks}).encode()

    def test_all_allowlisted_messages_map_only_to_fixed_categories(self):
        classify = self.namespace['classify']
        for message, category in deploy.READINESS_BLOCKER_CATEGORIES.items():
            with self.subTest(category=category):
                value = classify(503, self.body([message]))
                self.assertEqual(value, {'state': 'BLOCKED', 'http': 'HTTP_503', 'categories': [category]})
                self.assertNotIn(message, json.dumps(value))

    def test_multiple_categories_deduplicate_and_unknown_values_never_escape(self):
        checks = ['The operations database did not pass its integrity/read check.',
                  'The operations database did not pass its integrity/read check.',
                  'The managed staff account store is unavailable.', 'DO_NOT_PRINT_ROW_IDENTITY_OR_SECRET']
        value = self.namespace['classify'](503, self.body(checks))
        self.assertEqual(value['categories'], ['DB_CHECK', 'STAFF_STORE', 'UNKNOWN'])
        self.assertNotIn('DO_NOT_PRINT', json.dumps(value))

    def test_ready_and_anonymous_or_early_database_open_failure_are_distinct(self):
        classify = self.namespace['classify']
        self.assertEqual(classify(200, self.body([], True))['state'], 'READY')
        body = json.loads(self.body(['irrelevant'])); del body['checks']
        value = classify(503, json.dumps(body).encode())
        self.assertEqual(value['state'], 'DETAIL_UNAVAILABLE'); self.assertEqual(value['categories'], [])

    def test_malformed_oversized_and_unexpected_responses_fail_closed(self):
        classify = self.namespace['classify']
        for raw in (b'not-json-DO_NOT_PRINT', b'[]', self.body([]), self.body([1]),
                    self.body(['x'] * 65), self.body(['x' * 513]), self.body(['x'], True)):
            with self.subTest(length=len(raw)):
                value = classify(503, raw)
                self.assertEqual(value['state'], 'RESPONSE_INVALID'); self.assertEqual(value['categories'], [])
        self.assertEqual(classify(503, b'x' * 8193)['state'], 'RESPONSE_TOO_LARGE')
        self.assertEqual(classify(302, b'DO_NOT_PRINT_LOCATION'),
                         {'state': 'HTTP_UNEXPECTED', 'http': 'OTHER_HTTP', 'categories': []})

    def test_reader_uses_exact_loopback_endpoint_stdin_and_bounded_body(self):
        import io
        from types import SimpleNamespace
        from unittest.mock import MagicMock
        response = MagicMock(status=503); response.read.return_value = self.body(['The operations database is unavailable.'])
        connection = MagicMock(); connection.getresponse.return_value = response
        with patch('http.client.HTTPConnection', return_value=connection) as connect, \
                patch.object(sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(self.token.encode()))):
            value = self.namespace['read_ready']()
        connect.assert_called_once_with('127.0.0.1', 3001, timeout=3)
        connection.request.assert_called_once_with('GET', '/api/ready', headers={'Authorization': 'Bearer ' + self.token})
        response.read.assert_called_once_with(8193); connection.close.assert_called_once()
        self.assertEqual(value['categories'], ['DB_UNAVAILABLE'])
        self.assertNotIn(self.token, json.dumps(value))

    def test_reader_transport_errors_and_invalid_tokens_never_expose_exception(self):
        import io
        from types import SimpleNamespace
        with patch('http.client.HTTPConnection', side_effect=RuntimeError('DO_NOT_PRINT_SECRET')), \
                patch.object(sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(self.token.encode()))):
            value = self.namespace['read_ready']()
        self.assertEqual(value['state'], 'TRANSPORT_FAILED'); self.assertNotIn('DO_NOT_PRINT', json.dumps(value))
        for token in (b'', b'short', b'x' * 4097, b'x' * 32 + b'\nInjected: yes', b'x' * 32 + b'\x7f'):
            with patch('http.client.HTTPConnection') as connect, \
                    patch.object(sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(token))):
                self.assertEqual(self.namespace['read_ready']()['state'], 'TOKEN_UNAVAILABLE')
                connect.assert_not_called()

    def collect(self):
        return deploy.readiness_diagnostic(self.candidate, self.values, 'synthetic-probe.service', 321, self.report)

    def test_parent_stdin_only_timeout_capture_and_namespace_reverification(self):
        with patch.object(deploy, 'verify_private_network', return_value=321) as verify, \
                patch.object(deploy.subprocess, 'run', return_value=self.completed) as run:
            self.assertEqual(self.collect(), self.result)
        args, kwargs = run.call_args
        self.assertEqual(args[0][:6], ['nsenter', '--target', '321', '--net', '--', 'python3'])
        self.assertNotIn(self.token, repr(args)); self.assertNotIn('env', kwargs)
        self.assertEqual(kwargs['input'], self.token.encode()); self.assertLessEqual(kwargs['timeout'], 7)
        self.assertEqual(kwargs['stderr'], subprocess.DEVNULL); self.assertFalse(kwargs['check'])
        self.assertEqual(verify.call_count, 2)
        verify.assert_called_with('synthetic-probe.service', self.candidate)

    def test_missing_token_or_namespace_failure_prevents_request(self):
        for token in ('', 'short', self.token + '\n'):
            self.values['BUBBLEWASH_MAINTENANCE_TOKEN'] = token
            with patch.object(deploy.subprocess, 'run') as run:
                self.assertEqual(self.collect()['state'], 'TOKEN_UNAVAILABLE'); run.assert_not_called()
        self.values['BUBBLEWASH_MAINTENANCE_TOKEN'] = self.token
        for value in (0, 322):
            with patch.object(deploy, 'verify_private_network', return_value=value), patch.object(deploy.subprocess, 'run') as run:
                self.assertEqual(self.collect()['state'], 'NAMESPACE_UNVERIFIED'); run.assert_not_called()
        with patch.object(deploy, 'verify_private_network', side_effect=ValueError('DO_NOT_PRINT_NAMESPACE')):
            self.assertEqual(self.collect()['state'], 'NAMESPACE_UNVERIFIED')

    def test_changed_namespace_discards_result_and_timeout_still_reverifies(self):
        with patch.object(deploy, 'verify_private_network', side_effect=[321, 322]), \
                patch.object(deploy.subprocess, 'run', return_value=self.completed):
            self.assertEqual(self.collect()['state'], 'NAMESPACE_UNVERIFIED')
        with patch.object(deploy, 'verify_private_network', return_value=321) as verify, \
                patch.object(deploy.subprocess, 'run', side_effect=subprocess.TimeoutExpired('DO_NOT_PRINT_TOKEN', 7, output=b'DO_NOT_PRINT_BODY')):
            self.assertEqual(self.collect()['state'], 'TIMEOUT'); self.assertEqual(verify.call_count, 2)

    def test_parent_rejects_arbitrary_child_output_and_values(self):
        from types import SimpleNamespace
        for body in (b'DO_NOT_PRINT', b'x' * 1025, b'null', b'[]',
                     json.dumps({**self.result, 'raw': 'DO_NOT_PRINT'}).encode(),
                     json.dumps({**self.result, 'categories': ['DO_NOT_PRINT']}).encode(),
                     json.dumps({**self.result, 'state': ['BLOCKED']}).encode()):
            with patch.object(deploy, 'verify_private_network', return_value=321), \
                    patch.object(deploy.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=body)):
                value = self.collect()
                self.assertEqual(value['state'], 'DIAGNOSTIC_FAILED'); self.assertNotIn('DO_NOT_PRINT', json.dumps(value))

    def test_deadline_and_cancellation_are_not_swallowed(self):
        for error in (deploy.RehearsalDeadline(), deploy.RehearsalInterrupted(), KeyboardInterrupt()):
            with patch.object(deploy, 'verify_private_network', return_value=321), \
                    patch.object(deploy.subprocess, 'run', side_effect=error), self.assertRaises(type(error)):
                self.collect()

    def test_real_child_invalid_token_emits_only_fixed_json_without_traceback(self):
        script = 'CATEGORIES = ' + repr(deploy.READINESS_BLOCKER_CATEGORIES) + '\n' + deploy.READINESS_READER
        result = subprocess.run([sys.executable, '-I', '-B', '-c', script], input=b'DO_NOT_PRINT',
                                capture_output=True, timeout=5, check=True)
        self.assertEqual(result.stderr, b'')
        self.assertEqual(json.loads(result.stdout), {'state': 'TOKEN_UNAVAILABLE', 'http': 'UNAVAILABLE', 'categories': []})

    def test_normal_deployment_rehearsal_does_not_collect_readiness_details(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = root / 'candidate'; (candidate / '.next').mkdir(parents=True)
            (candidate / '.next/BUILD_ID').write_text('synthetic')
            db = root / 'source.sqlite'
            with sqlite3.connect(db) as connection:
                connection.execute('CREATE TABLE synthetic (id INTEGER)')
            def network(args, *unused):
                if args[-1].endswith('/api/ready'):
                    raise subprocess.CalledProcessError(22, 'synthetic')
                return ''
            with patch.object(deploy, 'RUNTIME', root), \
                    patch.object(deploy, 'verify_private_network', return_value=321), \
                    patch.object(deploy, 'check_runtime'), patch.object(deploy, 'health'), \
                    patch.object(deploy, 'command', return_value='') as command, \
                    patch.object(deploy, 'network_command', side_effect=network), \
                    patch.object(deploy, 'readiness_diagnostic') as diagnostic:
                with self.assertRaises(subprocess.CalledProcessError):
                    deploy.rehearse(candidate, self.values, db, root / 'status',
                                    SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid()), 'normal', None)
                diagnostic.assert_not_called()
                self.assertEqual(command.call_args.args[0], ['systemctl', 'stop', 'normal-probe.service'])


if __name__ == '__main__':
    unittest.main()
