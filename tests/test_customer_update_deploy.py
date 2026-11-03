"""Synthetic checks for the exact customer transition; no host/provider actions."""
import copy
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('customer_release', ROOT/'ops/deploy-customer-update.py')
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
PINS, SOURCES = c.read_inputs()


class CustomerControls(unittest.TestCase):
    def setUp(self):
        self.update = c.configure(copy.deepcopy(PINS), SOURCES)

    def test_exact_transition_and_dependency_bytes_cannot_be_changed(self):
        for field, value in [('schema', 'other'), ('baseSha', 'a'*40), ('runtimeSha', 'b'*40),
                             ('providerPair', ['a'*64]*2), ('criticalFiles', [])]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                c.configure({**PINS, field: value}, SOURCES)
        for name in SOURCES:
            with self.subTest(name=name), self.assertRaises(ValueError):
                c.configure(PINS, {**SOURCES, name: SOURCES[name]+'\n'})
        with self.assertRaises(ValueError): c.configure(PINS, {**SOURCES, 'extra.py': ''})

    def test_historical_pins_stay_separate_and_baseline_has_exact_uat_example(self):
        historical = json.loads((ROOT/'ops/workspace-update-source-pins.json').read_bytes())
        for name, digest in historical['dependencies'].items():
            self.assertEqual(PINS['dependencies'][name], digest)
        self.assertEqual(PINS['dependencies']['deploy-workspace-update.py'], hashlib.sha256((ROOT/'ops/deploy-workspace-update.py').read_bytes()).hexdigest())
        self.assertEqual(historical['baseSha'], 'f7305933b15a285bbd393a2057bf5d27e4b9985c')
        self.assertEqual(self.update.customer_workspace.BASE_SHA, c.BASE_SHA)
        self.assertEqual(self.update.workspace_pwa.BASE_SHA, c.BASE_SHA)
        self.assertEqual(self.update.workspace_pwa.STATE/ 'releases'/c.BASE_SHA,
                         Path('/var/lib/bubblewash-release/releases/1406b0e217ed02709ebe1c423aecb42c6be5b0aa'))
        self.assertEqual(self.update.workspace_pwa.JOURNAL_TARGET_SHA, '5f256800d65dbe3b69f54e95afa0e8ab30b5e881')
        self.assertEqual(PINS['baselineContent'], historical['runtimeContent'])
        self.assertEqual(PINS['baselineSource'], historical['candidateSource'])
        for scope in ('baselineScope', 'sourceScope'):
            self.assertIn('.env.uat.example', PINS[scope]['rootFiles'])
            self.assertEqual(set(PINS[scope]['excludedSubtrees']), {'tooling/next-eslint-glob/node_modules', 'tooling/minimatch-compat/node_modules'})

    def test_complete_pins_protect_all_existing_api_auth_data_and_dependency_inputs(self):
        self.assertEqual(PINS['baseSha'], c.BASE_SHA)
        self.assertEqual(PINS['runtimeSha'], c.RUNTIME_SHA)
        self.assertEqual(PINS['runtimeContent']['files'], 652)
        self.assertEqual(len(PINS['allowedChanges']), 36)
        self.assertEqual([p for p in PINS['allowedChanges'] if p.startswith(c.PROTECTED_PREFIXES)], ['src/lib/pricing-history.ts'])
        self.assertFalse(set(c.PROTECTED_FILES) & set(PINS['allowedChanges']))
        self.assertEqual(PINS['providerPair'], [c.PROVIDER_HASH]*2)

    def test_strict_source_checks_reject_changes_even_with_consistent_mutated_pins(self):
        old = {name: 'same' for name in c.PROTECTED_FILES}
        old.update({'src/lib/auth.ts': 'same', 'src/app/api/login/route.ts': 'same', 'db/proposed/research-v1.sql': 'same', 'src/lib/research/provider.ts': c.PROVIDER_HASH})
        new = {**old, 'src/lib/pricing-history.ts': 'new-helper'}
        public = copy.deepcopy(PINS)
        public.update(baselineContent=self.update.content_commitment(old), runtimeContent=self.update.content_commitment(new), allowedChanges=['src/lib/pricing-history.ts'])
        u = c.configure(public, SOURCES)
        with tempfile.TemporaryDirectory() as d:
            current, candidate = Path(d)/'old', Path(d)/'new'
            current.mkdir(); candidate.mkdir()
            with patch.object(u.core, 'source_manifest', side_effect=lambda p: public['baselineSource'] if p == current else public['candidateSource']), patch.object(u.workspace_baseline, 'source_snapshot', side_effect=lambda *_: (dict(old), {'baseline': True})), patch.object(u, 'source_snapshot', side_effect=lambda *_: (dict(new), {'candidate': True})):
                self.assertEqual(u.verify_sources(current, candidate, None), {'old': {'baseline': True}, 'new': {'candidate': True}})
                for name in old:
                    original = new[name]; new[name] = 'changed'
                    public['runtimeContent'] = u.content_commitment(new)
                    public['allowedChanges'] = sorted(['src/lib/pricing-history.ts', name])
                    with self.subTest(name=name), self.assertRaises(ValueError): u.verify_sources(current, candidate, None)
                    new[name] = original
                public['runtimeContent'] = u.content_commitment(new)
                public['allowedChanges'] = []
                with self.assertRaises(ValueError): u.verify_sources(current, candidate, None)
                public['allowedChanges'] = ['src/lib/pricing-history.ts']; new['unexpected'] = 'extra'
                with self.assertRaises(ValueError): u.verify_sources(current, candidate, None)

    def test_unknown_root_files_refused_by_both_scanners(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); (root/'.config').mkdir()
            for scanner in (self.update.source_snapshot, self.update.workspace_baseline.source_snapshot):
                with self.assertRaises(ValueError): scanner(root, types.SimpleNamespace(pw_uid=os.getuid()))

    def test_runtime_config_and_build_guards_are_inherited_unchanged(self):
        values = {'BUBBLEWASH_STAFF_AUTH_DISABLED': 'false', 'BUBBLEWASH_BOOKINGS_DISABLED': 'true', 'BUBBLEWASH_DISABLE_DEMO_LOGIN': 'true', 'NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED': 'false'}
        original = dict(values); self.update.workspace_pwa.configuration(values); self.assertEqual(values, original)
        for value in ('true', 'false', '', 'other'):
            with self.assertRaises(ValueError): self.update.workspace_pwa.configuration({**values, 'BUBBLEWASH_UAT_ENABLED': value})
        with self.assertRaises(ValueError): self.update.workspace_pwa.configuration({**values, 'BUBBLEWASH_BOOKINGS_DISABLED': 'false'})
        with self.assertRaises(ValueError): self.update.core.command(['systemd-run', '--unit=unbound-build', '/bin/bash', '-c', 'npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund'])
        self.assertIn('XDG_CONFIG_HOME=', SOURCES['deploy-workspace-update.py'])
        self.assertIn('st.mtimeNs', SOURCES['deploy-workspace-update.py'])
        self.assertIn('Native runtime verified', self.update.customer_workspace.NATIVE_CHECK)

    def test_freeze_rehearsals_activation_and_code_only_rollback_not_replaced(self):
        source = inspect.getsource(c.configure)
        for forbidden in ('update.deploy =', 'update.rehearse_both =', 'core.activate =', 'update.core.command =', 'update.core.check_runtime ='):
            self.assertNotIn(forbidden, source)
        self.assertIn('workspace.configure(', source)
        self.assertEqual(self.update.core.activate.__name__, 'activate')
        self.assertEqual(self.update.rehearse_both.__name__, 'rehearse_both')

    def test_workflow_is_manual_pinned_and_keeps_guard_and_native_regression_suites(self):
        workflow = (ROOT/'.github/workflows/customer-update-deploy.yml').read_text()
        self.assertIn('workflow_dispatch:', workflow); self.assertNotIn('\n  push:', workflow)
        self.assertIn('"$GITHUB_RUN_ATTEMPT" == 1', workflow)
        self.assertIn("--expected-live '"+c.BASE_SHA+"'", workflow)
        for flag in ('--check-runtime', '--check-hosted-runs', '--emit'):
            self.assertIn('python3 -B ops/deploy-customer-update.py '+flag, workflow)
        for name in ('test_pwa_update_deploy.py', 'test_workspace_update_deploy.py', 'test_customer_update_deploy.py'):
            self.assertIn(name, workflow)
        self.assertEqual(workflow.count('tailscale/github-action@'), 1)
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertNotIn('inspect_owner', workflow)

    def test_hosted_run_gate_requires_exact_first_attempt_runtime(self):
        run = {'head_sha': c.RUNTIME_SHA, 'path': '.github/workflows/browser-regression.yml', 'event': 'push', 'status': 'completed', 'conclusion': 'success', 'run_attempt': 1, 'head_repository': {'full_name': 'bechirobob/bubble-wash'}, 'repository': {'full_name': 'bechirobob/bubble-wash'}}
        self.update.verify_hosted_run(run, c.RUNTIME_SHA, run['path'])
        for change in ({'head_sha': c.BASE_SHA}, {'run_attempt': 2}, {'conclusion': 'failure'}, {'event': 'pull_request'}):
            with self.assertRaises(ValueError): self.update.verify_hosted_run({**run, **change}, c.RUNTIME_SHA, run['path'])


if __name__ == '__main__': unittest.main()
