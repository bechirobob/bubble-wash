import os,tempfile,types,unittest
from pathlib import Path
from unittest.mock import Mock,patch
import retained_update_diagnostic as d
from live_host_adapter import PIN_NAMES
class Tests(unittest.TestCase):
 def setUp(self):
  self.pins={'runtimeRevision':'f4fd4ce424c2b363fc5a2196432e0ac2ce7c05a1','runtimeFiles':{n:'a'*64 for n in PIN_NAMES},'unitSha256':'b'*64}
  self.c=types.SimpleNamespace(collect_restart_isolation=Mock(return_value={'verified':True}),command=Mock(return_value='v22.1.0'),read=Mock(return_value=b'MemAvailable: 2097152 kB\n'),trusted=Mock())
  self.r=types.SimpleNamespace(c=self.c,loaded_unit=Mock(return_value={}),quiet_sample=Mock(return_value=None))
 def test_only_booleans_and_fixed_names_expiry_mismatch(self):
  with patch.object(d,'database_commitments',return_value={'expiry':18095,'accounts':'PRIVATE'}),patch.object(d.os,'statvfs',return_value=types.SimpleNamespace(f_bavail=10,f_frsize=1024**3)),patch.object(d,'retained_metadata',return_value={}):r=d.diagnose(self.r,self.pins,10000,18095)
  self.assertFalse(r['guards']['expiry-matches-request']);self.assertTrue(r['guards']['expiry-matches-observed']);self.assertEqual(set(r['guards']),set(d.GUARDS));self.assertTrue(all(type(x)is bool for x in r['guards'].values()));self.assertNotIn('PRIVATE',repr(r));self.assertNotIn('18095',repr(r))
 def test_failed_runtime_never_opens_database(self):
  self.c.collect_restart_isolation.side_effect=RuntimeError('PRIVATE')
  with patch.object(d,'database_commitments') as db,patch.object(d,'retained_metadata',side_effect=RuntimeError()):r=d.diagnose(self.r,self.pins,1,2)
  db.assert_not_called();self.assertFalse(r['guards']['runtime-original']);self.assertNotIn('PRIVATE',repr(r))
 def test_metadata_never_changes_files(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);(root/'journal').mkdir(mode=0o700)
   for name in ('artifact.tar.gz','host.lock'):(root/name).write_bytes(b'synthetic');(root/name).chmod(0o600)
   # Mock root ownership only; actual fixture metadata is not changed.
   real=Path.lstat
   def root_owned(path):
    info=list(real(path));info[4]=0;return os.stat_result(info)
   patcher=patch.object(Path,'lstat',root_owned);patcher.start();self.addCleanup(patcher.stop)
   before={p.name:p.stat().st_mtime_ns for p in root.iterdir()};r=d.retained_metadata(root)
   self.assertTrue(r['transaction-not-started-evidence']);self.assertEqual(before,{p.name:p.stat().st_mtime_ns for p in root.iterdir()})
   (root/'journal/active-operation').write_text('synthetic')
   self.assertFalse(d.retained_metadata(root)['transaction-not-started-evidence'])
 def test_bad_pins_fail_before_any_host_read(self):
  r=d.diagnose(self.r,{},1,2);self.c.collect_restart_isolation.assert_not_called();self.assertFalse(any(r['guards'].values()))
