import hashlib,io,json,os,sqlite3,tarfile,tempfile,unittest
from pathlib import Path
from host_files import extract_candidate,exchange_apps,closed_snapshot,Refused,trusted_directory,database_fingerprints
class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='bw-host-files-',dir='/tmp');self.root=Path(self.tmp.name);self.fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
 def tearDown(self):os.close(self.fd);self.tmp.cleanup()
 def artifact(self,extra=None,large=None):
  content={'SOURCE_REVISION':b'a'*40+b'\n','uat-build.json':json.dumps(dict(schema='bubblewash-uat-build/v1',revision='a'*40,onlinePayments=False,automatedUpdates=False,providerCredentialsIncluded=False)).encode(),'src/example':b'reviewed'}
  for name in ('.next/BUILD_ID','node_modules/next/dist/bin/next','package.json','next.config.mjs','src/lib/uat-accounts.ts','scripts/uat-account.mjs'):content[name]=b'synthetic runtime fixture'
  if large is not None:content['public/random.bin']=large
  with tarfile.open(self.root/'release.tgz','w:gz') as t:
   for name,data in content.items():
    m=tarfile.TarInfo(name);m.size=len(data);t.addfile(m,io.BytesIO(data))
   if extra:t.addfile(extra,io.BytesIO(b'x'*extra.size))
  return hashlib.sha256((self.root/'release.tgz').read_bytes()).hexdigest(),{'src/example':hashlib.sha256(b'reviewed').hexdigest()}
 def test_extract_and_exchange(self):
  sha,pins=self.artifact();extract_candidate(self.fd,'release.tgz','candidate',sha,'a'*40,pins)
  self.assertEqual((self.root/'candidate').stat().st_mode&0o777,0o755);self.assertEqual((self.root/'candidate/src').stat().st_mode&0o777,0o755);self.assertEqual((self.root/'candidate/src/example').stat().st_mode&0o777,0o644)
  (self.root/'app').mkdir();(self.root/'app/old').write_text('old')
  exchange_apps(self.fd);self.assertEqual((self.root/'candidate/old').read_text(),'old');self.assertEqual((self.root/'app/src/example').read_bytes(),b'reviewed')
 def test_restrictive_umask_runtime_modes_and_cache(self):
  sha,pins=self.artifact();old=os.umask(0o077)
  try:extract_candidate(self.fd,'release.tgz','candidate',sha,'a'*40,pins)
  finally:os.umask(old)
  self.assertEqual((self.root/'candidate/src/example').stat().st_mode&0o777,0o644)
  self.assertEqual((self.root/'candidate/.next/cache').stat().st_mode&0o777,0o755)
  self.assertEqual(self.root.stat().st_mode&0o777,0o700)
 def test_large_incompressible_gzip_preserves_stream(self):
  payload=os.urandom(2*1024*1024+123)
  sha,pins=self.artifact(large=payload)
  self.assertGreater((self.root/'release.tgz').stat().st_size,1024*1024)
  extract_candidate(self.fd,'release.tgz','candidate',sha,'a'*40,pins)
  self.assertEqual((self.root/'candidate/public/random.bin').read_bytes(),payload)
 def test_cross_parent_exchange(self):
  (self.root/'update').mkdir();(self.root/'app').mkdir();(self.root/'update/candidate').mkdir();(self.root/'app/old').touch();(self.root/'update/candidate/new').touch()
  other=os.open(self.root/'update',os.O_RDONLY|os.O_DIRECTORY)
  try:exchange_apps(self.fd,candidate_parent=other)
  finally:os.close(other)
  self.assertTrue((self.root/'app/new').exists());self.assertTrue((self.root/'update/candidate/old').exists())
 def test_bad_members(self):
  for i,kind in enumerate(('traversal','symlink','hardlink','duplicate','special')):
   m=tarfile.TarInfo('../escape' if kind=='traversal' else 'src/example' if kind=='duplicate' else 'src/bad')
   if kind=='symlink':m.type=tarfile.SYMTYPE;m.linkname='/etc/passwd'
   if kind=='hardlink':m.type=tarfile.LNKTYPE;m.linkname='src/example'
   if kind=='special':m.type=tarfile.FIFOTYPE
   sha,pins=self.artifact(m)
   with self.subTest(kind=kind),self.assertRaises((Refused,OSError)):extract_candidate(self.fd,'release.tgz','candidate'+str(i),sha,'a'*40,pins)
 def test_pin_and_hash_refused(self):
  sha,pins=self.artifact()
  with self.assertRaises(Refused):extract_candidate(self.fd,'release.tgz','candidate','0'*64,'a'*40,pins)
  with self.assertRaises(Refused):extract_candidate(self.fd,'release.tgz','candidate',sha,'a'*40,{'src/example':'0'*64})
 def test_snapshot(self):
  with sqlite3.connect(self.root/'db') as d:
   d.execute('CREATE TABLE staff_uat_accounts(username TEXT, expires_at INTEGER)');d.execute("INSERT INTO staff_uat_accounts VALUES('synthetic',123)")
   fp=database_fingerprints(d);schema=fp['schema'];accounts=fp['accounts']
  before=(self.root/'db').read_bytes();closed_snapshot(self.fd,'db',self.fd,'snapshot',schema,accounts)
  self.assertEqual((self.root/'db').read_bytes(),before)
  with sqlite3.connect(self.root/'snapshot') as d:self.assertEqual(d.execute('PRAGMA integrity_check').fetchone(),('ok',))
  (self.root/'db-wal').write_bytes(b'active')
  with self.assertRaises(Refused):closed_snapshot(self.fd,'db',self.fd,'snapshot2',schema,accounts)
 def test_committed_wal_snapshot(self):
  import shutil
  writer=sqlite3.connect(self.root/'writer')
  try:
   writer.execute('PRAGMA journal_mode=WAL');writer.execute('PRAGMA wal_autocheckpoint=0')
   writer.execute('CREATE TABLE staff_uat_accounts(username TEXT, expires_at INTEGER)');writer.execute("INSERT INTO staff_uat_accounts VALUES('wal-only-row',123)");writer.commit()
   fp=database_fingerprints(writer)
   # Copy quiescent fixture to independent closed source. No connection remains
   # to this copy; original writer stays open only to retain original WAL files.
   for suffix in ('','-wal','-shm'):shutil.copyfile(self.root/('writer'+suffix),self.root/('closed'+suffix))
   before={suffix:(self.root/('closed'+suffix)).read_bytes() for suffix in ('','-wal')}
   closed_snapshot(self.fd,'closed',self.fd,'snapwal',fp['schema'],fp['accounts'])
   for suffix,raw in before.items():self.assertEqual((self.root/('closed'+suffix)).read_bytes(),raw)
   with sqlite3.connect(self.root/'snapwal') as d:self.assertEqual(d.execute('SELECT username FROM staff_uat_accounts').fetchone(),('wal-only-row',))
  finally:writer.close()
 def test_symlink_ancestry_and_untrusted_tmp(self):
  (self.root/'link').symlink_to('/etc')
  with self.assertRaises((Refused,OSError)):trusted_directory(self.root/'link')
 def test_existing_candidate_not_overwritten(self):
  sha,pins=self.artifact();(self.root/'candidate').mkdir();(self.root/'candidate/keep').touch()
  with self.assertRaises(FileExistsError):extract_candidate(self.fd,'release.tgz','candidate',sha,'a'*40,pins)
  self.assertTrue((self.root/'candidate/keep').exists())
if __name__=='__main__':unittest.main()
