import hashlib,os,tempfile,types,unittest
from pathlib import Path
from unittest.mock import Mock,patch
import archive_preflight as a
class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.work=self.root/'update';self.work.mkdir(mode=0o700);(self.work/'journal').mkdir(mode=0o700)
  for name,data in (('artifact.tar.gz',b'synthetic'),('host.lock',b'')):(self.work/name).write_bytes(data);(self.work/name).chmod(0o600)
  self.fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
  self.r=types.SimpleNamespace(c=types.SimpleNamespace(collect_restart_isolation=Mock(return_value={'original':True})),loaded_unit=Mock(return_value={'safe':True}),quiet_sample=Mock(return_value=None))
  self.real=a.open_checked
  def fixture_open(parent,name,directory,mode):
   fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|(os.O_DIRECTORY if directory else 0),dir_fd=parent);info=os.fstat(fd)
   if (info.st_mode&0o777)!=mode:os.close(fd);raise ValueError('mode')
   return fd,info
  self.patches=[patch.object(a,'ARTIFACT_SIZE',9),patch.object(a,'ARTIFACT_SHA',hashlib.sha256(b'synthetic').hexdigest()),patch.object(a,'open_checked',fixture_open),patch.object(a,'database_commitments',return_value={'expiry':1794457808095})]
  for p in self.patches:p.start()
 def tearDown(self):
  for p in reversed(self.patches):p.stop()
  os.close(self.fd);self.tmp.cleanup()
 def run_archive(self):return a._archive(self.fd,self.r,{'runtimeRevision':a.ORIGINAL})
 def test_verified_retains_all_bytes(self):
  self.assertEqual(self.run_archive(),{'archived':True,'automaticRetry':False,'serviceChanged':False});self.assertFalse(self.work.exists());self.assertEqual((self.root/a.ARCHIVE/'artifact.tar.gz').read_bytes(),b'synthetic');self.assertTrue((self.root/a.ARCHIVE/'journal').is_dir())
 def test_destination_never_replaced(self):
  (self.root/a.ARCHIVE).mkdir();self.assertFalse(self.run_archive()['archived']);self.assertTrue(self.work.exists())
 def test_active_journal_refused(self):
  (self.work/'journal/active-operation').touch();self.assertFalse(self.run_archive()['archived']);self.assertTrue(self.work.exists())
 def test_unknown_or_snapshot_refused(self):
  (self.work/'snapshot.sqlite').touch();self.assertFalse(self.run_archive()['archived']);self.assertTrue(self.work.exists())
 def test_artifact_hash_refused(self):
  (self.work/'artifact.tar.gz').write_bytes(b'different');self.assertFalse(self.run_archive()['archived']);self.assertTrue(self.work.exists())
 def test_expiry_mismatch_no_rename(self):
  with patch.object(a,'database_commitments',return_value={'expiry':1794457800000}):self.assertFalse(self.run_archive()['archived'])
  self.assertTrue(self.work.exists())
 def test_guard_failure_no_rename(self):
  self.r.quiet_sample.side_effect=ValueError('private');self.assertEqual(self.run_archive(),{'archived':False,'automaticRetry':False,'serviceChanged':False});self.assertTrue(self.work.exists())
 def test_post_rename_failure_retained_no_rollback(self):
  self.r.c.collect_restart_isolation.side_effect=[{'original':True},{'original':True},ValueError('private')]
  self.assertFalse(self.run_archive()['archived']);self.assertFalse(self.work.exists());self.assertTrue((self.root/a.ARCHIVE/'artifact.tar.gz').exists())
if __name__=='__main__':unittest.main()
