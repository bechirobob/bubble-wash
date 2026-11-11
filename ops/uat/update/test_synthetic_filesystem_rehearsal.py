import unittest
from pathlib import Path
from synthetic_filesystem_rehearsal import SyntheticAdapter,rehearse

class FilesystemTests(unittest.TestCase):
    def test_refuses_host_and_nonfixture_roots(self):
        for path in ('/opt','/var','/etc','/tmp','/workspace/shared','/tmp/not-a-synthetic-root'):
            with self.subTest(path=path),self.assertRaises(ValueError):SyntheticAdapter(Path(path))
    def test_real_sqlite_snapshot_and_switch(self):
        r=rehearse();self.assertEqual(r['state'],'verified')
        for key in ('databaseUnchanged','snapshotRetained','rollbackRetained','candidateActive','startCalled'):self.assertTrue(r[key])
        self.assertEqual(r['switchCalls'],1)
    def test_before_switch_no_retry(self):
        r=rehearse('before-switch');self.assertEqual(r['state'],'inspection-required');self.assertFalse(r['rollbackRetained']);self.assertFalse(r['startCalled']);self.assertTrue(r['databaseUnchanged']);self.assertTrue(r['snapshotRetained'])
    def test_between_renames_retains_old_code(self):
        r=rehearse('between-renames');self.assertEqual(r['state'],'inspection-required');self.assertTrue(r['rollbackRetained']);self.assertFalse(r['candidateActive']);self.assertFalse(r['startCalled']);self.assertTrue(r['databaseUnchanged'])
    def test_after_switch_no_auto_restart_or_restore(self):
        r=rehearse('after-switch');self.assertEqual(r['state'],'inspection-required');self.assertTrue(r['rollbackRetained']);self.assertTrue(r['candidateActive']);self.assertFalse(r['startCalled']);self.assertTrue(r['databaseUnchanged']);self.assertEqual(r['switchCalls'],1)
    def test_config_and_account_drift_refused_not_restored(self):
        for failure in ('config-drift','account-drift'):
            r=rehearse(failure);self.assertEqual(r['state'],'inspection-required');self.assertEqual(r['stage'],'postverify');self.assertTrue(r['rollbackRetained'])
            if failure=='account-drift':self.assertFalse(r['databaseUnchanged'])

if __name__=='__main__':unittest.main()
