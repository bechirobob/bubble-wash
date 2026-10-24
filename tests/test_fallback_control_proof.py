import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('fallback_proof', ROOT/'ops/integration-release/prove_fallback.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

class ProofTests(unittest.TestCase):
    def test_exact_accepted_identity(self):
        self.assertEqual(p.FALLBACK['commit'], '80ec00902fcc5fe16a17ab814c7d191ad44afb64')
        self.assertEqual(p.FALLBACK['tree'], 'c90fe5e836022d8084d0f8f936e5d00bb8522be6')
        self.assertEqual(p.FALLBACK['files'], 331)
    def test_historical_failure_not_relabelled(self):
        self.assertEqual(p.HISTORICAL_EVIDENCE['backup']['conclusion'], 'failure')
        self.assertTrue(p.HISTORICAL_EVIDENCE['backup']['retainedAsHistoricalFailure'])
    def test_only_two_test_files_overlay(self):
        self.assertEqual(set(p.OVERLAY), {'.github/backup/test_owner_enrollment.py','tests/test_owner_deploy.py'})
    def test_arbitrary_test_preimage_refused(self):
        for name in p.OVERLAY:
            with self.assertRaises(ValueError): p.patched_bytes(name, b'arbitrary')
    def test_production_overlay_refused(self):
        with self.assertRaises(ValueError): p.patched_bytes('src/lib/auth.ts', b'')
    def test_suite_skips_and_short_counts_refused(self):
        for name, (_, _, count) in p.SUITES.items():
            good = dict(name=name, testsRun=count, failures=0, errors=0, skipped=0, expectedFailures=0, unexpectedSuccesses=0, successful=True)
            self.assertTrue(p.suite_passed(good,name))
            for key in ('failures','errors','skipped','expectedFailures','unexpectedSuccesses'):
                self.assertFalse(p.suite_passed(dict(good, **{key:1}),name))
            self.assertFalse(p.suite_passed(dict(good,testsRun=count-1),name))
    def test_unexpected_source_bytes_refused(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);(root/'file').write_text('fixture')
            with self.assertRaises(ValueError):p.verify_pristine(root)
    def test_symlink_refused(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);(root/'a').write_text('x');(root/'b').symlink_to('a')
            with self.assertRaises(ValueError):p.snapshot(root)
    def test_hardlink_refused(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);(root/'a').write_text('x');os.link(root/'a',root/'b')
            with self.assertRaises(ValueError):p.snapshot(root)
    def test_empty_untracked_directory_refused(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);(root/'empty').mkdir()
            with self.assertRaises(ValueError):p.snapshot(root)
    def test_mode_and_content_both_bound(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);f=root/'a';f.write_text('x');first=p.snapshot(root)
            f.chmod(0o755);second=p.snapshot(root)
            self.assertNotEqual(first['tree'],second['tree'])
            f.write_text('y');self.assertNotEqual(second['contentSha256'],p.snapshot(root)['contentSha256'])

if __name__ == '__main__':unittest.main()
