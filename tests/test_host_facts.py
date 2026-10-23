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
                    field={'uid':'ownerMatches','gid':'primaryGroupMatches','mode':'modePrivate','links':'singleLink','kind':'regularFile'}[attribute]
                    self.assertFalse(report['environmentChecks'][field])
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
            self.assertNotIn(private,json.dumps(t.public_summary(public)))
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
        self.assertNotIn('/home',json.dumps(t.public_summary(public)))
        self.assertNotIn('1001',json.dumps(public))

    def test_partial_environment_failure_preserves_observed_predicates(self):
        with patch.object(f,'metadata',side_effect=self.metadata), \
             patch.object(f,'ancestry',return_value=[{'kind':'directory','uid':0,'mode':0o755}]), \
             patch.object(f.Path,'resolve',lambda self,**kw:self), \
             patch.object(f.os,'listxattr',side_effect=PermissionError('/SECRET')), \
             patch.object(f,'trusted_executable',side_effect=ValueError()):
            report,flags=f.installer_metadata(1001,2002)
        self.assertTrue(report['environmentChecks']['ownerMatches'])
        self.assertIsNone(report['environmentChecks']['attributesAbsent'])
        self.assertFalse(report['environmentMetadataSafe'])
        self.assertIn('installer-env-metadata-unavailable',flags)
        self.assertNotIn('SECRET',json.dumps(report))

    def test_manager_parse_and_source_trust_failures_are_fixed_categories(self):
        self.commands=[];php=types.SimpleNamespace(collect=lambda:{})
        with patch.object(f.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=1001,pw_gid=2002)), \
             patch.object(f,'source',return_value={'trustedOwnership':False}), \
             patch.object(f,'metadata',side_effect=self.metadata), \
             patch.object(f,'installer_metadata',return_value=({},set())), \
             patch.object(f.os,'readlink',return_value='/PRIVATE'),patch.object(f.Path,'is_dir',return_value=False), \
             patch.object(f.os,'statvfs',side_effect=OSError()):
            _,public=f.collect(php,run=self.properties)
            self.assertTrue(all(x['stage']=='inspected' and x['unitSources']==['ownership-unsafe'] for x in public['diagnostics']['units']))
            with patch.object(f,'source',side_effect=PermissionError('/SECRET')):
                _,public=f.collect(php,run=self.properties)
                self.assertTrue(all(x['unitSources']==['read-or-validation-failed'] for x in public['diagnostics']['units']))
            _,public=f.collect(php,run=lambda args:'PRIVATE=SECRET')
            self.assertTrue(all(x['stage']=='properties-invalid' for x in public['diagnostics']['units']))
            self.assertNotIn('SECRET',json.dumps(public))
            full=self.properties([])
            for raw,issue,missing in ((full.replace('User=\n',''),'missing',['User']),
                                      (full+'\nUser=SECRET','duplicate',[]),
                                      (full+'\nPRIVATE=SECRET','unknown',[]),
                                      ('SECRET','malformed',[])):
                _,public=f.collect(php,run=lambda args:raw)
                for unit in public['diagnostics']['units']:
                    self.assertEqual(unit['propertyIssue'],issue)
                    self.assertEqual(unit['missingProperties'],missing)
                self.assertNotIn('SECRET',json.dumps(public))

    def test_unavailable_observations_cannot_claim_absence(self):
        php=types.SimpleNamespace(collect=lambda:{})
        with patch.object(f.pwd,'getpwnam',side_effect=KeyError()),patch.object(f,'metadata',side_effect=OSError()), \
             patch.object(f,'installer_metadata',return_value=({}, {'installer-env-metadata-unavailable'})), \
             patch.object(f.os,'statvfs',side_effect=OSError()):
            report,public=f.collect(php,run=lambda args: (_ for _ in ()).throw(RuntimeError('PRIVATE ERROR')))
        self.assertTrue({'manager-unavailable','php-incomplete','space-unavailable'}.issubset(public['flags']))
        self.assertNotIn('PRIVATE ERROR',json.dumps((report,public)))
        self.assertEqual([x['stage'] for x in public['diagnostics']['units']], ['command-failed','command-failed','account-unavailable'])


class DiagnosticPrivacy(unittest.TestCase):
    def report(self):
        return {'installerMetadata':{'environmentChecks':dict.fromkeys(f.ENV_CHECKS,True)},
                'units':[{'diagnosticStage':'inspected','sourceStages':['trusted'], 'properties':{'WorkingDirectory':'/private/application','EnvironmentFiles':'/private/env (ignore_errors=no)'}, 'runningExecutable':{'path':'/private/bin/node','sha256':'a'*64}} for _ in range(3)],
                'php':{'packages':{'inspected':True,'result':[{'name':'php8.3-fpm','version':'8.3.6-0ubuntu0.24.04.2'},
                           {'name':'php8.3-SECRET','version':'8.3.0'}]},
                       'services':{'inspected':True,'result':[{'name':'php8.3-fpm.service','active':True},{'name':'nginx.service','active':True}]},
                       'tcpListeners':{'inspected':True,'result':{'phpTcpListenerCount':19876,'phpNonLoopbackTcpListenerCount':1}},
                       'private':'/private/SECRET'}}

    def test_public_projection_excludes_paths_counts_unknown_packages_and_keys(self):
        report=self.report();report['private']='/home/SECRET';report['units'][0]['properties']={'Environment':'SECRET'}
        diag=f.safe_diagnostics(report);public=f.summary(diagnostics=diag)
        self.assertEqual(diag['php']['packages'],[{'name':'php8.3-fpm','version':'8.3.6-0ubuntu0.24.04.2'}])
        self.assertFalse(diag['php']['packagesComplete'])
        self.assertTrue(diag['php']['phpServiceActive']);self.assertTrue(diag['php']['phpNonLoopbackListenerPresent'])
        for private in ('SECRET','19876','Environment'):
            self.assertNotIn(private,json.dumps(t.public_summary(public)))
        self.assertEqual(set(diag['environment']),set(f.ENV_CHECKS))

    def test_unknown_observations_stay_null_and_package_count_is_bounded(self):
        report=self.report();report['installerMetadata']={};report['php']={}
        diag=f.safe_diagnostics(report)
        self.assertTrue(all(x is None for x in diag['environment'].values()))
        for key in ('phpServicePresent','phpServiceActive','webServicePresent','phpTcpListenerPresent','phpNonLoopbackListenerPresent'):
            self.assertIsNone(diag['php'][key])
        report=self.report();report['php']['packages']['result']=[{'name':'php8.3-fpm','version':'8.3.'+str(i)} for i in range(30)]
        diag=f.safe_diagnostics(report);self.assertEqual(len(diag['php']['packages']),24);self.assertFalse(diag['php']['packagesComplete'])

    def test_summary_rejects_injected_fields_values_and_shapes(self):
        good=f.safe_diagnostics(self.report())
        changes=[lambda x:x['environment'].update(path='/secret'),lambda x:x['environment'].update(ownerMatches=1001),
                 lambda x:x['units'][0].update(stage='/private/error'),lambda x:x['units'][0].update(unit='root'),
                 lambda x:x['units'][0].update(unitSources=['SECRET']),lambda x:x['php'].update(phpTcpListenerPresent=12),
                 lambda x:x['php']['packages'][0].update(name='php8.3-secret'),
                 lambda x:x['php']['packages'][0].update(version='8.3\nSECRET'),
                 lambda x:x['php']['packages'][0].update(version='8.3/'+('x'*20)),
                 lambda x:x['php'].update(packages=x['php']['packages']*25)]
        for change in changes:
            bad=copy.deepcopy(good);change(bad)
            with self.assertRaises((ValueError,TypeError)):f.summary(diagnostics=bad)

    def test_actual_main_stdout_never_emits_private_diagnostics(self):
        diag=f.safe_diagnostics(self.report());private=f.summary(diagnostics=diag)
        header={'schema':'bubblewash-host-facts/v1','context':CONTEXT,'summary':private}
        encoded=f.canonical(header);raw=t.MAGIC+len(encoded).to_bytes(4,'big')+encoded+b'x'*29
        with tempfile.TemporaryDirectory() as directory:
            for output,response in ((raw,header),(b'{}',f.summary(result='encryption-unavailable',diagnostics=diag))):
                stdout=io.StringIO()
                with patch.dict(os.environ,{**ENV,'RUNNER_TEMP':directory}),patch.object(sys,'argv',['transport','inspect']), \
                     patch.object(t,'storage_step',side_effect=lambda fn,*args:(None,None) if fn is t.store_api else {}), \
                     patch.object(t,'runner_transport',return_value=(output,response)), \
                     contextlib.redirect_stdout(stdout):
                    t.main()
                lines=stdout.getvalue().splitlines();public=json.loads(lines[0].removeprefix('HOST_FACTS_SUMMARY '))
                self.assertEqual(set(public),{'schema','result','flags'})
                for private_value in ('diagnostics','ownerMatches','php8.3','8.3.6','propertyIssue','/private','a'*64):
                    self.assertNotIn(private_value,stdout.getvalue())

    def test_private_binding_projection_is_bounded_and_not_listener_identity(self):
        item=self.report()['units'][0];binding=f.private_binding(item)
        self.assertEqual(binding['workingDirectory'],'/private/application')
        self.assertEqual(binding['environmentFiles'],[{'path':'/private/env','ignoreErrors':False}])
        self.assertEqual(binding['mainPidExecutable'],{'path':'/private/bin/node','sha256':'a'*64})
        self.assertEqual(binding['identityScope'],'main-pid-not-listener-identity')
        for path in ('relative','/a/../b','/a/./b','//a','/a//b','/a/','/a\n','/'+('x'*256)):
            self.assertFalse(f.safe_path(path))
            bad=copy.deepcopy(binding);bad['workingDirectory']=path
            with self.assertRaises(ValueError):f.validate_binding(bad)
        for raw in ('/private/env SECRET','/private/env (ignore_errors=maybe)',' '.join(['/private/env (ignore_errors=no)']*3)):
            self.assertIsNone(f.private_binding({'properties':{'EnvironmentFiles':raw}})['environmentFiles'])
        for digest in ('a'*63,'A'*64,'a'*64+'\n'):
            bad=copy.deepcopy(binding);bad['mainPidExecutable']['sha256']=digest
            with self.assertRaises(ValueError):f.validate_binding(bad)
        partial={'observedBindingProperties':{'EnvironmentFiles':'/private/env (ignore_errors=no)','WorkingDirectory':'/private/application'}}
        self.assertEqual(f.private_binding(partial)['environmentFiles'],binding['environmentFiles'])
        self.assertIsNone(f.private_binding({})['mainPidExecutable'])

    def test_diagnostics_are_in_authenticated_envelope(self):
        diag=f.safe_diagnostics(self.report())
        header={'schema':'bubblewash-host-facts/v1','context':CONTEXT,'summary':f.summary(diagnostics=diag)}
        encoded=f.canonical(header);raw=t.MAGIC+len(encoded).to_bytes(4,'big')+encoded+b'x'*29
        self.assertEqual(t.envelope(raw,CONTEXT)['summary']['diagnostics'],diag)

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
        self.assertEqual(run.call_args.kwargs['env'],t.runner_environment())
        self.assertEqual(raw,encrypted());self.assertEqual(header['context'],CONTEXT)

    def test_runner_environment_is_exact_allowlist(self):
        inherited = {'HOME': '/synthetic/runner', 'PATH': '/untrusted', 'LC_ALL': 'other',
                     'GH_TOKEN': 'SECRET', 'BACKUP_KEY': 'SECRET', 'TS_AUTHKEY': 'SECRET', 'SSH_AUTH_SOCK': '/private/agent',
                     'XDG_CONFIG_HOME': '/private/config', 'TS_DEBUG_SSH_EXEC': '1'}
        with patch.dict(os.environ, inherited, clear=True):
            env = t.runner_environment()
            self.assertEqual(env, {'PATH':'/usr/sbin:/usr/bin:/sbin:/bin',
                                   'LC_ALL':'C', 'HOME':'/synthetic/runner'})
            raw = f.bounded([sys.executable, '-c',
                'import os,json;print(json.dumps({k:os.environ.get(k) for k in '
                '["HOME","GH_TOKEN","SSH_AUTH_SOCK","XDG_CONFIG_HOME","TS_DEBUG_SSH_EXEC"]}))'], env=env)
            self.assertEqual(json.loads(raw), {'HOME':'/synthetic/runner', 'GH_TOKEN':None,
                'SSH_AUTH_SOCK':None, 'XDG_CONFIG_HOME':None, 'TS_DEBUG_SSH_EXEC':None})
            # The host/default subprocess environment remains unchanged and stripped.
            self.assertEqual(f.bounded([sys.executable,'-c',
                'import os;print("present" if os.getenv("HOME") else "absent")']), b'absent\n')

    def test_invalid_runner_home_fails_closed_without_subprocess(self):
        for home in ('', 'relative', '/invalid\0home', '/invalid\nhome', '/invalid\rhome', '/'+'x'*4096):
            with patch.object(t.os, 'environ', {'HOME':home}), \
                 patch.object(t.f,'bounded') as run, patch.object(t,'payload',return_value=b'synthetic'):
                with self.assertRaises(t.PhaseFailure) as caught:t.runner_transport(CONTEXT)
                self.assertEqual(str(caught.exception),'transport-failed')
                run.assert_not_called()

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
