import fnmatch
import ast
import hashlib
import importlib.util
from pathlib import Path
import re
import shutil
import subprocess
import sys
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('owner_release', ROOT / 'ops/deploy-personal-owner.py')
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)

ORIGINAL_GATE = '''    verify_source_transition(current, candidate)
    # Additional schema/health byte-identity checks remain in force.
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
            for relative in ('package.json', 'package-lock.json', 'next.config.mjs', 'tsconfig.json', *owner.UNCHANGED_OWNER_MODULES, 'src/lib/staff-accounts.ts', *owner.OWNER_CANDIDATE_SOURCE_SHA256):
                path = tree / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('unchanged fixture: ' + relative)
        (self.candidate / 'ops').mkdir()
        shutil.copyfile(ROOT / 'ops/deploy-preserving.py', self.candidate / 'ops/deploy-preserving.py')
        (self.current / 'src/lib/staff-accounts.ts').write_text('exact old staff fixture')
        (self.candidate / 'src/lib/staff-accounts.ts').write_text('exact new staff fixture')
        self.pins = {
            'OWNER_LIVE_SOURCE_MANIFEST': owner.source_manifest(self.current),
            'OWNER_CANDIDATE_SOURCE_MANIFEST': owner.source_manifest(self.candidate),
            'OWNER_STAFF_OLD_SHA256': owner.digest(self.current / 'src/lib/staff-accounts.ts'),
            'OWNER_STAFF_NEW_SHA256': owner.digest(self.candidate / 'src/lib/staff-accounts.ts'),
            'OWNER_CANDIDATE_SOURCE_SHA256': {
                relative: owner.digest(self.candidate / relative) for relative in owner.OWNER_CANDIDATE_SOURCE_SHA256
            },
        }

    def test_pins_cover_exact_reviewed_owner_mfa_correction(self):
        self.assertEqual(len(owner.OWNER_CANDIDATE_SOURCE_SHA256), 25)
        normalized = '\n'.join(f'{key} {value}' for key, value in sorted(owner.OWNER_CANDIDATE_SOURCE_SHA256.items()))
        self.assertEqual(hashlib.sha256(normalized.encode()).hexdigest(), 'cf8b8efe53b09bbea35e3d239d68fa5983750b09586adb84489d993b41ba76ab')

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
        stripped = stripped.replace('    require_owner_pins(candidate)\n', '', 1)
        stripped = stripped.replace('    verify_owner_code(current, candidate)\n', ORIGINAL_GATE, 1)
        stripped = stripped.replace("unit = 'bubblewash-owner-'", "unit = 'bubblewash-preserving-'", 1)
        stripped = stripped.replace('        require_no_owner_enrollment(snapshot)\n', '', 1)
        stripped = stripped.replace('        verify_owner_code(current, candidate)\n', '        verify_source_transition(current, candidate)\n', 1)
        stripped = stripped.replace(", 'ownerEnrollmentPerformed': False}", '}', 1)
        stripped = stripped.replace('Owner code-only deployment failed closed;', 'Preserving deployment failed closed;', 1)
        self.assertEqual(hashlib.sha256(stripped.encode()).hexdigest(), owner.PRESERVING_ROUTE_SHA256)
        self.assertEqual(stripped, (ROOT / 'ops/deploy-preserving.py').read_text())

    def test_full_source_and_dependency_manifest_cannot_be_bypassed(self):
        self.assertEqual(owner.OWNER_LIVE_SOURCE_MANIFEST, owner.CANDIDATE_SOURCE_SHA256)
        self.assertEqual(owner.OWNER_CANDIDATE_SOURCE_MANIFEST, owner.source_manifest(ROOT))
        with patch.multiple(owner, **self.pins):
            for tree in (self.current,self.candidate):
                extra=tree/'src/unreviewed.ts'; extra.write_text('unreviewed')
                with self.assertRaises(ValueError): owner.verify_owner_code(self.current,self.candidate)
                extra.unlink()
                for name in ('package-lock.json','next.config.mjs','tsconfig.json'):
                    path=tree/name; before=path.read_bytes(); path.write_bytes(before+b'drift')
                    with self.assertRaises(ValueError): owner.verify_owner_code(self.current,self.candidate)
                    path.write_bytes(before)

    def test_shared_lock_helper_is_identical_in_all_three_entrypoints(self):
        sources=[]
        for name in ('ops/deploy-preserving.py','ops/deploy-personal-owner.py','scripts/owner-enrollment-host.py'):
            source=(ROOT/name).read_text()
            node=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=='deployment_lock')
            sources.append(ast.get_source_segment(source,node))
        self.assertEqual(sources[0],sources[1]); self.assertEqual(sources[0],sources[2])
        workflow=(ROOT/'.github/workflows/owner-code-deploy.yml').read_text()
        self.assertNotIn('run: curl',workflow)
        source=(ROOT/'ops/deploy-personal-owner.py').read_text()
        validate=source[source.index('    def validate(target):'):source.index('    unchanged()\n    require(CURRENT')]
        self.assertLess(validate.index('public_health()'),validate.index('write_marker('))

    def test_owner_pin_checks_require_validated_candidate_not_script_path(self):
        with patch.multiple(owner, **self.pins):
            owner.require_owner_pins(self.candidate)
            alias = self.root / 'candidate-alias'
            alias.symlink_to(self.candidate, target_is_directory=True)
            with self.assertRaises(ValueError): owner.require_owner_pins(alias)
            preserving = self.candidate / 'ops/deploy-preserving.py'
            preserving.write_text('unreviewed candidate engine')
            with self.assertRaises(ValueError): owner.require_owner_pins(self.candidate)
        source = (ROOT / 'ops/deploy-personal-owner.py').read_text()
        self.assertNotIn('__file__', source)
        main = source.split('def main(lock_unchanged):', 1)[1]
        self.assertLess(main.index("'invalid candidate directory'"), main.index('require_owner_pins(candidate)'))

    def test_runner_stdin_isolated_from_app_owned_script_and_import_shadow(self):
        source = (ROOT / 'ops/deploy-personal-owner.py').read_text()
        # Exercise the real imports and argument parser without opening a host lock.
        program = source.replace("if __name__ == '__main__':", 'if False:', 1) + """
os.geteuid = lambda: 1
try:
    main(lambda: None)
except ValueError as error:
    assert str(error) == 'root host execution required'
    print('trusted-stdin-and-cli-ok')
"""
        (self.candidate / 'argparse.py').write_text("raise RuntimeError('UNTRUSTED IMPORT EXECUTED')")
        (self.candidate / 'ops/deploy-personal-owner.py').write_text("raise RuntimeError('APP-OWNED SCRIPT EXECUTED')")
        arguments = ['--candidate', str(self.candidate), '--sha', 'a' * 40, '--expected-live', 'b' * 40,
                     '--backup-sha256', 'c' * 64, '--receipt-run', '123', '--store-sha', 'd' * 40, '--store-id', '456']
        run = subprocess.run([sys.executable, '-I', '-B', '-', *arguments], input=program, text=True,
                             cwd=self.candidate, capture_output=True, timeout=10)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout.strip(), 'trusted-stdin-and-cli-ok')
        unsafe = subprocess.run([sys.executable, '-B', '-', *arguments], input=program, text=True,
                                cwd=self.candidate, capture_output=True, timeout=10)
        self.assertNotEqual(unsafe.returncode, 0)
        self.assertIn('UNTRUSTED IMPORT EXECUTED', unsafe.stderr)
        missing = subprocess.run([sys.executable, '-I', '-B', '-', *arguments[:-2]], input=program, text=True,
                                 cwd=self.candidate, capture_output=True, timeout=10)
        self.assertEqual(missing.returncode, 2)

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
        self.assertIn('tailscale ssh root@hermes "python3 -I -B - --candidate', text)
        self.assertIn('\" < ops/deploy-personal-owner.py', text)
        self.assertNotIn("python3 -B '$RELEASE_DIR/ops/deploy-personal-owner.py'", text)

        owner_tests = text.index("python3 -m unittest discover -s tests -p 'test_owner_deploy.py'")
        source_pins = text.index('python3 ops/check-owner-source.py')
        self.assertLess(owner_tests, secret)
        self.assertLess(source_pins, secret)
        self.assertLess(source_pins, text.index('Stage exact source'))
        self.assertNotIn('invite-additional-owner', text)
        self.assertNotIn('continue-on-error', text)

    def test_retained_first_release_restoration_inputs_are_unchanged(self):
        retained = {'.github/workflows/restore-staff-access.yml': '24469408263604fc9b499190953e3b178cd44ab0fdfb134b005b1d4b0bc5ac16', '.github/workflows/staff-access-checks.yml': 'c5419847cbd62603f337baf9519ec771fa4a5aae9ba3b5a1793ed06dad28c158', 'scripts/restore-staff-access.py': 'c225cba010a89f6eaf874c2e0fb8af30e9b3ab9adea53917f4b22331fb58ea8a', 'tests/test_staff_restore.py': '9a2348a82b5a024955084c4db3648c55508849f4f21c33ba7b6e2c1334a11610'}
        for relative, expected in retained.items():
            with self.subTest(path=relative):
                self.assertEqual(hashlib.sha256((ROOT / relative).read_bytes()).hexdigest(), expected)
        document = (ROOT / 'docs/PRIVATE_OWNER_ENROLLMENT_WORKFLOW.md').read_text()
        self.assertIn('Retained first-release restoration tools', document)
        for relative in retained:
            self.assertIn(relative, document)

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
            protected_paths = [*owner.OWNER_CANDIDATE_SOURCE_SHA256, *owner.UNCHANGED_OWNER_MODULES,
                               'package.json', 'package-lock.json', 'next.config.mjs', 'tsconfig.json',
                               'src/unreviewed-new-file.ts', 'src/nested/unreviewed-new-file.ts']
            protected_paths.extend(path.relative_to(ROOT).as_posix() for path in (ROOT / 'src').rglob('*') if path.is_file())
            protected_paths.extend(['.github/workflows/restore-staff-access.yml', '.github/workflows/staff-access-checks.yml', 'scripts/restore-staff-access.py', 'tests/test_staff_restore.py'])
            for path in protected_paths:
                self.assertTrue(any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns), (event, path))


if __name__ == '__main__':
    unittest.main()
