import fnmatch
import hashlib
import importlib.util
from pathlib import Path
import re
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('owner_release', ROOT / 'ops/deploy-personal-owner.py')
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)

ORIGINAL_GATE = '''    # Rollback is code-only: database implementation must be byte-identical.
    for relative in ('src/lib/data-store.ts', 'src/lib/operational-store.ts',
                     'src/lib/availability-store.ts', 'src/lib/staff-accounts.ts', 'src/app/api/health/route.ts'):
        require(digest(current / relative) == digest(candidate / relative), 'database or health implementation requires separate review')
'''


class OwnerRoute(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.current = self.root / 'current'
        self.candidate = self.root / 'candidate'
        for tree in (self.current, self.candidate):
            for relative in (*owner.UNCHANGED_OWNER_MODULES, 'src/lib/staff-accounts.ts', *owner.OWNER_CANDIDATE_SOURCE_SHA256):
                path = tree / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('unchanged fixture: ' + relative)
        (self.current / 'src/lib/staff-accounts.ts').write_text('exact old staff fixture')
        (self.candidate / 'src/lib/staff-accounts.ts').write_text('exact new staff fixture')
        self.pins = {
            'OWNER_STAFF_OLD_SHA256': owner.digest(self.current / 'src/lib/staff-accounts.ts'),
            'OWNER_STAFF_NEW_SHA256': owner.digest(self.candidate / 'src/lib/staff-accounts.ts'),
            'OWNER_CANDIDATE_SOURCE_SHA256': {
                relative: owner.digest(self.candidate / relative) for relative in owner.OWNER_CANDIDATE_SOURCE_SHA256
            },
        }

    def test_pins_cover_exact_reviewed_twenty_file_manifest_plus_readiness(self):
        self.assertEqual(len(owner.OWNER_CANDIDATE_SOURCE_SHA256), 21)
        normalized = '\n'.join(f'{key} {value}' for key, value in sorted(owner.OWNER_CANDIDATE_SOURCE_SHA256.items()))
        self.assertEqual(hashlib.sha256(normalized.encode()).hexdigest(), '9bc4ed8047f33abb18b87c40e73ac8d5108e42a4bf5d7c7bc6f0b0ef97b50410')

    def test_only_exact_reviewed_pair_accepted(self):
        with patch.multiple(owner, **self.pins):
            owner.verify_owner_code(self.current, self.candidate)
            owner.verify_owner_candidate(self.candidate)

    def test_source_pins_have_no_runtime_override(self):
        source = (ROOT / 'ops/deploy-personal-owner.py').read_text()
        block = source.split('# BEGIN EXACT OWNER TRANSITION:', 1)[1].split('# END EXACT OWNER TRANSITION', 1)[0]
        self.assertNotIn('getenv', block)
        self.assertNotIn('os.environ', block)
        self.assertNotIn('argparse', block)
        for key in ('OWNER_STAFF_OLD_SHA256', 'OWNER_STAFF_NEW_SHA256'):
            for value in (None, '', 'main', 'f' * 63, 'g' * 64):
                with patch.multiple(owner, **{**self.pins, key: value}), self.assertRaises(ValueError):
                    owner.verify_owner_code(self.current, self.candidate)

    def test_equal_staff_hashes_are_not_an_owner_transition(self):
        with patch.multiple(owner, **{**self.pins, 'OWNER_STAFF_NEW_SHA256': self.pins['OWNER_STAFF_OLD_SHA256']}):
            with self.assertRaises(ValueError):
                owner.verify_owner_code(self.current, self.candidate)

    def test_old_new_staff_or_any_pinned_file_drift_blocks(self):
        changes = [(self.current, 'src/lib/staff-accounts.ts'), (self.candidate, 'src/lib/staff-accounts.ts')]
        changes.extend((self.candidate, relative) for relative in owner.OWNER_CANDIDATE_SOURCE_SHA256)
        with patch.multiple(owner, **self.pins):
            for tree, relative in changes:
                path = tree / relative
                content = path.read_bytes()
                path.write_bytes(content + b'drift')
                with self.subTest(tree=tree.name, relative=relative), self.assertRaises(ValueError):
                    owner.verify_owner_code(self.current, self.candidate)
                path.write_bytes(content)

    def test_every_other_schema_module_and_health_must_match(self):
        with patch.multiple(owner, **self.pins):
            for relative in owner.UNCHANGED_OWNER_MODULES:
                path = self.candidate / relative
                content = path.read_bytes()
                path.write_bytes(content + b'unapproved schema change')
                with self.subTest(relative=relative), self.assertRaises(ValueError):
                    owner.verify_owner_code(self.current, self.candidate)
                path.write_bytes(content)

    def test_guarded_symlinks_rejected(self):
        with patch.multiple(owner, **self.pins):
            path = self.candidate / 'src/lib/staff-accounts.ts'
            saved = path.with_name('saved.ts')
            path.rename(saved)
            path.symlink_to(saved)
            with self.assertRaises(ValueError):
                owner.verify_owner_code(self.current, self.candidate)

    def test_new_preserving_engine_requires_new_review(self):
        with patch.multiple(owner, **self.pins), patch.object(owner, 'PRESERVING_ROUTE_SHA256', '0' * 64):
            with self.assertRaises(ValueError):
                owner.verify_owner_code(self.current, self.candidate)

    def test_initial_rollout_requires_no_owner_schema(self):
        path = self.root / 'snapshot.sqlite'
        with sqlite3.connect(path) as db:
            db.execute('CREATE TABLE staff_accounts(email TEXT, password_hash TEXT)')
            db.execute("INSERT INTO staff_accounts VALUES('fixture', 'unchanged')")
        original = owner.database_fingerprint(path)
        owner.require_no_owner_enrollment(path)
        self.assertEqual(original, owner.database_fingerprint(path))
        with sqlite3.connect(path) as db:
            db.execute('CREATE TABLE staff_owner_capabilities(email TEXT, all_staff_access INTEGER)')
        with self.assertRaises(ValueError):
            owner.require_no_owner_enrollment(path)
        self.assertNotEqual(original, owner.database_fingerprint(path))

    def test_every_database_value_and_metadata_remain_guarded(self):
        path = self.root / 'snapshot.sqlite'
        with sqlite3.connect(path) as db:
            db.executescript("CREATE TABLE staff_accounts(email TEXT, password_hash TEXT); INSERT INTO staff_accounts VALUES('fixture', 'unchanged');")
        original = owner.database_fingerprint(path)
        with sqlite3.connect(path) as db:
            db.execute('PRAGMA user_version=1')
        self.assertNotEqual(original, owner.database_fingerprint(path))
        with sqlite3.connect(path) as db:
            db.execute('PRAGMA user_version=0')
            db.execute('PRAGMA application_id=1')
        self.assertNotEqual(original, owner.database_fingerprint(path))
        with sqlite3.connect(path) as db:
            db.execute('PRAGMA application_id=0')
            db.execute('DELETE FROM staff_accounts')
        self.assertNotEqual(original, owner.database_fingerprint(path))

    def test_unmodified_engine_reused_except_exact_documented_owner_additions(self):
        source = (ROOT / 'ops/deploy-personal-owner.py').read_text()
        stripped = re.sub(r'# BEGIN EXACT OWNER TRANSITION:.*?# END EXACT OWNER TRANSITION\n\n\n', '', source, count=1, flags=re.S)
        stripped = stripped.replace('    args = parser.parse_args()\n    require_owner_pins()\n', '    args = parser.parse_args()\n', 1)
        stripped = stripped.replace('    verify_owner_code(current, candidate)\n', ORIGINAL_GATE, 1)
        stripped = stripped.replace("unit = 'bubblewash-owner-'", "unit = 'bubblewash-preserving-'", 1)
        stripped = stripped.replace('        require_no_owner_enrollment(snapshot)\n', '', 1)
        stripped = stripped.replace('    def unchanged():\n        verify_owner_code(current, candidate)\n', '    def unchanged():\n', 1)
        stripped = stripped.replace(", 'ownerEnrollmentPerformed': False}", '}', 1)
        stripped = stripped.replace('Owner code-only deployment failed closed;', 'Preserving deployment failed closed;', 1)
        self.assertEqual(hashlib.sha256(stripped.encode()).hexdigest(), owner.PRESERVING_ROUTE_SHA256)
        self.assertEqual(stripped, (ROOT / 'ops/deploy-preserving.py').read_text())

    def test_manual_workflow_exact_pins_same_lock_and_no_enrollment(self):
        text = (ROOT / '.github/workflows/owner-code-deploy.yml').read_text()
        triggers = text.split('permissions:', 1)[0]
        self.assertIn('  workflow_dispatch:', triggers)
        self.assertEqual(re.findall(r'^  ([A-Za-z_][A-Za-z_0-9]*):', triggers, flags=re.M), ['workflow_dispatch'])
        for trigger in ('workflow_run:', '  push:', '  pull_request:', '  schedule:'):
            self.assertNotIn(trigger, triggers)
        self.assertIn("github.repository == 'bechirobob/bubble-wash' && github.ref == 'refs/heads/main'", text)
        self.assertIn('permissions:\n  contents: read', text)
        self.assertIn('environment: backup-storage', text)
        self.assertIn('group: bubblewash-production', text)
        self.assertIn('cancel-in-progress: false', text)
        first_step = text.split('    steps:\n', 1)[1].split('      - uses:', 1)[0]
        self.assertIn('Require explicit reviewed main and receipt pins', first_step)
        self.assertIn('"$TARGET_SHA" == "$GITHUB_SHA"', first_step)
        self.assertIn('^[0-9a-f]{40}$', first_step)
        self.assertIn('^[0-9a-f]{64}$', first_step)
        self.assertNotIn('if:', first_step)
        self.assertNotIn('continue-on-error', text)
        self.assertIn('ref: ${{ inputs.candidate_sha }}', text)
        self.assertIn('"$(git rev-parse HEAD)" == "$TARGET_SHA"', text)
        self.assertIn('persist-credentials: false', text)
        tests = text.index("python3 -m unittest discover -s tests -p 'test_preserving_deploy.py'")
        transport_tests = text.index("python3 -m unittest discover -s .github/backup")
        exact_ci = text.index('python3 ops/check-release-ci.py')
        secret = text.index('secrets.BACKUP_STORE_TOKEN')
        private_store = text.index('python3 .github/backup/check_store.py')
        host = text.index('uses: tailscale/github-action')
        self.assertLess(tests, secret)
        self.assertLess(transport_tests, secret)
        self.assertLess(exact_ci, secret)
        self.assertLess(secret, private_store)
        self.assertLess(private_store, host)
        for forbidden in ('actions/upload-artifact', 'BUBBLEWASH_BACKUP_ENCRYPTION_KEY', 'BACKUP_KEY:',
                          'ops/deploy-production.sh', 'actions: write', 'contents: write'):
            self.assertNotIn(forbidden, text)
        for argument in ('--sha', '--expected-live', '--backup-sha256', '--receipt-run', '--store-sha', '--store-id'):
            self.assertIn(argument, text)
        self.assertIn('git archive --format=tar "$TARGET_SHA"', text)
        self.assertIn('ops/deploy-personal-owner.py', text)

        owner_tests = text.index("python3 -m unittest discover -s tests -p 'test_owner_deploy.py'")
        source_pins = text.index('python3 ops/check-owner-source.py')
        self.assertLess(owner_tests, secret)
        self.assertLess(source_pins, secret)
        self.assertLess(source_pins, text.index('Stage exact source'))
        self.assertNotIn('invite-additional-owner', text)
        self.assertNotIn('continue-on-error', text)

    def test_ci_triggers_and_runs_owner_safety_checks(self):
        source = (ROOT / '.github/workflows/backup-transport-checks.yml').read_text()
        for name in ('.github/workflows/owner-code-deploy.yml', 'ops/deploy-personal-owner.py',
                     'ops/check-owner-source.py', 'tests/test_owner_deploy.py'):
            self.assertEqual(source.count('      - ' + name + '\n'), 2)
        self.assertIn("-p 'test_owner_deploy.py'", source)
        self.assertIn('python3 ops/check-owner-source.py', source)
        for path in (*owner.OWNER_CANDIDATE_SOURCE_SHA256, *owner.UNCHANGED_OWNER_MODULES):
            self.assertEqual(source.count('      - ' + path + '\n'), 2, path)
        self.assertNotIn('secrets.', source)
        for event, end in (('pull_request', 'push'), ('push', 'workflow_dispatch')):
            event_block = source.split('  ' + event + ':\n', 1)[1].split('  ' + end + ':', 1)[0]
            patterns = re.findall(r'^      - (.+)$', event_block, flags=re.M)
            for path in (*owner.OWNER_CANDIDATE_SOURCE_SHA256, *owner.UNCHANGED_OWNER_MODULES):
                self.assertTrue(any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns), (event, path))


if __name__ == '__main__':
    unittest.main()
