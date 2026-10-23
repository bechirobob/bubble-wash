"""Exact integration selectors and fail-closed source checks. Synthetic/local only."""
import ast
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
ns = {'__name__': 'enrollment_contract_tests'}
for name in ('release-preflight.py', 'owner-enrollment-source-contract.py', 'owner-enrollment-host.py'):
    exec(compile((ROOT / 'scripts' / name).read_text(), name, 'exec'), ns)
CONTRACT = json.loads((ROOT / 'ops/owner-enrollment-integration-pins.json').read_text())
PROFILE_IDS = ('integration-candidate-v1', 'integration-fallback-v1')


def canonical_sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


class ExactProfileTests(unittest.TestCase):
    def test_exact_records_accept_and_cannot_mix_profiles_or_select_unknown(self):
        for name in PROFILE_IDS:
            profile = ns['load_integration_enrollment_profile'](CONTRACT, name)
            self.assertTrue(ns['integration_enrollment_profile_valid'](profile, name))
            other = next(key for key in PROFILE_IDS if key != name)
            self.assertFalse(ns['integration_enrollment_profile_valid'](profile, other))
            for mutation in ('unknown', 'partial', 'alternate-file', 'extra-key', 'nonfinite'):
                changed = copy.deepcopy(profile)
                if mutation == 'unknown': changed['sourceContract'] = 'anything'
                elif mutation == 'partial': changed['sourceFiles'].pop('src/lib/auth.ts')
                elif mutation == 'alternate-file': changed['sourceFiles']['package.json'] = CONTRACT['profiles'][other]['sourceFiles']['package.json']
                elif mutation == 'extra-key': changed['permissive'] = True
                else: changed['invalid'] = float('nan')
                self.assertFalse(ns['integration_enrollment_profile_valid'](changed, name), mutation)
        for name in ('', '../owner-enrollment-source-pins.json', 'integration', 'historical-owner-v1'):
            with self.assertRaises(ValueError): ns['load_integration_enrollment_profile'](CONTRACT, name)
        for name in (None, [], {}, True):
            self.assertFalse(ns['integration_enrollment_profile_valid'](CONTRACT['profiles'][PROFILE_IDS[0]], name))

    def test_contract_shape_and_even_unselected_record_must_be_exact(self):
        for action in ('unknown-record', 'missing-record', 'wrong-schema', 'extra-top-key', 'wrong-type', 'other-record-drift'):
            contract = copy.deepcopy(CONTRACT)
            if action == 'unknown-record': contract['profiles']['other'] = {}
            elif action == 'missing-record': del contract['profiles'][PROFILE_IDS[1]]
            elif action == 'wrong-schema': contract['schema'] = 'v2'
            elif action == 'extra-top-key': contract['allow'] = True
            elif action == 'wrong-type': contract['profiles'] = []
            else: contract['profiles'][PROFILE_IDS[1]]['sourceFiles']['src/lib/auth.ts'] = '0' * 64
            with self.subTest(action=action), self.assertRaises(ValueError):
                ns['load_integration_enrollment_profile'](contract, PROFILE_IDS[0])

    def test_owner_auth_transport_and_historical_guard_are_unchanged(self):
        historical = json.loads((ROOT / 'ops/owner-enrollment-source-pins.json').read_text())
        unchanged = ('scripts/invite-additional-owner.mjs', 'src/lib/staff-accounts.ts', 'src/lib/admin-mfa.ts',
                     'src/lib/auth.ts', 'src/lib/passwords.ts', 'src/lib/mfa-encryption.ts', 'src/lib/staff-identity.ts',
                     'src/app/api/login/route.ts', 'src/app/api/admin/mfa/enroll/route.ts',
                     'src/app/api/staff/accounts/route.ts', 'src/components/LoginPage.tsx', 'package-lock.json')
        for profile in CONTRACT['profiles'].values():
            self.assertEqual({key: profile['sourceFiles'][key] for key in unchanged}, {key: historical[key] for key in unchanged})
            for path in ('src/lib/notification-outbox-schema.ts', 'scripts/migrate-notification-outbox.mjs',
                         'tests/owner-outbox-invitation.test.mjs', 'tests/outbox-migration-rollback.test.mjs'):
                self.assertIn(path, profile['sourceFiles'])
        for path, expected in {
            'ops/owner-enrollment-source-pins.json': '1949578fa9237833d15d1266d4e3f26128521a765becbf9778e84e2698eb381f',
            'ops/deploy-personal-owner.py': '822e84d2bf7993a10e7e202659374d9c638ed9a61a7ad303300690ecc4021aaa',
            'ops/check-owner-source.py': 'afefcf8e7747bb3f93ea2222763a55148a4123cb83a9697fbeabd4120a2c8458',
            'scripts/release-preflight.py': '35c2b2b2ff9943d9989c97568e8a9da5735c8970e99d863297f15c8970df1a1a',
        }.items():
            self.assertEqual(hashlib.sha256((ROOT / path).read_bytes()).hexdigest(), expected, path)

    def test_selected_host_gate_never_automatically_falls_back(self):
        historical = Mock(return_value=False)
        integrated = Mock(return_value=True)
        with patch.dict(ns, enrollment_source_matches=historical, integration_enrollment_source_matches=integrated):
            self.assertFalse(ns['selected_enrollment_source_matches'](ROOT, {}, 'historical-owner-v1'))
            integrated.assert_not_called()
            historical.reset_mock()
            self.assertTrue(ns['selected_enrollment_source_matches'](ROOT, {}, PROFILE_IDS[0]))
            historical.assert_not_called()
            integrated.assert_called_once_with(ROOT, {}, PROFILE_IDS[0])

    def test_host_rechecks_identical_selector_and_profile_before_child(self):
        source = (ROOT / 'scripts/owner-enrollment-host.py').read_text()
        tree = ast.parse(source)
        run = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'run_private_enrollment')
        checks = [node for node in ast.walk(run) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'selected_enrollment_source_matches']
        self.assertEqual(len(checks), 2)
        for call in checks:
            self.assertEqual([node.id for node in call.args], ['release', 'pins', 'source_contract'])

    def test_unknown_and_changed_host_profiles_stop_before_inspection_or_spawn(self):
        profile = copy.deepcopy(CONTRACT['profiles'][PROFILE_IDS[0]])
        profile['sourceFiles']['src/lib/auth.ts'] = '0' * 64
        collect = Mock(side_effect=AssertionError('Private inspection must not run'))
        with patch.dict(ns, CURRENT=ROOT, release_pin_matches=lambda _: True, collect=collect), patch.object(ns['subprocess'], 'Popen') as spawn:
            for selected, pins in [('unknown', {}), (PROFILE_IDS[0], profile), (PROFILE_IDS[1], CONTRACT['profiles'][PROFILE_IDS[0]])]:
                result = ns['run_private_enrollment']('synthetic@example.invalid', 'a' * 40, 'actor', 'check', False,
                                                       pins, 'synthetic-owner-key', selected)
                self.assertEqual(result, {'ok': False, 'state': 'owner-source-pin-mismatch', 'accountCreated': False})
            collect.assert_not_called(); spawn.assert_not_called()


class SourceFilesystemTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'release'; self.root.mkdir()
        self.files = {'src/core.ts': b'core', 'src/nested/auth.ts': b'auth', 'public/icon.svg': b'icon',
                      'db/schema.sql': b'schema', 'scripts/invite.mjs': b'invite', 'package-lock.json': b'lock'}
        for name, data in self.files.items():
            path = self.root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
        self.profile = {'sourceContract': PROFILE_IDS[0], 'sourceFiles': {key: hashlib.sha256(value).hexdigest() for key, value in self.files.items()}}
        patched = {PROFILE_IDS[0]: canonical_sha(self.profile)}
        self.patcher = patch.dict(ns, INTEGRATION_ENROLLMENT_PROFILE_SHA256=patched)
        self.patcher.start(); self.addCleanup(self.patcher.stop)

    def matches(self, root=None, profile=None, selector=PROFILE_IDS[0]):
        return ns['integration_enrollment_source_matches'](root or self.root, profile or self.profile, selector)

    def test_exact_fixture_only_and_unknown_combination_rejected(self):
        self.assertTrue(self.matches())
        self.assertFalse(self.matches(selector=PROFILE_IDS[1]))
        partial = copy.deepcopy(self.profile); del partial['sourceFiles']['src/core.ts']
        self.assertFalse(self.matches(profile=partial))

    def test_every_pinned_file_change_or_absence_rejected(self):
        for name, content in self.files.items():
            path = self.root / name
            path.write_bytes(content + b'changed'); self.assertFalse(self.matches(), name)
            path.unlink(); self.assertFalse(self.matches(), name)
            path.write_bytes(content); self.assertTrue(self.matches(), name)

    def test_additions_in_each_complete_source_root_rejected(self):
        for name in ('src', 'public', 'db'):
            path = self.root / name / 'unreviewed'; path.write_text('extra')
            self.assertFalse(self.matches(), name); path.unlink()
        # Runtime data and generated build output are intentionally outside the source contract.
        (self.root / 'runtime-data').write_text('not read')
        self.assertTrue(self.matches())

    def test_symlinked_files_parent_directories_and_root_rejected(self):
        path = self.root / 'src/core.ts'; content = path.read_bytes(); path.unlink()
        target = self.root / 'same-content'; target.write_bytes(content); path.symlink_to(target)
        self.assertFalse(self.matches()); path.unlink(); path.write_bytes(content)
        for name in ('src/nested', 'scripts'):
            directory = self.root / name; moved = directory.with_name(directory.name + '-target')
            directory.rename(moved); directory.symlink_to(moved, target_is_directory=True)
            self.assertFalse(self.matches(), name); directory.unlink(); moved.rename(directory)
        alias = self.root.parent / 'alias'; alias.symlink_to(self.root, target_is_directory=True)
        self.assertFalse(self.matches(root=alias))

    def test_nonregular_extra_file_is_rejected_without_reading(self):
        fifo = self.root / 'src/fifo'; os.mkfifo(fifo)
        self.assertFalse(self.matches()); fifo.unlink()
        file = self.root / 'src/core.ts'; file.unlink(); os.mkfifo(file)
        self.assertFalse(self.matches())


class RunnerTransportTests(unittest.TestCase):
    def stream(self, selector):
        env = {**os.environ, 'OWNER_EMAIL': 'synthetic@example.invalid', 'BUBBLEWASH_OWNER_RESEND_KEY': 'synthetic-owner-key',
               'EXPECTED_LIVE_SHA': 'a' * 40, 'GITHUB_ACTOR': 'actor', 'ENROLLMENT_MODE': 'check',
               'DELIVERY_APPROVED': 'false'}
        env.pop('ENROLLMENT_SOURCE_CONTRACT', None)
        if selector is not None: env['ENROLLMENT_SOURCE_CONTRACT'] = selector
        return subprocess.run([sys.executable, '.github/backup/stream_owner_enrollment.py'], cwd=ROOT, env=env,
                              capture_output=True, text=True, timeout=10)

    def test_missing_selector_defaults_historical_not_integration(self):
        run = self.stream(None); self.assertEqual(run.returncode, 0)
        call = next(node for node in ast.walk(ast.parse(run.stdout)) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'run_private_enrollment')
        self.assertEqual(ast.literal_eval(call.args[-1]), 'historical-owner-v1')
        self.assertEqual(ast.literal_eval(call.args[5]), json.loads((ROOT / 'ops/owner-enrollment-source-pins.json').read_text()))

    def test_both_explicit_selectors_stream_only_exact_selected_profile(self):
        for selector in PROFILE_IDS:
            run = self.stream(selector); self.assertEqual(run.returncode, 0)
            tree = ast.parse(run.stdout)
            call = next(node for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'run_private_enrollment')
            self.assertEqual(ast.literal_eval(call.args[-1]), selector)
            self.assertEqual(ast.literal_eval(call.args[5]), CONTRACT['profiles'][selector])
            guard = "\nrelease_pin_matches = lambda _: False\n"
            program = run.stdout.replace('\ntry:\n    _result = run_private_enrollment(', guard + '\ntry:\n    _result = run_private_enrollment(')
            executed = subprocess.run([sys.executable, '-I', '-B', '-'], input=program, cwd=ROOT, capture_output=True, text=True, timeout=10)
            self.assertEqual(executed.returncode, 1); self.assertEqual(executed.stderr, '')
            self.assertEqual(json.loads(executed.stdout), {'ok': False, 'state': 'release-pin-mismatch', 'accountCreated': False})
            self.assertNotIn('synthetic', executed.stdout)

    def test_unknown_selector_emits_nothing(self):
        for selector in ('', 'integration-any', '../pins.json'):
            run = self.stream(selector); self.assertNotEqual(run.returncode, 0); self.assertEqual(run.stdout, '')
            self.assertNotIn('synthetic', run.stderr)

    def test_workflow_keeps_explicit_host_choice_separate_from_runner(self):
        source = (ROOT / '.github/workflows/owner-enrollment.yml').read_text()
        self.assertIn('default: historical-owner-v1', source)
        self.assertIn('options: [historical-owner-v1, integration-candidate-v1, integration-fallback-v1]', source)
        self.assertIn('python3 ops/check-owner-enrollment-source.py --verify-runner', source)
        self.assertIn('ENROLLMENT_SOURCE_CONTRACT: ${{ inputs.source_contract }}', source)
        self.assertIn('default: check', source); self.assertIn('default: false', source)
        self.assertNotIn('continue-on-error', source)


if __name__ == '__main__':
    unittest.main()
