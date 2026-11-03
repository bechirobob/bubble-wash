import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path);module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module);return module
p=load('uat_restore_preflight','ops/uat/restoration-preflight.py')
c=load('uat_restore_collector','ops/uat/restoration-collector.py')
t=load('uat_restore_transport','ops/uat/restoration-transport.py')
r=load('uat_restore_receiver','ops/uat/restoration-receiver.py')
OP='6cd01672-7084-4e80-9dbb-2172dc78707b'

def environment(mode='inspect'):
    return {'UAT_RESTORE_MODE':mode,'UAT_OPERATION_ID':OP,'GITHUB_REPOSITORY':'bechirobob/bubble-wash',
      'GITHUB_REF':'refs/heads/main','GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_RUN_ATTEMPT':'1',
      'SOURCE_SHA':'a'*40,'GITHUB_SHA':'a'*40,'ADMIN_ROUTE_APPROVED':'true'}
def accounts():return [{'role':role,'username':'synthetic-'+role,'password':'synthetic-only-test-password'} for role in ['admin','vendor','driver','support']]
def approved():
    env=environment('restore')
    env.update({k:'true' for k in ['RESTORATION_APPROVED','GITHUB_CREDENTIAL_STORAGE_APPROVED','SECRET_CLEANUP_APPROVED','PUBLIC_VERIFICATION_READY']})
    env['BUBBLEWASH_UAT_RESTORE_ONCE']=json.dumps({'operationId':OP,'accounts':accounts()})
    return env


class Context(unittest.TestCase):
    def test_readonly_never_consumes_credentials(self):
        self.assertEqual(t.private_input(environment()),{'mode':'inspect','operationId':OP})
        env=environment();env['BUBBLEWASH_UAT_RESTORE_ONCE']='synthetic'
        with self.assertRaises(ValueError):t.private_input(env)
    def test_separate_storage_and_access_approvals_mandatory(self):
        for key in ['ADMIN_ROUTE_APPROVED','RESTORATION_APPROVED','GITHUB_CREDENTIAL_STORAGE_APPROVED','SECRET_CLEANUP_APPROVED','PUBLIC_VERIFICATION_READY']:
            env=approved();env[key]='false'
            with self.subTest(key=key),self.assertRaises(ValueError):t.private_input(env)
    def test_first_attempt_exact_source_no_debug(self):
        for key,value in [('GITHUB_RUN_ATTEMPT','2'),('GITHUB_SHA','b'*40),('GITHUB_REF','refs/heads/other'),('RUNNER_DEBUG','1'),('ACTIONS_STEP_DEBUG','true')]:
            env=approved();env[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):t.private_input(env)
    def test_approved_secret_popped_and_exact_scope(self):
        env=approved();request=t.private_input(env)
        self.assertNotIn('BUBBLEWASH_UAT_RESTORE_ONCE',env);self.assertEqual(len(request['accounts']),4)
        env=approved();payload=json.loads(env['BUBBLEWASH_UAT_RESTORE_ONCE']);payload['accounts'][0]['path']='/other'
        env['BUBBLEWASH_UAT_RESTORE_ONCE']=json.dumps(payload)
        with self.assertRaises(ValueError):t.private_input(env)


class BoundedPipe(unittest.TestCase):
    def test_payload_is_stdin_not_arguments_or_environment(self):
        code='import os,sys,json; x=sys.stdin.buffer.read(); print(json.dumps({"received":len(x),"only":sorted(os.environ)}))'
        result=json.loads(t.exchange([sys.executable,'-c',code],b'synthetic-private-input'))
        self.assertEqual(result['received'],23)
        self.assertNotIn('BUBBLEWASH_UAT_RESTORE_ONCE',result['only'])
    def test_overflow_and_timeout_fail_without_echoing_output(self):
        with self.assertRaisesRegex(ValueError,'^UAT confidential transport refused$'):
            t.exchange([sys.executable,'-c','import sys;sys.stderr.write("synthetic-private"*10000)'],b'',limit=100)
        with self.assertRaisesRegex(ValueError,'^UAT confidential transport refused$'):
            t.exchange([sys.executable,'-c','import time;time.sleep(2)'],b'',timeout=.1)
    def test_nonzero_child_fails_without_stderr(self):
        with self.assertRaisesRegex(ValueError,'^UAT confidential transport refused$'):
            t.exchange([sys.executable,'-c','import sys;sys.stderr.write("synthetic-private");sys.exit(3)'],b'')


class Receiver(unittest.TestCase):
    def bundle(self):return {name:(ROOT/name).read_text() for name in t.SOURCE_FILES}
    def test_request_never_in_remote_command(self):
        args=t.remote_command(self.bundle());self.assertEqual(args[:3],['tailscale','ssh','root@hermes'])
        self.assertNotIn('synthetic-only-test-password',repr(args))
    def test_node_request_uses_private_pipe_and_absolute_imports(self):
        bundle=self.bundle();payload={'action':'restore','accounts':accounts()}
        def exchange(cmd,raw,**kwargs):
            self.assertNotIn('synthetic-only-test-password',repr(cmd))
            self.assertEqual(json.loads(raw),payload)
            encoded=cmd[-1].split('base64,')[1].split("'")[0]
            source=base64.b64decode(encoded).decode()
            self.assertNotIn("import('better-sqlite3')",source)
            self.assertIn('file:///opt/bubblewash-uat/app/node_modules/better-sqlite3/lib/index.js',source)
            self.assertIn('LimitCORE=0',cmd);self.assertIn('SystemCallFilter=~connect',cmd)
            return b'{"ok":true}'
        with mock.patch.object(c,'read',return_value=(ROOT/'ops/uat/bubblewash-uat.service').read_bytes()),mock.patch.object(t,'exchange',side_effect=exchange):
            self.assertEqual(r.node_request(bundle,payload,OP),{'ok':True})
    def test_data_url_module_executes_with_absolute_local_dependencies(self):
        bundle=self.bundle()
        def exchange(cmd,raw,**kwargs):
            encoded=cmd[-1].split('base64,')[1].split("'")[0]
            source=base64.b64decode(encoded).decode().removesuffix('\nawait runOperator();\n')
            source=source.replace('file:///opt/bubblewash-uat/app/',ROOT.as_uri()+'/')
            source+="\nconst Database=(await import('"+(ROOT/'node_modules/better-sqlite3/lib/index.js').as_uri()+"')).default; const db=new Database(':memory:'); db.close();\n"
            encoded=base64.b64encode(source.encode()).decode()
            child=subprocess.run(['node','--conditions=react-server','--experimental-strip-types','--input-type=module','--eval',"await import('data:text/javascript;base64,"+encoded+"')"],capture_output=True)
            self.assertEqual(child.returncode,0,'synthetic data-URL runtime must load installed dependencies')
            return b'{"ok":true}'
        with mock.patch.object(c,'read',return_value=(ROOT/'ops/uat/bubblewash-uat.service').read_bytes()),mock.patch.object(t,'exchange',side_effect=exchange):
            r.node_request(bundle,{'action':'inspect'},OP)
    def test_changed_private_identity_prevents_restore(self):
        first={'public':{'ok':True},'private':{'database':{'device':'1','inode':'2'},'pid':123}}
        second={'public':{'ok':True},'private':{'database':{'device':'1','inode':'3'},'pid':456}}
        snapshot={'ok':True,'eligible':4,'fingerprint':'a'*64,'inspectedAt':1793661573802,'originalStartsAt':p.ORIGINAL_START,'originalExpiresAt':p.ORIGINAL_START+p.WINDOW}
        with mock.patch.object(r.os,'geteuid',return_value=0),mock.patch.object(c,'collect',side_effect=[first,second]),mock.patch.object(r,'node_request',return_value=snapshot) as node:
            with self.assertRaises(ValueError):r.execute(self.bundle(),{'mode':'restore','operationId':OP,'accounts':accounts()})
            self.assertEqual(node.call_count,1);self.assertEqual(node.call_args.args[1]['action'],'inspect')
    def test_inspect_never_invokes_node(self):
        with mock.patch.object(r.os,'geteuid',return_value=0),mock.patch.object(c,'collect',return_value={'public':{'ok':True},'private':{}}),mock.patch.object(r,'node_request') as node:
            self.assertEqual(r.execute(self.bundle(),{'mode':'inspect','operationId':OP}),{'ok':True});node.assert_not_called()
    def test_preflight_failure_prevents_any_operator(self):
        with mock.patch.object(r.os,'geteuid',return_value=0),mock.patch.object(c,'collect',side_effect=ValueError()),mock.patch.object(r,'node_request') as node:
            with self.assertRaises(ValueError):r.execute(self.bundle(),{'mode':'restore','operationId':OP,'accounts':accounts()})
            node.assert_not_called()
    def test_unknown_receipt_field_refused(self):
        value={'ok':True,'readOnly':True,'automaticRetry':False,'state':'not-observed'}
        self.assertEqual(t.validate_receipt(json.dumps(value).encode(),'receipt'),value)
        with self.assertRaises(ValueError):t.validate_receipt(json.dumps(dict(value,password='synthetic')).encode(),'receipt')
    def test_prepared_entrypoint_cannot_dispatch(self):
        child=subprocess.run([sys.executable,str(ROOT/'ops/uat/restoration-transport.py')],capture_output=True)
        self.assertNotEqual(child.returncode,0);self.assertFalse(json.loads(child.stdout)['entrypointEnabled'])


if __name__=='__main__':unittest.main()
