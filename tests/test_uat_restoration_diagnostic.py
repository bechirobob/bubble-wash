"""Synthetic-only failure diagnostics: no host, network or credential access."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
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


if __name__=='__main__':unittest.main()
