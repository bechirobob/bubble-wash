"""Synthetic-only tests: no Hermes access, provider calls or production files."""
import builtins
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

f = load('facts', ROOT/'ops/host-facts/facts.py')
t = load('transport', ROOT/'ops/host-facts/transport.py')
CONTEXT = {'sourceSha': 'a'*40, 'runId': '123', 'runAttempt': '1'}
ENV = {'GITHUB_REPOSITORY': 'bechirobob/bubble-wash', 'GITHUB_REF': 'refs/heads/main',
       'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_SHA': 'a'*40, 'GITHUB_RUN_ID': '123',
       'GITHUB_RUN_ATTEMPT': '1', 'BACKUP_STORE_SHA': 'b'*40, 'BACKUP_STORE_ID': '42'}

def encrypted(context=CONTEXT):
    header = f.canonical({'schema':'bubblewash-host-facts/v1','context':context,'summary':f.summary()})
    return t.MAGIC + len(header).to_bytes(4,'big') + header + b'x'*29


class SummariesAndBounds(unittest.TestCase):
    def test_public_schema_is_exact_allowlist(self):
        good = f.summary(['space-unavailable', 'space-unavailable'])
        self.assertEqual(good['flags'], ['space-unavailable'])
        for bad in ({**good,'private':'secret'}, {**good,'flags':['/home/SECRET']},
                    {**good,'result':'arbitrary'}, {**good,'flags':['space-unavailable']*2}):
            with self.assertRaises(ValueError): f.validate_summary(bad)
        for raw in ('{"a":1,"a":2}', '{"a":NaN}'):
            with self.assertRaises(ValueError): f.strict_json(raw)

    def test_bounded_stdin_stdout_and_stderr(self):
        self.assertEqual(f.bounded([sys.executable,'-c','import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())'], b'synthetic'),b'synthetic')
        for destination in ('1','2'):
            with self.assertRaises(ValueError):
                f.bounded([sys.executable,'-c',f'import os;os.write({destination},b"x"*65536)'],limit=128)
        with self.assertRaises(ValueError): f.bounded([sys.executable,'-c','raise SystemExit(2)'])

    def test_limit_is_checked_before_accumulation(self):
        class Guarded(bytearray):
            def extend(self, block):
                if len(self)+len(block)>128: raise AssertionError('over-limit accumulation')
                return super().extend(block)
        with patch.dict(f.bounded.__globals__, {'bytearray':Guarded}):
            with self.assertRaises(ValueError):
                f.bounded([sys.executable,'-c','import os;os.write(1,b"x"*65536)'],limit=128)

    def test_timeout_kills_process_group_without_output(self):
        started=time.monotonic()
        with patch.object(f.os,'killpg',wraps=os.killpg) as kill:
            with self.assertRaises(ValueError):
                f.bounded([sys.executable,'-c','import time;time.sleep(20)'],timeout=.15)
            self.assertTrue(kill.called)
            self.assertEqual(kill.call_args.args[1], signal.SIGKILL)
        self.assertLess(time.monotonic()-started,3)

    def test_metadata_default_never_reads_contents(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'env';path.write_text('SECRET=do-not-read')
            with patch.object(f.os,'open',side_effect=AssertionError('must not open')):
                result=f.metadata(path)
            self.assertEqual(result['kind'],'file');self.assertNotIn('SECRET',str(result))
            hashed=f.metadata(path,content=True)
            self.assertEqual(hashed['sha256'],hashlib.sha256(path.read_bytes()).hexdigest())
            link=Path(d)/'link';link.symlink_to(path)
            with self.assertRaises(ValueError):f.metadata(link,content=True)
            with self.assertRaises(ValueError):f.metadata(path,content=True,max_bytes=1)


class SyntheticHost(unittest.TestCase):
    def metadata(self,path,content=False,**kwargs):
        path=str(path)
        self.seen.append((path,content))
        if path == '/home/ubuntu/.config/bubblewash/env':
            self.assertFalse(content)
            return {'path':path,'kind':'file','uid':1001,'gid':2002,'mode':0o600,'links':1}
        return {'path':path,'kind':'file','uid':0,'gid':0,'mode':0o644,'links':1}

    def setUp(self):self.seen=[]

    def test_installer_primary_group_not_uid_and_never_env_reads(self):
        parents=[{'kind':'directory','uid':0,'mode':0o755}]
        with patch.object(f,'metadata',side_effect=self.metadata),patch.object(f,'ancestry',return_value=parents), \
             patch.object(f.os,'listxattr',return_value=[]),patch.object(f.Path,'resolve',lambda self,**kw:self), \
             patch.object(f.os,'access',return_value=True):
            report,flags=f.installer_metadata(1001,2002)
            self.assertNotIn('installer-env-owner-mode-unsafe',flags)
            self.assertFalse(report['environmentValuesRead']);self.assertFalse(report['lockAcquired'])
            _,bad=f.installer_metadata(1001,1001)
            self.assertIn('installer-env-owner-mode-unsafe',bad)
        self.assertTrue(all(not read for path,read in self.seen if path.endswith('/env')))

    def test_acl_and_unsafe_lock_are_flags_not_success(self):
        with patch.object(f,'metadata',side_effect=self.metadata),patch.object(f,'ancestry',return_value=[{'kind':'link'}]), \
             patch.object(f.os,'listxattr',return_value=['system.posix_acl_access']), \
             patch.object(f.Path,'resolve',lambda self,**kw:self),patch.object(f.os,'access',return_value=False):
            _,flags=f.installer_metadata(1001,2002)
        self.assertIn('installer-env-attributes-present',flags)
        self.assertIn('deployment-lock-unverified',flags)
        self.assertIn('tool-unavailable',flags)

    def test_installer_positive_requires_each_metadata_guard(self):
        parents=[{'kind':'directory','uid':0,'mode':0o755}]
        with patch.object(f,'metadata',side_effect=self.metadata),patch.object(f,'ancestry',return_value=parents), \
             patch.object(f.os,'listxattr',return_value=[]),patch.object(f.Path,'resolve',lambda self,**kw:self), \
             patch.object(f,'trusted_executable',side_effect=lambda name:name):
            report,_=f.installer_metadata(1001,2002)
            for field in ('environmentMetadataSafe','deploymentLockMetadataSafe','toolsMetadataSafe'):
                self.assertTrue(report[field])
            for attribute,value in [('uid',9999),('gid',9999),('mode',0o644),('links',2),('kind','link')]:
                def changed(path,**kw):
                    item=self.metadata(path,**kw)
                    if str(path).endswith('/env'):item[attribute]=value
                    return item
                with patch.object(f,'metadata',side_effect=changed):
                    report,_=f.installer_metadata(1001,2002)
                    self.assertFalse(report['environmentMetadataSafe'])
            with patch.object(f,'ancestry',return_value=[{'kind':'directory','uid':0,'mode':0o777}]):
                report,_=f.installer_metadata(1001,2002)
                self.assertFalse(report['environmentMetadataSafe']);self.assertFalse(report['deploymentLockMetadataSafe'])
            with patch.object(f.os,'listxattr',return_value=['user.synthetic']):
                self.assertFalse(f.installer_metadata(1001,2002)[0]['environmentMetadataSafe'])
            with patch.object(f,'trusted_executable',side_effect=ValueError()):
                self.assertFalse(f.installer_metadata(1001,2002)[0]['toolsMetadataSafe'])
            with patch.object(f.Path,'resolve',return_value=Path('/different')):
                report,_=f.installer_metadata(1001,2002)
                self.assertFalse(report['environmentMetadataSafe']);self.assertFalse(report['deploymentLockMetadataSafe'])

    def test_public_outcomes_are_fixed_and_positive_requires_all_guards(self):
        self.commands=[]
        secret='SYNTHETIC_PRIVATE_SENTINEL'
        php=types.SimpleNamespace(collect=lambda:{'packages':{'inspected':True,'result':[{'name':'php8.3-private','version':'8.3.123'}]},
             'services':{'inspected':True,'result':[]},'processes':{'inspected':True,'phpNamedCount':98765},'tcpListeners':{'inspected':True,'result':{}}})
        safe={key:True for key in ('environmentMetadataSafe','deploymentLockMetadataSafe','toolsMetadataSafe')}
        def get(properties, metadata):
            with patch.object(f.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=1001,pw_gid=2002)), \
                 patch.object(f,'source',return_value={'trustedOwnership':True,'private':secret}), \
                 patch.object(f,'metadata',side_effect=self.metadata),patch.object(f,'ancestry',return_value=[]), \
                 patch.object(f,'installer_metadata',return_value=(metadata,set())), \
                 patch.object(f.os,'readlink',return_value='/private/'+secret),patch.object(f.Path,'is_dir',return_value=False), \
                 patch.object(f.os,'statvfs',return_value=types.SimpleNamespace(f_bavail=12345,f_frsize=4096,f_favail=8)):
                return f.collect(php,run=properties)
        report,public=get(self.properties,safe)
        self.assertIn(secret,json.dumps(report))
        self.assertIn('php-indicators-observed',public['flags'])
        self.assertIn('installer-metadata-preconditions-observed',public['flags'])
        for private in (secret,'/private','/home','1001','2002','php8.3','8.3.123','98765','12345'):
            self.assertNotIn(private,json.dumps(public))
        for key in safe:
            _,public=get(self.properties,{**safe,key:False})
            self.assertIn('installer-metadata-preconditions-unverified',public['flags'])
            self.assertNotIn('installer-metadata-preconditions-observed',public['flags'])
        def wrong_binding(args):return self.properties(args).replace('/home/ubuntu/.config/bubblewash/env','/different/env')
        _,public=get(wrong_binding,safe)
        self.assertIn('installer-metadata-preconditions-unverified',public['flags'])
        php.collect=lambda:{'packages':{'inspected':True,'result':[]},'services':{'inspected':True,'result':[]},'processes':{'inspected':True,'phpNamedCount':0},'tcpListeners':{'inspected':True,'result':{}}}
        _,public=get(self.properties,safe)
        self.assertIn('php-no-indicators-observed-incomplete',public['flags'])
        self.assertNotIn('php-indicators-observed',public['flags'])

    def test_fixed_node_symlink_requires_root_protected_link_and_target(self):
        original={'path':'/usr/bin/node','kind':'link','uid':0,'gid':0,'mode':0o777,'links':1,'target':'node-real'}
        with patch.object(f,'metadata',return_value=original), \
             patch.object(f,'ancestry',return_value=[{'kind':'directory','uid':0,'mode':0o755}]), \
             patch.object(f.Path,'resolve',return_value=Path('/usr/bin/node-real')), \
             patch.object(f,'source',return_value={'trustedOwnership':True}),patch.object(f.os,'access',return_value=True):
            self.assertEqual(f.trusted_executable('/usr/bin/node'),'/usr/bin/node-real')
            with patch.object(f,'source',return_value={'trustedOwnership':False}):
                with self.assertRaises(ValueError):f.trusted_executable('/usr/bin/node')
            with patch.object(f,'metadata',return_value={**original,'uid':1001}):
                with self.assertRaises(ValueError):f.trusted_executable('/usr/bin/node')

    def properties(self,args):
        self.commands.append(args)
        props={name:'' for name in f.PROPERTIES}
        props.update(LoadState='loaded',ActiveState='active',SubState='running',NeedDaemonReload='no',MainPID='2',
                     FragmentPath='/etc/systemd/system/synthetic.service',EnvironmentFiles='/home/ubuntu/.config/bubblewash/env (ignore_errors=no)')
        return '\n'.join(key+'='+value for key,value in props.items())

    def test_collection_exact_read_only_commands_and_gaps(self):
        self.commands=[]
        php=types.SimpleNamespace(collect=lambda:{name:{'inspected':True} for name in ('packages','services','tcpListeners','processes')})
        with patch.object(f.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=1001,pw_gid=2002)), \
             patch.object(f,'source',return_value={'trustedOwnership':True}), \
             patch.object(f,'metadata',side_effect=self.metadata),patch.object(f,'ancestry',return_value=[]), \
             patch.object(f,'installer_metadata',return_value=({'environmentValuesRead':False},set())) as installer, \
             patch.object(f.os,'readlink',return_value='/usr/bin/node'),patch.object(f.Path,'is_dir',return_value=False), \
             patch.object(f.os,'statvfs',return_value=types.SimpleNamespace(f_bavail=5,f_frsize=4096,f_favail=8)):
            report,public=f.collect(php,run=self.properties)
        installer.assert_called_once_with(1001,2002)
        self.assertEqual(len(self.commands),3)
        for cmd in self.commands:
            self.assertIn('show',cmd)
            self.assertNotIn('Environment',','.join(f.PROPERTIES).split(','))
            self.assertFalse(any(word in cmd for word in ('start','stop','restart','daemon-reload','enable')))
        self.assertEqual(self.commands[2][0],'/usr/sbin/runuser')
        self.assertIn('/usr/bin/systemctl',self.commands[2])
        self.assertTrue(report['readOnly'])
        self.assertFalse(report['limitations']['databaseRead'])
        self.assertIn('operator-exclusion-unresolved',public['flags'])
        self.assertNotIn('/home',json.dumps(public))
        self.assertNotIn('1001',json.dumps(public))

    def test_unavailable_observations_cannot_claim_absence(self):
        php=types.SimpleNamespace(collect=lambda:{})
        with patch.object(f.pwd,'getpwnam',side_effect=KeyError()),patch.object(f,'metadata',side_effect=OSError()), \
             patch.object(f,'installer_metadata',return_value=({}, {'installer-env-metadata-unavailable'})), \
             patch.object(f.os,'statvfs',side_effect=OSError()):
            report,public=f.collect(php,run=lambda args: (_ for _ in ()).throw(RuntimeError('PRIVATE ERROR')))
        self.assertTrue({'manager-unavailable','php-incomplete','space-unavailable'}.issubset(public['flags']))
        self.assertNotIn('PRIVATE ERROR',json.dumps((report,public)))


class Transport(unittest.TestCase):
    def test_context_rejects_other_repository_ref_event_and_ids(self):
        self.assertEqual(t.inputs(ENV),CONTEXT)
        for key,value in [('GITHUB_REPOSITORY','other/repo'),('GITHUB_REF','refs/heads/topic'),('GITHUB_EVENT_NAME','pull_request'),('GITHUB_SHA','main'),('GITHUB_RUN_ID','0')]:
            with self.assertRaises(ValueError):t.inputs({**ENV,key:value})

    def test_all_source_pins_match_and_payload_compiles(self):
        for path,digest in t.SOURCE_PINS.items():
            self.assertEqual(hashlib.sha256((ROOT/path).read_bytes()).hexdigest(),digest)
        program=t.payload(CONTEXT)
        compile(program,'generated-host-payload','exec')
        self.assertIn(b"trusted_executable('/usr/bin/node')",program)
        self.assertNotIn(b'--experimental-strip-types',program)

    def test_actual_generated_payload_encrypts_only_over_stdin(self):
        program=t.payload(CONTEXT)
        real_exec=builtins.exec
        raw_output=io.BytesIO()
        output=types.SimpleNamespace(buffer=raw_output,write=lambda text:raw_output.write(text.encode()))
        private_report={'private':'SYNTHETIC_PRIVATE_SENTINEL','largeInteger':18446744073709551000}
        def after_module(code, namespace, *args):
            real_exec(code,namespace,*args)
            if getattr(code,'co_filename','')=='reviewed-facts':
                namespace['collect']=lambda php:(private_report,f.summary())
                namespace['trusted_executable']=lambda path:'/usr/bin/trusted-node'
                namespace['pwd']=types.SimpleNamespace(getpwnam=lambda name:types.SimpleNamespace(pw_uid=1001))
                def encrypt(argv,data,**kw):
                    self.assertEqual(argv[0],'/usr/bin/trusted-node')
                    self.assertNotIn('SYNTHETIC_PRIVATE_SENTINEL',repr(argv))
                    self.assertIn(b'SYNTHETIC_PRIVATE_SENTINEL',data)
                    self.assertIn(b'18446744073709551000',data)
                    return encrypted()
                namespace['bounded']=encrypt
        with patch.object(builtins,'exec',side_effect=after_module),patch.object(sys,'stdout',output), \
             patch.object(os,'geteuid',return_value=0),patch.object(signal,'signal'),patch.object(signal,'alarm'):
            real_exec(compile(program,'actual-emitted-payload','exec'),{'__name__':'__main__'})
        self.assertEqual(raw_output.getvalue(),encrypted())
        self.assertNotIn(b'SYNTHETIC_PRIVATE_SENTINEL',raw_output.getvalue())

    def test_actual_generated_payload_failure_never_prints_private_error(self):
        program=t.payload(CONTEXT);real_exec=builtins.exec;raw_output=io.BytesIO()
        output=types.SimpleNamespace(buffer=raw_output,write=lambda text:raw_output.write(text.encode()))
        def after_module(code,namespace,*args):
            real_exec(code,namespace,*args)
            if getattr(code,'co_filename','')=='reviewed-facts':
                namespace['collect']=lambda php:(_ for _ in ()).throw(RuntimeError('/private/SECRET'))
        with patch.object(builtins,'exec',side_effect=after_module),patch.object(sys,'stdout',output), \
             patch.object(os,'geteuid',return_value=0),patch.object(signal,'signal'),patch.object(signal,'alarm'):
            real_exec(compile(program,'actual-emitted-payload','exec'),{'__name__':'__main__'})
        value=f.strict_json(raw_output.getvalue());f.validate_summary(value)
        self.assertEqual(value['result'],'inspection-failed')
        self.assertNotIn(b'SECRET',raw_output.getvalue());self.assertNotIn(b'/private',raw_output.getvalue())

    def test_envelope_rejects_unknown_context_and_noncanonical_header(self):
        self.assertEqual(t.envelope(encrypted(),CONTEXT)['context'],CONTEXT)
        for value in (b'bad',encrypted({**CONTEXT,'runId':'124'}),encrypted()[:-1]):
            with self.assertRaises(ValueError):t.envelope(value,CONTEXT)
        header=b'{"private":"SENTINEL"}'
        with self.assertRaises(ValueError):t.envelope(t.MAGIC+len(header).to_bytes(4,'big')+header+b'x'*29,CONTEXT)

    def test_private_output_exclusive_and_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'encrypted';t.write_private(path,encrypted())
            self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o600)
            with self.assertRaises(FileExistsError):t.write_private(path,b'replacement')
            link=Path(d)/'link';link.symlink_to(path)
            with self.assertRaises(FileExistsError):t.write_private(link,b'replacement')


class RunnerTransport(unittest.TestCase):
    def test_restrictive_path_reproduces_bare_binary_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            binary=Path(directory)/'synthetic-tailscale-path-test'
            binary.write_text('#!'+sys.executable+'\nprint("synthetic-ok")\n')
            binary.chmod(0o700)
            with patch.dict(os.environ, {'PATH':directory+os.pathsep+os.environ.get('PATH','')}):
                with self.assertRaises(FileNotFoundError):f.bounded([binary.name])
                self.assertEqual(f.bounded([str(binary)]),b'synthetic-ok\n')

    def test_runner_uses_pinned_action_absolute_binary_without_path_expansion(self):
        with patch.object(t.f,'bounded',return_value=encrypted()) as run,patch.object(t,'payload',return_value=b'synthetic-program'):
            raw,header=t.runner_transport(CONTEXT)
        self.assertEqual(run.call_args.args[0],['/usr/local/bin/tailscale','ssh','root@hermes','/usr/bin/python3 -I -B -'])
        self.assertNotIn('env',run.call_args.kwargs)
        self.assertEqual(raw,encrypted());self.assertEqual(header['context'],CONTEXT)

    def test_fixed_categories_distinguish_runner_host_and_storage(self):
        with patch.object(t.f,'bounded',side_effect=FileNotFoundError('/private/SECRET')),patch.object(t,'payload',return_value=b'synthetic'):
            with self.assertRaises(t.PhaseFailure) as caught:t.runner_transport(CONTEXT)
            self.assertEqual(caught.exception.result,'transport-failed')
            self.assertNotIn('SECRET',str(caught.exception))
        for result in ('inspection-failed','encryption-unavailable'):
            with patch.object(t.f,'bounded',return_value=f.canonical(f.summary(result=result))),patch.object(t,'payload',return_value=b'synthetic'):
                _,public=t.runner_transport(CONTEXT)
                self.assertEqual(public['result'],result)
        with self.assertRaises(t.PhaseFailure) as caught:
            t.storage_step(lambda:(_ for _ in ()).throw(RuntimeError('/private/SECRET')))
        self.assertEqual(caught.exception.result,'storage-failed');self.assertNotIn('SECRET',str(caught.exception))

    def test_raw_or_unexpected_host_output_is_never_forwarded(self):
        for output in (b'/private/SECRET',f.canonical(f.summary(result='storage-failed'))):
            with patch.object(t.f,'bounded',return_value=output),patch.object(t,'payload',return_value=b'synthetic'):
                with self.assertRaises(t.PhaseFailure) as caught:t.runner_transport(CONTEXT)
            self.assertEqual(str(caught.exception),'transport-failed')


class PrivateStorage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.backup=load('backup_primitives',ROOT/'.github/backup/backup_release.py')
        if hashlib.sha256((ROOT/'.github/backup/backup_release.py').read_bytes()).hexdigest()!=t.BACKUP_PIN:
            raise AssertionError('pinned backup primitive mismatch')

    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.work=Path(self.tmp.name)
        self.path=self.work/'bubblewash-host-facts-123-1.enc';t.write_private(self.path,encrypted())
        self.api=self.FakeAPI()

    def tearDown(self):self.tmp.cleanup()

    class FakeAPI:
        def __init__(self):self.calls=[];self.release=None;self.blobs={};self.private=True;self.corrupt=False;self.fail_upload=False
        def api(self,suffix='',method='GET',payload=None):
            self.calls.append((suffix,method))
            if suffix=='':return {'private':self.private,'visibility':'private' if self.private else 'public','full_name':'bechirobob/becore-backups','id':42}
            if suffix.startswith('git/commits/'):return {'sha':'b'*40}
            if suffix=='releases' and method=='POST':
                self.release={**payload,'id':10,'assets':[]};return copy.deepcopy(self.release)
            if method=='PATCH':self.release.update(payload,published_at='2026-10-23T00:00:00Z')
            return copy.deepcopy(self.release)
        def upload(self,identity,path):
            if self.fail_upload:raise RuntimeError('synthetic uncertain upload')
            raw=path.read_bytes();aid=100+len(self.blobs);self.blobs[aid]=raw
            self.release['assets'].append({'id':aid,'name':path.name,'size':len(raw),'digest':'sha256:'+hashlib.sha256(raw).hexdigest(),'state':'uploaded','content_type':'application/octet-stream'})
        def download(self,identity,path,size):t.write_private(path,b'bad' if self.corrupt else self.blobs[identity])

    def test_publish_verifies_roundtrip_and_private_retrieval(self):
        receipt=t.publish(self.backup,self.api,ENV,CONTEXT,self.path,self.work)
        self.assertFalse(self.api.release['draft'])
        self.assertEqual(len(receipt['assets']),2)
        self.assertGreaterEqual(sum(suffix=='' for suffix,_ in self.api.calls),3)
        target=self.work/'retrieved.enc';t.retrieve(self.backup,self.api,receipt,target)
        self.assertEqual(target.read_bytes(),self.path.read_bytes())
        self.assertEqual(stat.S_IMODE(target.stat().st_mode),0o600)
        with self.assertRaises(FileExistsError):t.retrieve(self.backup,self.api,receipt,target)

    def test_public_repository_refused_before_mutation(self):
        self.api.private=False
        with self.assertRaises(RuntimeError):t.publish(self.backup,self.api,ENV,CONTEXT,self.path,self.work)
        self.assertFalse(any(method!='GET' for _,method in self.api.calls))

    def test_download_mismatch_leaves_draft_without_retry_or_delete(self):
        self.api.corrupt=True
        with self.assertRaises(ValueError):t.publish(self.backup,self.api,ENV,CONTEXT,self.path,self.work)
        self.assertTrue(self.api.release['draft'])
        self.assertEqual(sum(method=='POST' for _,method in self.api.calls),1)
        self.assertFalse(any(method in ('DELETE','PATCH') for _,method in self.api.calls))

    def test_uncertain_upload_not_retried_or_deleted(self):
        self.api.fail_upload=True
        with self.assertRaises(RuntimeError):t.publish(self.backup,self.api,ENV,CONTEXT,self.path,self.work)
        self.assertTrue(self.api.release['draft'])
        self.assertEqual(sum(method=='POST' for _,method in self.api.calls),1)
        self.assertFalse(any(method=='DELETE' for _,method in self.api.calls))

    def test_receipt_asset_identity_tampering_refused(self):
        receipt=t.publish(self.backup,self.api,ENV,CONTEXT,self.path,self.work)
        receipt['assets'][0]['id']+=123
        with self.assertRaises(ValueError):t.retrieve(self.backup,self.api,receipt,self.work/'bad.enc')
        self.assertFalse((self.work/'bad.enc').exists())


if __name__=='__main__':unittest.main()
