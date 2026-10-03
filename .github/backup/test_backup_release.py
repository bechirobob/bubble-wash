import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('backup_release', Path(__file__).with_name('backup_release.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class FakeGitHub:
    def __init__(self, ctx):
        self.ctx = ctx
        self.release = None
        self.content = {}
        self.calls = []
        self.private = True
        self.corrupt_download = False
        self.corrupt_digest = False
        self.extra_asset = False
        self.change_on_publish = False
        self.downloaded = []

    def api(self, suffix='', method='GET', payload=None):
        self.calls.append((suffix, method))
        if not suffix:
            return {'private': self.private, 'visibility': 'private' if self.private else 'public', 'full_name': self.ctx['repository']}
        if method == 'POST':
            self.release = dict(payload, id=10, assets=[])
        elif method == 'PATCH':
            assert len(self.downloaded) == 2, 'Must download both assets before publication'
            self.release.update(payload, published_at='2026-10-03T00:00:00Z')
            if self.change_on_publish:
                self.release['assets'][0]['id'] += 100
        result = copy.deepcopy(self.release)
        if self.extra_asset:
            result['assets'].append({'name': 'plaintext.sqlite'})
        return result

    def upload(self, release_id, path):
        asset_id = 100 + len(self.content)
        self.content[asset_id] = path.read_bytes()
        self.release['assets'].append({'id': asset_id, 'name': path.name, 'size': path.stat().st_size,
                                     'state': 'uploaded', 'content_type': 'application/octet-stream',
                                     'digest': 'sha256:' + ('0' * 64 if self.corrupt_digest else m.digest(path))})

    def download(self, asset_id, target, expected_size):
        self.downloaded.append(asset_id)
        target.write_bytes(b'corrupted' if self.corrupt_download else self.content[asset_id])

class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / 'tickets-2026-10-03T08:00:00.000Z.tar.gz.enc'
        self.path.write_bytes(b'BCTBACKUP1' + b'\x00encrypted\x1b[not-plaintext\xff' * 3)
        self.env = {'BACKUP_PROJECT': 'tickets', 'BACKUP_PATH': str(self.path), 'GITHUB_REPOSITORY': 'bechirobob/tickets',
                    'GITHUB_REF': 'refs/heads/main', 'GITHUB_EVENT_NAME': 'schedule', 'GITHUB_SHA': 'a' * 40,
                    'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}
        self.ctx = m.context(self.env)
        self.api = FakeGitHub(self.ctx)
        self.work = self.root / 'work'
        self.work.mkdir()

    def test_verified_receipt(self):
        receipt = m.publish(self.ctx, self.api, self.work)
        self.assertEqual(receipt['sha256'], m.digest(self.path))
        self.assertTrue(receipt['downloadVerified'])
        self.assertIsNone(receipt['retentionDays'])
        self.assertFalse(receipt['automaticExpiry'])
        self.assertEqual(len(receipt['assets']), 2)
        self.assertNotIn(('releases/10', 'DELETE'), self.api.calls)
        self.assertFalse(self.api.release['draft'])
        self.assertEqual(self.api.release['make_latest'], 'false')

    def test_private_repository_required(self):
        self.api.private = False
        with self.assertRaisesRegex(RuntimeError, 'private'):
            m.publish(self.ctx, self.api, self.work)
        self.assertIsNone(self.api.release)

    def test_corrupted_download_no_publish(self):
        self.api.corrupt_download = True
        with self.assertRaisesRegex(RuntimeError, 'Downloaded asset hash mismatch'):
            m.publish(self.ctx, self.api, self.work)
        self.assertTrue(self.api.release['draft'])

    def test_corrupted_metadata_no_publish(self):
        self.api.corrupt_digest = True
        with self.assertRaisesRegex(RuntimeError, 'digest mismatch'):
            m.publish(self.ctx, self.api, self.work)
        self.assertTrue(self.api.release['draft'])

    def test_unexpected_asset_no_publish(self):
        self.api.extra_asset = True
        with self.assertRaisesRegex(RuntimeError, 'assets'):
            m.publish(self.ctx, self.api, self.work)

    def test_asset_changed_on_publish_no_receipt(self):
        self.api.change_on_publish = True
        with self.assertRaisesRegex(RuntimeError, 'assets changed'):
            m.publish(self.ctx, self.api, self.work)

    def test_invalid_contexts(self):
        for key, value in [('GITHUB_REF', 'refs/heads/feature'), ('GITHUB_REPOSITORY', 'other/tickets'),
                           ('GITHUB_EVENT_NAME', 'pull_request'), ('GITHUB_SHA', 'main'),
                           ('GITHUB_RUN_ID', '-1'), ('GITHUB_RUN_ATTEMPT', '1;cat')]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                m.context(dict(self.env, **{key: value}))

    def test_reject_unencrypted_file(self):
        path = self.root / 'tickets.sqlite'
        path.write_bytes(b'plaintext')
        with self.assertRaises(RuntimeError):
            m.context(dict(self.env, BACKUP_PATH=str(path)))

    def test_reject_fake_encryption(self):
        self.path.write_bytes(b'plaintext disguised with enc extension' * 2)
        with self.assertRaisesRegex(RuntimeError, 'format marker'):
            m.context(self.env)

    def test_reject_symlink(self):
        new = self.root / 'tickets-2026-10-03T09:00:00Z.tar.gz.enc'
        new.symlink_to(self.path)
        with self.assertRaises(RuntimeError):
            m.context(dict(self.env, BACKUP_PATH=str(new)))

    def test_bubblewash_context(self):
        path = self.root / 'bubblewash-2026-10-03T08:00:00.000Z.sqlite.enc'
        path.write_bytes(b'BWBACKUP1' + b'encrypted' * 8)
        ctx = m.context(dict(self.env, BACKUP_PROJECT='bubblewash', GITHUB_REPOSITORY='bechirobob/bubble-wash', BACKUP_PATH=str(path)))
        self.assertEqual(ctx['tag'], 'bubblewash-encrypted-backup-123-1')

    def test_rerun_unique_identity(self):
        ctx = m.context(dict(self.env, GITHUB_RUN_ATTEMPT='2'))
        self.assertNotEqual(ctx['tag'], self.ctx['tag'])

    def test_filename_shell_injection_rejected(self):
        path = self.root / "bubblewash-2026-10-03T';echo BAD;'.sqlite.enc"
        path.write_bytes(b'encrypted')
        with self.assertRaises(RuntimeError):
            m.context(dict(self.env, BACKUP_PROJECT='bubblewash', GITHUB_REPOSITORY='bechirobob/bubble-wash', BACKUP_PATH=str(path)))

if __name__ == '__main__':
    unittest.main()

class WorkflowContractTests(unittest.TestCase):
    def setUp(self):
        self.workflows = Path(__file__).parent.parent / 'workflows'
        if not self.workflows.is_dir():
            self.skipTest('Workflow contracts run from the installed .github/backup location.')
        self.tickets = (self.workflows / 'tickets-backup.yml').exists()
        self.backup = (self.workflows / ('tickets-backup.yml' if self.tickets else 'nightly-backup.yml')).read_text()

    def test_backup_guards_and_receipt_order(self):
        self.assertIn("github.ref == 'refs/heads/main'", self.backup)
        self.assertIn('permissions:\n  contents: read', self.backup)
        self.assertIn('    permissions:\n      contents: write', self.backup)
        self.assertNotIn('actions/upload-artifact', self.backup)
        self.assertNotIn('retention-days: 35', self.backup)
        self.assertIn('          BACKUP_PROJECT:', self.backup)
        self.assertLess(self.backup.index('Verify encrypted backup transport before host access'), self.backup.index('uses: tailscale/github-action'))
        self.assertLess(self.backup.index('Publish and download-verify'), self.backup.index('Record durable verified off-host receipt'))
        if self.tickets:
            self.assertIn("cron: '45 1 * * *'", self.backup)
            self.assertIn('group: tickets-vps-handover', self.backup)
            self.assertIn('flock -n 9', self.backup)
            self.assertIn('restore-mapping.json', self.backup)
        else:
            self.assertIn('cron: "15 1 * * *"', self.backup)
            self.assertIn('group: bubblewash-production', self.backup)
            self.assertIn('BUBBLEWASH_BACKUP_STAGING_RETENTION_DAYS=365', self.backup)
            self.assertIn('if [[ "$GITHUB_EVENT_NAME" != schedule ]]', self.backup)
            self.assertLess(self.backup.index('Record durable verified'), self.backup.index('Confirm off-host storage after download verification'))

    def test_backup_only_skip_but_mixed_source_runs(self):
        import fnmatch
        target = self.workflows / ('deploy.yml' if self.tickets else 'pilot-ci.yml')
        text = target.read_text()
        push = text.split('  push:\n', 1)[1].split('  pull_request:', 1)[0].split('  workflow_dispatch:', 1)[0]
        ignored = []
        in_ignore = False
        for line in push.splitlines():
            if line.strip() == 'paths-ignore:':
                in_ignore = True
            elif in_ignore and line.strip().startswith('- '):
                ignored.append(line.strip()[2:].strip("'\""))
        def triggers(files):
            return any(not any(fnmatch.fnmatchcase(file, pattern) for pattern in ignored) for file in files)
        backup_path = '.github/workflows/' + ('tickets-backup.yml' if self.tickets else 'nightly-backup.yml')
        paths = [backup_path, '.github/backup/backup_release.py', '.github/backup/test_backup_release.py', '.github/workflows/backup-transport-checks.yml']
        self.assertFalse(triggers(paths))
        self.assertTrue(triggers(paths + ['app/page.tsx']))
        self.assertTrue(triggers(paths + ['package-lock.json']))
        self.assertTrue(triggers(paths + ['.github/workflows/unrelated.yml']))
        if not self.tickets:
            self.assertFalse(triggers(paths + ['.github/workflows/pilot-ci.yml']))
            pr = text.split('  pull_request:\n', 1)[1].split('  workflow_dispatch:', 1)[0]
            self.assertNotIn('- .github/workflows/pilot-ci.yml', pr)
