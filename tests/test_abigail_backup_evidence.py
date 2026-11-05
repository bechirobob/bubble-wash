"""Evidence binding only; never substitutes for live-schema/deployment acceptance."""
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_SHA = 'c7531ca8e598422bd8d63da6fdaaf0377c7c16ad8ba5c28b286fc4d8e2dc2f5b'

class BackupEvidence(unittest.TestCase):
    def setUp(self):
        self.raw = (ROOT/'ops/abigail-backup-evidence.json').read_bytes()
        self.evidence = json.loads(self.raw)
        self.pins = json.loads((ROOT/'ops/abigail-deployment-source-pins.json').read_text())

    def test_exact_successful_inspection_record(self):
        self.assertEqual(hashlib.sha256(self.raw).hexdigest(), EVIDENCE_SHA)
        a = self.evidence['attestation']
        self.assertEqual(a['context']['runId'], '42039240864')
        self.assertEqual(a['context']['runAttempt'], '1')
        self.assertTrue(a['scratchRemoved'])
        self.assertTrue(a['snapshotOnly'])
        self.assertFalse(a['liveDatabaseOpened'])
        self.assertFalse(a['liveSchemaVerified'])

    def test_attested_runtime_matches_existing_source_profile(self):
        a = self.evidence['attestation']
        self.assertEqual(a['context']['runtimeSha'], self.pins['baseSha'])
        self.assertEqual(a['runtimeContentSha256'], self.pins['baselineContent']['sha256'])

    def test_schema_hashes_are_distinct_and_not_live_acceptance(self):
        a = self.evidence['attestation']
        for key in ('schemaBeforeSha256', 'schemaAfterSha256', 'permissionDdlSha256'):
            self.assertRegex(a[key], r'^[a-f0-9]{64}$')
        self.assertNotEqual(a['schemaBeforeSha256'], a['schemaAfterSha256'])
        self.assertIsNone(self.evidence['liveSchemaAcceptance'])
        self.assertFalse(self.evidence['deploymentAccepted'])

    def test_all_existing_dependency_bytes_match(self):
        for path, digest in self.pins['dependencies'].items():
            with self.subTest(path=path):
                self.assertEqual(hashlib.sha256((ROOT/'ops'/path).read_bytes()).hexdigest(), digest)

    def test_evidence_does_not_enable_any_entrypoint(self):
        acceptance = json.loads((ROOT/'ops/abigail-deployment-acceptance.json').read_text())
        self.assertIs(acceptance['deploymentAccepted'], True)
        for key in ('actualBaseline','runtimeAcceptance','schemaAcceptance','hostAcceptance'):
            self.assertIsInstance(acceptance[key],dict)
        spec = importlib.util.spec_from_file_location('abigail_disabled', ROOT/'ops/deploy-abigail-update.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        update = module.prepare_review(*module.read_inputs())
        for invoke in (module.entry, update.entry, update.deploy):
            with self.assertRaisesRegex(ValueError, 'Deployment disabled'):
                invoke(deploymentAccepted=True, evidence=self.evidence)

if __name__ == '__main__':
    unittest.main()
