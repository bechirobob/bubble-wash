"""Synthetic-only failure diagnostics: no host, network or credential access."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import types
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('diagnostic_transport',ROOT/'ops/uat/restoration-transport.py')
t=importlib.util.module_from_spec(spec);spec.loader.exec_module(t)
OP='6cd01672-7084-4e80-9dbb-2172dc78707b'
CANARY='PRIVATE-DIAGNOSTIC-CANARY'


class Diagnostic(unittest.TestCase):
    def setUp(self):
        self.bundle={name:(ROOT/name).read_text() for name in t.SOURCE_FILES}

    def failure(self):
        return {'ok':False,'readOnly':True,'automaticRetry':False,
            'state':'inspection-failed','failureStage':'host-inspection','failureSites':[]}

    def env(self,mode='inspect'):
        return {'UAT_RESTORE_MODE':mode,'UAT_OPERATION_ID':OP,'GITHUB_REPOSITORY':'bechirobob/bubble-wash',
            'GITHUB_REF':'refs/heads/main','GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_RUN_ATTEMPT':'1',
            'SOURCE_SHA':'a'*40,'GITHUB_SHA':'a'*40,'ADMIN_ROUTE_APPROVED':'true'}

    def child(self):
        # Same module names and compile filenames as the reviewed bootstrap;
        # synthetic collector failure replaces all host reads and commands.
        return '''import json,sys,types,os
bundle=json.loads(sys.argv[1])
for name,path in [('uat_restore_transport','ops/uat/restoration-transport.py'),('uat_restore_preflight','ops/uat/restoration-preflight.py'),('uat_restore_collector','ops/uat/restoration-collector.py'),('uat_restore_receiver','ops/uat/restoration-receiver.py')]:
 module=types.ModuleType(name);module.__file__='/reviewed/'+path;sys.modules[name]=module
 exec(compile(bundle[path],path,'exec'),module.__dict__)
os.geteuid=lambda:0
p=sys.modules['uat_restore_preflight'];c=sys.modules['uat_restore_collector'];r=sys.modules['uat_restore_receiver']
def fail(*args,**kwargs):return p.parse_environment(b'PRIVATE-DIAGNOSTIC-CANARY')
c.collect=fail
r.main(bundle)
'''

    def test_nonzero_receiver_diagnostic_survives_bounded_transport(self):
        command=[sys.executable,'-c',self.child(),json.dumps(self.bundle)]
        request=json.dumps({'mode':'inspect','operationId':OP}).encode()
        child=subprocess.run(command,input=request,capture_output=True)
        self.assertEqual(child.returncode,1)
        self.assertEqual(child.stderr,b'')
        self.assertNotIn(CANARY.encode(),child.stdout)
        raw=t.exchange(command,request,inspection_bundle=self.bundle)
        result=t.validate_receipt(raw,'inspect',inspection_bundle=self.bundle)
        self.assertFalse(result['ok']);self.assertTrue(result['failureSites'])
        self.assertEqual(result['failureStage'],'host-inspection')
        self.assertTrue(any(x.startswith('F1-L') for x in result['failureSites']))
        self.assertTrue(all(x.startswith(('F1-L','F3-L')) for x in result['failureSites']))

    def test_restore_receiver_failure_remains_generic_and_nonzero(self):
        request={'mode':'restore','operationId':OP,'accounts':[]}
        child=subprocess.run([sys.executable,'-c',self.child(),json.dumps(self.bundle)],
            input=json.dumps(request).encode(),capture_output=True)
        self.assertEqual(child.returncode,1)
        self.assertEqual(json.loads(child.stdout),{'ok':False,'automaticRetry':False,'state':'uncertain-stop'})
        self.assertNotIn(CANARY.encode(),child.stdout+child.stderr)

    def test_noninspect_and_malformed_remote_failures_are_not_accepted(self):
        for mode in ('restore','receipt'):
            with self.assertRaises(ValueError):
                t.validate_receipt(json.dumps(self.failure()).encode(),mode,inspection_bundle=self.bundle)
        invalid=[dict(self.failure(),password=CANARY),dict(self.failure(),failureSites=[CANARY]),
            dict(self.failure(),failureSites=['F1-L999999']),dict(self.failure(),failureSites=[True]),
            dict(self.failure(),failureSites=['F1-L1']*9),dict(self.failure(),readOnly=False),
            dict(self.failure(),failureStage='transport')]
        for result in invalid:
            with self.subTest(result=result),self.assertRaises(ValueError):
                t.validate_receipt(json.dumps(result).encode(),'inspect',inspection_bundle=self.bundle)
        command=[sys.executable,'-c','import sys;print(sys.argv[1]);sys.exit(1)',CANARY]
        with self.assertRaises(ValueError):t.exchange(command,b'',inspection_bundle=self.bundle)
        command=[sys.executable,'-c','import sys;print(sys.argv[1]);sys.exit(1)',json.dumps(self.failure())]
        with self.assertRaises(ValueError):t.exchange(command,b'')

    def test_local_failures_report_fixed_stage_without_private_details(self):
        with mock.patch.object(t,'source_bundle',side_effect=ValueError(CANARY)),mock.patch.object(t,'exchange') as remote:
            result=t.perform(ROOT,self.env())
        self.assertEqual(result['failureStage'],'source-verification');remote.assert_not_called()
        with mock.patch.object(t,'source_bundle',return_value=self.bundle),mock.patch.object(t,'exchange',side_effect=ValueError(CANARY)):
            result=t.perform(ROOT,self.env())
        self.assertEqual(result['failureStage'],'transport');self.assertNotIn(CANARY,json.dumps(result))
        with mock.patch.object(t,'source_bundle',return_value=self.bundle),mock.patch.object(t,'exchange',return_value=CANARY.encode()):
            result=t.perform(ROOT,self.env())
        self.assertEqual(result['failureStage'],'receipt-validation');self.assertNotIn(CANARY,json.dumps(result))

    def test_authorization_failure_never_reaches_diagnostic_transport(self):
        for key,value in [('ADMIN_ROUTE_APPROVED','false'),('GITHUB_RUN_ATTEMPT','2'),('RUNNER_DEBUG','1'),
                          ('BUBBLEWASH_UAT_RESTORE_ONCE',CANARY)]:
            env=self.env();env[key]=value
            with mock.patch.object(t,'exchange') as remote,self.assertRaises(ValueError):t.perform(ROOT,env)
            remote.assert_not_called()

    def test_workflow_diagnostic_stays_failed_without_second_generic_receipt(self):
        source=(ROOT/'.github/workflows/uat-restore-original.yml').read_text()
        step=source.split('      - name: Read-only operation without credential secret\n',1)[1].split('      - name:',1)[0]
        code=step.split("          python3 -I -B - <<'PY'\n",1)[1].split('          PY',1)[0]
        code='\n'.join(line[10:] for line in code.splitlines())
        module=types.SimpleNamespace(perform=lambda root,env:self.failure())
        loader=types.SimpleNamespace(exec_module=lambda module:None)
        fake=types.SimpleNamespace(loader=loader)
        output=io.StringIO()
        with mock.patch('importlib.util.spec_from_file_location',return_value=fake),mock.patch('importlib.util.module_from_spec',return_value=module),contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as error:exec(code,{})
        self.assertEqual(error.exception.code,1)
        self.assertEqual(json.loads(output.getvalue()),self.failure())

    def test_transport_categories_use_only_fixed_labels(self):
        cases=[('startup-missing',['/nonexistent-uat-diagnostic-helper'],{},b''),
            ('exit-no-receipt',[sys.executable,'-c','import sys;sys.stderr.write(sys.argv[1]);sys.exit(7)',CANARY],{},b''),
            ('exit-invalid-receipt',[sys.executable,'-c','import sys;print(sys.argv[1]);sys.exit(7)',CANARY],{},b''),
            ('exit-signal',[sys.executable,'-c','import os,signal;os.kill(os.getpid(),signal.SIGTERM)'],{},b''),
            ('timeout',[sys.executable,'-c','import time;time.sleep(5)'],{'timeout':.1},b''),
            ('output-limit',[sys.executable,'-c','import sys;sys.stderr.write(sys.argv[1]*1000)',CANARY],{'limit':100},b'')]
        for category,command,kwargs,payload in cases:
            with self.subTest(category=category):
                with self.assertRaises(t.TransportFailure) as captured:
                    t.exchange(command,payload,inspection_bundle=self.bundle,**kwargs)
                result=t.inspection_failure(captured.exception,self.bundle,'transport')
                self.assertEqual(result['failureStage'],'transport-'+category)
                self.assertNotIn(CANARY,json.dumps(result))
                self.assertNotIn(CANARY,str(captured.exception))
                t.validate_inspection_failure(result,self.bundle)
                with self.assertRaises(ValueError):t.validate_inspection_failure(result,self.bundle,host_only=True)

    def test_early_child_exit_drains_output_and_classifies_exit(self):
        command=[sys.executable,'-c','import os,sys;os.close(0);sys.stderr.write(sys.argv[1]);sys.exit(9)',CANARY]
        with self.assertRaises(t.TransportFailure) as captured:
            t.exchange(command,b'x'*16384,inspection_bundle=self.bundle)
        self.assertEqual(captured.exception.category,'exit-no-receipt')

    def test_tailscale_config_is_private_temporary_and_never_inherited(self):
        command=['/usr/local/bin/tailscale','ssh','root@hermes','synthetic-command']
        with mock.patch.dict(os.environ,{'HOME':CANARY,'XDG_CONFIG_HOME':CANARY,
             'SSH_AUTH_SOCK':CANARY,'BUBBLEWASH_UAT_RESTORE_ONCE':CANARY}):
            with t.child_environment(command) as env:
                self.assertEqual(set(env),{'PATH','LC_ALL','XDG_CONFIG_HOME'})
                self.assertEqual(env['PATH'],'/usr/sbin:/usr/bin:/sbin:/bin')
                path=Path(env['XDG_CONFIG_HOME'])
                self.assertTrue(path.is_absolute() and path.is_dir())
                self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o700)
                (path/'tailscale').mkdir();(path/'tailscale/ssh_known_hosts').write_text('synthetic-public-key')
            self.assertFalse(path.exists())
            with t.child_environment(['/usr/bin/node']) as env:
                self.assertEqual(env,{'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'})

    def test_config_cleanup_and_sanitized_startup_errors(self):
        command=['/usr/local/bin/tailscale','ssh','root@hermes','synthetic-command']
        for category,error in [('startup-denied',PermissionError(CANARY)),('startup-unavailable',OSError(CANARY))]:
            directories=[]
            def start(*args,**kwargs):
                directory=Path(kwargs['env']['XDG_CONFIG_HOME']);directories.append(directory)
                self.assertTrue(directory.is_dir())
                raise error
            with self.subTest(category=category),mock.patch.object(t.subprocess,'Popen',side_effect=start):
                with self.assertRaises(t.TransportFailure) as captured:t.exchange(command,b'')
            self.assertEqual(captured.exception.category,category)
            self.assertNotIn(CANARY,str(captured.exception))
            self.assertTrue(directories and all(not d.exists() for d in directories))

    def test_termination_failure_still_closes_every_pipe(self):
        child=mock.Mock();child.poll.return_value=None
        child.wait.side_effect=subprocess.TimeoutExpired(CANARY,2)
        child.kill.side_effect=OSError(CANARY)
        selector=mock.Mock();selector.get_map.return_value={}
        selector.close.side_effect=OSError(CANARY)
        with mock.patch.object(t.subprocess,'Popen',return_value=child),mock.patch.object(t.selectors,'DefaultSelector',return_value=selector),mock.patch.object(t.os,'set_blocking'):
            with self.assertRaises(t.TransportFailure) as captured:t.exchange([sys.executable],b'synthetic-private-input')
        self.assertEqual(captured.exception.category,'cleanup')
        for stream in (child.stdin,child.stdout,child.stderr):stream.close.assert_called_once()
        self.assertNotIn(CANARY,str(captured.exception))

    def test_directory_removal_error_is_sanitized_cleanup_failure(self):
        directory=mock.MagicMock();directory.__enter__.return_value='/tmp/synthetic-config'
        directory.__exit__.side_effect=OSError(CANARY)
        with mock.patch.object(t.tempfile,'TemporaryDirectory',return_value=directory):
            with self.assertRaises(t.TransportFailure) as captured:
                with t.child_environment(['/usr/local/bin/tailscale','ssh','root@hermes']):pass
        self.assertEqual(captured.exception.category,'cleanup')
        self.assertNotIn(CANARY,str(captured.exception))


if __name__=='__main__':unittest.main()
