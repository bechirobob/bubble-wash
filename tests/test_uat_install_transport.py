import importlib.util
import hashlib
import io
import types
import json
import os
from pathlib import Path
import subprocess
import stat
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
pack=load('pack','ops/uat/package-release.py')
transport=load('transport','ops/uat/transport-install.py')
receiver=load('receiver','ops/uat/receive-install.py')


class TransportTests(unittest.TestCase):
    def test_context_exact_source_first_attempt(self):
        with tempfile.TemporaryDirectory() as folder:
            artifact=Path(folder)/'archive';artifact.write_bytes(b'synthetic')
            env={'GITHUB_REPOSITORY':'bechirobob/bubble-wash','GITHUB_REF':'refs/heads/main','GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_RUN_ATTEMPT':'1','SOURCE_SHA':'a'*40,'GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'123'}
            self.assertEqual(transport.context(env,artifact)['attempt'],'1')
            for key,value in [('GITHUB_RUN_ATTEMPT','2'),('GITHUB_REF','refs/heads/other'),('GITHUB_SHA','b'*40),('GITHUB_EVENT_NAME','push'),('GITHUB_RUN_ID','1; touch /tmp/evil')]:
                with self.subTest(key=key),self.assertRaises(ValueError):transport.context({**env,key:value},artifact)
            link=Path(folder)/'link';link.symlink_to(artifact)
            with self.assertRaises(ValueError):transport.context(env,link)

    def test_pack_materializes_internal_package_links_and_excludes_bins(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'root';root.mkdir();out=Path(folder)/'release.tar.gz'
            for name in ['.next','node_modules','public','src','scripts']:(root/name).mkdir()
            for name in ['package.json','next.config.mjs','tsconfig.json']:(root/name).write_text('{}')
            (root/'node_modules/pkg').mkdir();(root/'node_modules/pkg/index.js').write_text('test')
            (root/'node_modules/alias').symlink_to('pkg',target_is_directory=True)
            (root/'node_modules/.bin').mkdir();(root/'node_modules/.bin/external').symlink_to('/etc/passwd')
            receipt=pack.package(root,out,'a'*40)
            self.assertEqual(receipt['revision'],'a'*40)
            with tarfile.open(out) as archive:
                members=archive.getmembers();self.assertFalse(any(m.issym() or m.islnk() for m in members))
                self.assertEqual(archive.extractfile('node_modules/alias/index.js').read(),b'test')
                self.assertEqual(archive.extractfile('SOURCE_REVISION').read(),b'a'*40+b'\n')
                self.assertFalse(any('.bin' in m.name for m in members))
            (root/'node_modules/outside').symlink_to('/etc/passwd')
            with self.assertRaises(ValueError):pack.package(root,Path(folder)/'bad.tar.gz','a'*40)
            self.assertFalse((Path(folder)/'bad.tar.gz').exists())

    def test_transport_capture_bounded_and_errors_not_forwarded(self):
        with open(os.devnull,'rb') as stream:
            self.assertEqual(transport.bounded([sys.executable,'-c','print("safe")'],stream),b'safe\n')
        with open(os.devnull,'rb') as stream,self.assertRaises(ValueError):
            transport.bounded([sys.executable,'-c','print("x"*17000)'],stream)
        with open(os.devnull,'rb') as stream,self.assertRaises(ValueError):
            transport.bounded([sys.executable,'-c','raise SystemExit(2)'],stream)

    def test_receiver_refuses_before_staging_on_invalid_context(self):
        import io
        with patch.object(receiver.os,'geteuid',return_value=0),patch.object(receiver.tempfile,'mkdtemp',side_effect=AssertionError('unexpected write')):
            with self.assertRaises(ValueError):receiver.receive({}, {}, io.BytesIO(b''))
            context={'revision':'a'*40,'digest':'b'*64,'runId':'1','attempt':'2','size':1,'expanded':1}
            with self.assertRaises(ValueError):receiver.receive(context,{n:'' for n in receiver.FILES},io.BytesIO(b'x'))

    def test_receiver_exact_framing_install_only_receipt_and_retained_failure(self):
        payload=b'synthetic-release-bytes'
        context={'revision':'a'*40,'digest':hashlib.sha256(payload).hexdigest(),'runId':'123','attempt':'1','size':len(payload),'expanded':100}
        receipt={'ok':True,'action':'installed-not-started','port':3108,'revision':'a'*40,'accountsIssued':False,'productionChanged':False,'routingChanged':False}
        sources={
            'ops/inspect-uat-capacity.py':"def inspect(): return {}\n",
            'ops/uat/prepare-host.py':"def admit(facts,size): pass\ndef trusted_parents(): pass\ndef new_file(path,value,mode):\n import os\n fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,mode)\n with os.fdopen(fd,'w') as stream: stream.write(value)\n",
            'ops/uat/bubblewash-uat.service':'synthetic-unit-only',
        }
        for data,success in [(payload,True),(payload[:-1],False),(payload+b'x',False),(b'x'*len(payload),False)]:
            with self.subTest(success=success,data=data),tempfile.TemporaryDirectory() as folder:
                stage=Path(folder)/'stage';stage.mkdir()
                original_umask=os.umask(0o077)
                original_lstat=Path.lstat
                try:
                    with patch.object(receiver.os,'geteuid',return_value=0),patch.object(receiver.tempfile,'mkdtemp',return_value=str(stage)),patch.object(Path,'lstat',autospec=True,side_effect=lambda p: types.SimpleNamespace(st_mode=stat.S_IFDIR|0o755,st_uid=0) if str(p)=='/var/lib' else original_lstat(p)),patch.object(receiver.subprocess,'run',return_value=types.SimpleNamespace(returncode=0,stdout=json.dumps(receipt).encode(),stderr=b'')) as invoke:
                        if success:
                            self.assertEqual(receiver.receive(context,sources,io.BytesIO(data)),receipt)
                            command=invoke.call_args.args[0]
                            self.assertIn('--apply',command);self.assertIn('--isolation-approved',command)
                            self.assertEqual((stage/'release.tar.gz').read_bytes(),payload)
                            self.assertEqual((stage/'release.tar.gz').stat().st_mode&0o777,0o600)
                        else:
                            with self.assertRaises(ValueError):receiver.receive(context,sources,io.BytesIO(data))
                            invoke.assert_not_called()
                            self.assertTrue((stage/'release.tar.gz').exists(),'failed staging retained for inspection')
                finally:os.umask(original_umask)

    def test_workflow_fixed_target_offhost_build_and_no_activation(self):
        workflow=(ROOT/'.github/workflows/uat-install.yml').read_text()
        for item in ['environment: backup-storage','GITHUB_RUN_ATTEMPT','npm ci','node-version: 22','NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED: \'false\'','NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED: \'false\'','ops/uat/transport-install.py']:
            self.assertIn(item,workflow)
        self.assertNotIn('systemctl start',workflow)
        source=(ROOT/'ops/uat/transport-install.py').read_text()
        self.assertIn("'root@hermes'",source)
        self.assertNotIn('shell=True',source)
        self.assertIn("'git','show'",source)


if __name__=='__main__':unittest.main()
