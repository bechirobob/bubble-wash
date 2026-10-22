import copy
import importlib.util
import json
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


class ExactCi(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('ci', Path(__file__).resolve().parents[1] / 'ops/check-release-ci.py')
        self.ci = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.ci)
        self.sha = 'a' * 40

    def response(self, url):
        workflow = url.split('/workflows/')[1].split('/runs')[0]
        return {'workflow_runs': [dict(head_sha=self.sha, head_branch='main',
            head_repository={'full_name': 'bechirobob/bubble-wash'}, event='push',
            path='.github/workflows/' + workflow, status='completed', conclusion='success',
            run_number=10, run_attempt=1)]}

    def test_all_exact_main_checks_required(self):
        self.ci.check(self.sha, self.response)
        with self.assertRaises(ValueError): self.ci.check('main', self.response)
        with self.assertRaises(ValueError): self.ci.check(self.sha, lambda _: {'workflow_runs': []})

    def test_rejects_wrong_identity_or_pending(self):
        for key, value in [('head_sha', 'b' * 40), ('head_branch', 'other'),
                           ('head_repository', {'full_name': 'fork/repo'}), ('event', 'pull_request'),
                           ('path', '.github/workflows/unrelated.yml'), ('status', 'in_progress'),
                           ('conclusion', 'failure')]:
            def fetch(url):
                data = self.response(url)
                data['workflow_runs'][0][key] = value
                return data
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.ci.check(self.sha, fetch)

    def test_older_success_cannot_hide_newer_failure(self):
        def fetch(url):
            data = self.response(url)
            failed = copy.deepcopy(data['workflow_runs'][0])
            failed.update(run_attempt=2, conclusion='failure')
            data['workflow_runs'].append(failed)
            return data
        with self.assertRaises(ValueError): self.ci.check(self.sha, fetch)

    def test_sandbox_and_schema_guards_present(self):
        source = (Path(__file__).resolve().parents[1] / 'ops/deploy-preserving.py').read_text()
        for name in ('data-store', 'operational-store', 'availability-store', 'staff-accounts'):
            self.assertIn('src/lib/' + name + '.ts', source)
        for guard in ('ProtectSystem=strict', 'ProtectHome=tmpfs', 'BindReadOnlyPaths=',
                      'NoNewPrivileges=true', 'StandardError=null', 'PrivateNetwork=true'):
            self.assertIn(guard, source)


if __name__ == '__main__':
    unittest.main()
