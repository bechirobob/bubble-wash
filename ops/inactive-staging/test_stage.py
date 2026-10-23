import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
import stage_artifact as s

class StageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.base = self.root/'releases'; self.base.mkdir()
    def tearDown(self): self.tmp.cleanup()
    def fixture(self, names=None):
        names = names or [('src/file.txt',b'hello', 'file'),('node_modules/.bin/test','../pkg/bin.js','link'),('node_modules/pkg/bin.js',b'code','file')]
        archive=self.root/'input.tar'; files={}
        with tarfile.open(archive,'w',format=tarfile.USTAR_FORMAT) as tar:
            for name,data,kind in names:
                t=tarfile.TarInfo(name);t.mode=0o644
                if kind=='file':
                    t.size=len(data);tar.addfile(t,io.BytesIO(data));files[name]={'type':'file','size':len(data),'mode':0o644,'sha256':s.sha(data)}
                elif kind=='link':
                    t.type=tarfile.SYMTYPE;t.linkname=data;tar.addfile(t);files[name]={'type':'link','target':data}
                else:
                    t.type=kind;tar.addfile(t);files[name]={'type':'file','size':0,'mode':0o644,'sha256':s.sha(b'')}
        manifest={'schema':'bubblewash-inactive-artifact/v1','archiveSha256':s.sha(archive.read_bytes()),'files':files}
        raw=json.dumps(manifest).encode();return archive,raw
    def stage(self, a,raw,**kw):
        return s.stage(a,raw,s.sha(raw),self.base,'a'*40,uid=os.getuid(),check_parent=lambda p,u:None,**kw)
    def test_exact_and_repeat(self):
        a,m=self.fixture();r=self.stage(a,m);self.assertFalse(r['runtimeAccepted']);self.assertEqual((self.base/('a'*40)/'src/file.txt').read_bytes(),b'hello')
        self.assertRaises(ValueError,self.stage,a,m)
    def test_path_rejections(self):
        for path in ['../outside','/absolute','a/../b','./a','a//b','a\\b', '.']:
            with self.subTest(path=path):
                a,m=self.fixture([(path,b'x','file')]);self.assertRaises(ValueError,self.stage,a,m)
    def test_duplicate(self):
        a,m=self.fixture([('x',b'x','file'),('x',b'x','file')]);self.assertRaises(ValueError,self.stage,a,m)
    def test_unsafe_links_and_special(self):
        for kind,target in [('link','/etc/passwd'),('link','../../escape'),(tarfile.LNKTYPE,''),(tarfile.FIFOTYPE,''),(tarfile.DIRTYPE,'')]:
            a,m=self.fixture([('x',target,kind)]);self.assertRaises(ValueError,self.stage,a,m)
    def test_wrong_archive(self):
        a,m=self.fixture();a.write_bytes(a.read_bytes()+b'x');self.assertRaises(ValueError,self.stage,a,m)
    def test_wrong_file(self):
        a,m=self.fixture();j=json.loads(m);j['files']['src/file.txt']['sha256']='0'*64;m=json.dumps(j).encode();self.assertRaises(ValueError,self.stage,a,m)
    def test_partial_retained_and_no_retry(self):
        a,m=self.fixture()
        def fail(phase):
            if phase=='file':raise RuntimeError('fault')
        self.assertRaises(RuntimeError,self.stage,a,m,hook=fail)
        self.assertTrue((self.base/('a'*40)).exists());self.assertRaises(ValueError,self.stage,a,m)
    def test_archive_symlink(self):
        a,m=self.fixture();link=self.root/'alias';link.symlink_to(a);self.assertRaises(OSError,self.stage,link,m)
    def test_limits(self):
        a,m=self.fixture();old=s.MAX_EXPANDED;s.MAX_EXPANDED=1
        try:self.assertRaises(ValueError,self.stage,a,m)
        finally:s.MAX_EXPANDED=old
    def test_parent_guard(self):
        self.assertRaises(ValueError,s.protected_directory,self.base,0)
    def test_parent_file_collision(self):
        a,m=self.fixture([('a',b'x','file'),('a/b',b'y','file')]);self.assertRaises(ValueError,self.stage,a,m)
    def test_obvious_live_state_rejected(self):
        for name in ['data/db.sqlite', 'backups/archive', '.env', '.env.local', '.env.production', '.env.production.local']:
            a,m=self.fixture([(name,b'x','file')]);self.assertRaises(ValueError,self.stage,a,m)
    def test_restrictive_umask(self):
        a,m=self.fixture();old=os.umask(0o077)
        try:self.stage(a,m)
        finally:os.umask(old)
        self.assertEqual((self.base/('a'*40)/'node_modules/pkg').stat().st_mode & 0o777,0o755)
    def test_implicit_directory_limit(self):
        a,m=self.fixture([('a/b/c/d/file',b'x','file')]);old=s.MAX_FILES;s.MAX_FILES=3
        try:self.assertRaises(ValueError,self.stage,a,m)
        finally:s.MAX_FILES=old
        self.assertFalse((self.base/('a'*40)).exists())
    def test_float_mode_rejected(self):
        a,m=self.fixture();j=json.loads(m);j['files']['src/file.txt']['mode']=420.0;m=json.dumps(j).encode()
        self.assertRaises(ValueError,self.stage,a,m);self.assertFalse((self.base/('a'*40)).exists())
    def test_duplicate_manifest_key(self):
        raw=b'{"schema":1,"schema":2}';self.assertRaises(ValueError,s.parse_manifest,raw,s.sha(raw))

if __name__=='__main__':unittest.main()

class TransportTests(unittest.TestCase):
    setUp = StageTests.setUp
    tearDown = StageTests.tearDown
    fixture = StageTests.fixture
    stage = StageTests.stage
    def test_extension_rejected_before_parse(self):
        a,m=self.fixture();data=bytearray(a.read_bytes());data[156]=ord('x');a.write_bytes(data)
        j=json.loads(m);j['archiveSha256']=s.sha(data);m=json.dumps(j).encode()
        self.assertRaises(ValueError,self.stage,a,m)
    def test_transport_roundtrip_no_host(self):
        import subprocess,sys,shlex
        a,m=self.fixture();mp=self.root/'manifest.json';mp.write_bytes(m)
        script=Path(__file__).with_name('emit_command.py');source=script.with_name('stage_artifact.py')
        args=[sys.executable,str(script),'--source-sha256',s.sha(source.read_bytes()),'--manifest',str(mp),'--manifest-sha256',s.sha(m),'--kind','release','--name','b'*40]
        command=subprocess.check_output(args,text=True);tokens=shlex.split(command);self.assertEqual(tokens[:4],['python3','-I','-B','-c']);compile(tokens[4],'<transport>','exec')
        wire=subprocess.check_output(args+['--stream','--archive',str(a)])
        length=int.from_bytes(wire[:8],'big');self.assertEqual(wire[8:8+length],m);self.assertEqual(wire[8+length:],a.read_bytes())
        # Local non-root execution must refuse before any host write.
        result=subprocess.run([sys.executable,'-I','-B','-c',tokens[4]],input=wire,capture_output=True)
        self.assertEqual(result.returncode,1);self.assertIn(b'staging-refused-or-incomplete',result.stdout);self.assertEqual(result.stderr,b'')
