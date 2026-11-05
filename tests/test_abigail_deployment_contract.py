"""Exact Git-byte policy tests; snapshots are stubbed, not host validation."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('abigail_deployment', ROOT/'ops/deploy-abigail-update.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def git_files(commit):
    archive = subprocess.check_output(['git', 'archive', commit], cwd=ROOT)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tree:
        return {item.name: hashlib.sha256(tree.extractfile(item).read()).hexdigest()
                for item in tree if item.isfile()}


class Contract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.old = git_files(adapter.REFERENCE)
        cls.new = git_files(adapter.CANDIDATE)

    def setUp(self):
        self.profile, self.sources = adapter.read_inputs()
        self.update = adapter.prepare_review(self.profile, self.sources)

    def verify(self, old=None, new=None, uat=False):
        old = self.old if old is None else old
        new = self.new if new is None else new
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(self.update, 'stage'))
            stack.enter_context(mock.patch.object(self.update.core, 'source_manifest', side_effect=[self.profile['baselineSource'], self.profile['candidateSource']]))
            stack.enter_context(mock.patch.object(self.update.workspace_baseline, 'source_snapshot', return_value=(old, 'old-identity')))
            stack.enter_context(mock.patch.object(self.update, 'source_snapshot', return_value=(new, 'new-identity')))
            stack.enter_context(mock.patch.object(adapter.os.path, 'lexists', return_value=uat))
            return self.update.verify_sources(Path('/synthetic/old'), Path('/synthetic/new'), object())

    def test_exact_git_bytes_accept_source_policy_only(self):
        self.assertEqual(self.verify(), {'old': 'old-identity', 'new': 'new-identity'})

    def test_stale_baseline_refused(self):
        with self.assertRaises(ValueError):
            self.verify(old={**self.old, 'src/lib/auth.ts': '0'*64})

    def test_auth_database_uat_and_extra_file_drift_refused(self):
        for path in ['src/lib/auth.ts', 'db/proposed/research-v1.sql', 'ops/uat/single-restart.py', 'unexpected.txt', 'package-lock.json', '.env.uat.example']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.verify(new={**self.new, path: '0'*64})

    def test_uat_baseline_marker_refused(self):
        with self.assertRaises(ValueError):
            self.verify(uat=True)

    def test_pinned_example_present_but_actual_uat_config_refused(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as stack:
            current=Path(directory)/'old';candidate=Path(directory)/'new';current.mkdir();candidate.mkdir()
            (current/'.env.uat.example').write_text('fixture template presence')
            (candidate/'.env.uat.example').write_text('fixture template presence')
            # Hash maps below are complete verified archive maps, not fixture text.
            stack.enter_context(mock.patch.object(self.update,'stage'))
            stack.enter_context(mock.patch.object(self.update.core,'source_manifest',side_effect=lambda path:self.profile['baselineSource' if path==current else 'candidateSource']))
            stack.enter_context(mock.patch.object(self.update.workspace_baseline,'source_snapshot',return_value=(self.old,'old-identity')))
            stack.enter_context(mock.patch.object(self.update,'source_snapshot',return_value=(self.new,'new-identity')))
            self.assertEqual(self.update.verify_sources(current,candidate,object()),{'old':'old-identity','new':'new-identity'})
            for path in (current,candidate):
                (path/'.env.uat').write_text('fixture actual config')
                with self.assertRaises(ValueError):self.update.verify_sources(current,candidate,object())
                (path/'.env.uat').unlink()
                (path/'.env.uat').symlink_to(path/'nonexistent-config')
                with self.assertRaises(ValueError):self.update.verify_sources(current,candidate,object())
                (path/'.env.uat').unlink()

    def test_source_manifest_mismatch_refused(self):
        with mock.patch.object(self.update, 'stage'), mock.patch.object(self.update.core, 'source_manifest', return_value={}), self.assertRaises(ValueError):
            self.update.verify_sources(Path('/old'), Path('/new'), object())

    def test_profile_and_dependency_changes_refused(self):
        with self.assertRaises(ValueError):
            adapter.prepare_review({**self.profile, 'allowedChanges': []}, self.sources)
        name = next(iter(self.sources))
        with self.assertRaises(ValueError):
            adapter.prepare_review(self.profile, {**self.sources, name: self.sources[name]+'\n'})

    def test_caller_mutation_cannot_change_bound_policy(self):
        self.profile['allowedChanges'].clear()
        self.profile['approvedApplicationChanges'][0]['path'] = 'unreviewed'
        self.assertEqual(self.verify(), {'old': 'old-identity', 'new': 'new-identity'})

    def test_acceptance_is_pinned_and_unbound_entry_refuses(self):
        acceptance = json.loads((ROOT/'ops/abigail-deployment-acceptance.json').read_text())
        self.assertIs(acceptance['deploymentAccepted'], True)
        self.assertEqual(adapter.require_acceptance((ROOT/'ops/abigail-deployment-acceptance.json').read_text()),acceptance)
        for key in ('actualBaseline', 'runtimeAcceptance', 'schemaAcceptance', 'hostAcceptance'):
            self.assertIsInstance(acceptance[key],dict)
        with self.assertRaisesRegex(ValueError, 'Deployment disabled'):
            adapter.entry(deploymentAccepted=True)
        for invoke in (self.update.entry, self.update.deploy):
            with self.assertRaisesRegex(ValueError, 'Deployment disabled'):
                invoke(object())

    def test_inherited_release_primitives_and_uat_policy_preserved(self):
        self.assertEqual(self.update.workspace_pwa.BASE_SHA, adapter.REFERENCE)
        self.assertIs(self.update.deploy, adapter.entry)
        for name in ('rehearse_both', 'source_snapshot'):
            self.assertTrue(callable(getattr(self.update, name)))
        self.assertTrue(callable(self.update.core.activate))
        values = {'BUBBLEWASH_STAFF_AUTH_DISABLED': 'false', 'BUBBLEWASH_BOOKINGS_DISABLED': 'true', 'BUBBLEWASH_DISABLE_DEMO_LOGIN': 'true', 'NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED': 'false'}
        self.update.open_configuration(values)
        with self.assertRaises(ValueError):
            self.update.open_configuration({**values, 'BUBBLEWASH_UAT_ENABLED': 'true'})


if __name__ == '__main__':
    unittest.main()
