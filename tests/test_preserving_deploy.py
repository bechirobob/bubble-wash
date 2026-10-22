import copy
import importlib.util
import json
import os
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


if __name__ == '__main__':
    unittest.main()

