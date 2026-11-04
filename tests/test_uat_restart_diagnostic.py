"""Synthetic read-only restart prechecks; no live host or network operations."""
import ast
import base64
from contextlib import ExitStack, redirect_stdout
import importlib.util
import json
import io
from pathlib import Path
import shlex
import types
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('restart_diagnostic_review',ROOT/'ops/uat/single-restart.py')
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)

class Diagnostic(unittest.TestCase):
    def setUp(self):
        self.bundle={name:(ROOT/name).read_text() for name in s.REMOTE_FILES}
        self.request={'mode':'inspect','operationId':'e01f1a5d-3297-4c22-b246-7bdb509289ca'}
        self.evidence={'pid':123,'private':'configuration-canary'}
    def run_case(self,stage):
        module=types.ModuleType('fixed_source_diagnostic');module.__file__=str(ROOT/s.SELF)
        exec(compile(self.bundle[s.SELF],s.SELF,'exec'),module.__dict__)
        error=ValueError('configuration-canary /private/path password-canary')
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(module.os,'geteuid',return_value=0))
            collect=stack.enter_context(mock.patch.object(module.c,'collect_restart_isolation',side_effect=[error] if stage=='isolation' else [self.evidence,{} if stage=='identity-confirmation' else self.evidence]))
            stack.enter_context(mock.patch.object(module,'loaded_unit',side_effect=error if stage=='loaded-unit' else None,return_value={'private':'unit-canary'}))
            stack.enter_context(mock.patch.object(module,'quiet_sample',side_effect=error if stage=='quiescence' else None))
            forbidden=[stack.enter_context(mock.patch.object(obj,name,side_effect=AssertionError('forbidden'))) for obj,name in ((module,'execute'),(module.t,'exchange'),(module,'health'))]
            result=module.inspect_prechecks(self.bundle,self.request)
            for method in forbidden:method.assert_not_called()
            self.assertTrue(all(call.kwargs=={'before_restart':True} for call in collect.call_args_list))
            s.validate_inspection(result,self.bundle)
            self.assertNotIn('canary',json.dumps(result));self.assertNotIn('/private',json.dumps(result))
            return result
    def test_every_stage_is_private_readonly_and_cannot_restart(self):
        for stage in ('isolation','loaded-unit','quiescence','identity-confirmation'):
            with self.subTest(stage=stage):
                value=self.run_case(stage)
                self.assertEqual(value['failureStage'],stage);self.assertFalse(value['precheckPassed'])
                self.assertEqual(value['failureProperties'],[])
                self.assertTrue(value['failureSites']);self.assertTrue(all(token.startswith('R-L') for token in value['failureSites']))
                self.assertFalse(value['ok']);self.assertTrue(value['readOnly'])
    def test_success_is_still_not_admission(self):
        value=self.run_case('complete')
        self.assertTrue(value['precheckPassed']);self.assertFalse(value['ok']);self.assertEqual(value['failureSites'],[])
        with self.assertRaises(ValueError):s.validate_receipt(value)
    def test_unknown_fields_tokens_stages_and_boolean_integers_refused(self):
        value=s.inspection_receipt('unavailable')
        for changes in ({'raw':'canary'},{'failureSites':['R-L999999']},{'failureSites':['/private/path']},{'failureSites':[1]}, {'failureStage':'restart'},{'ok':0},{'readOnly':1},{'automaticRetry':0},{'precheckPassed':0}):
            with self.subTest(changes=changes),self.assertRaises(ValueError):s.validate_inspection(dict(value,**changes),self.bundle)
        token=next(iter(s.diagnostic_sites(self.bundle)[s.SELF].values()))
        with self.assertRaises(ValueError):s.validate_inspection(s.inspection_receipt('complete',[token]),self.bundle)
        with self.assertRaises(ValueError):s.validate_inspection(s.inspection_receipt('isolation',[token]*9),self.bundle)
    def test_request_extra_restart_flags_or_wrong_mode_refused(self):
        for request in (dict(self.request,restartApproved=True),dict(self.request,quietWindowCoordinated=True),dict(self.request,mode='restart'),dict(self.request,operationId='bad')):
            with mock.patch.object(s.os,'geteuid',return_value=0),mock.patch.object(s.c,'collect_restart_isolation') as collect:
                with self.assertRaises(ValueError):s.inspect_prechecks(self.bundle,request)
                collect.assert_not_called()
    def test_host_dispatch_selects_inspect_without_execute(self):
        output=io.StringIO()
        with mock.patch.object(s.sys,'stdin',types.SimpleNamespace(buffer=io.BytesIO(json.dumps(self.request).encode()))),mock.patch.object(s.resource,'setrlimit'),mock.patch.object(s,'inspect_prechecks',return_value=s.inspection_receipt('complete')) as inspect,mock.patch.object(s,'execute') as execute,redirect_stdout(output):
            s.host_main(self.bundle)
            inspect.assert_called_once_with(self.bundle,self.request);execute.assert_not_called()
        self.assertTrue(s.validate_inspection(json.loads(output.getvalue()),self.bundle)['readOnly'])

    def test_inspect_context_does_not_claim_restart_or_quiet_approval(self):
        env={'UAT_RESTORE_MODE':'inspect','UAT_RESTART_MODE':'inspect'}
        with mock.patch.object(s.t,'private_input',return_value={'operationId':self.request['operationId']}) as verify:
            self.assertEqual(s.context(env),self.request);verify.assert_called_once_with(env)
        with mock.patch.object(s.t,'private_input',side_effect=ValueError('admin-refused')),self.assertRaises(ValueError):s.context(env)
    def test_transmitted_bundle_is_explicit_minimal_set_after_full_source_verification(self):
        full={name:(ROOT/name).read_text() for name in s.t.SOURCE_FILES}
        events=[]
        def source(root,sha):events.append('verified');return dict(full)
        def exchange(command,payload,**kwargs):
            self.assertEqual(events,['verified']);self.assertEqual(json.loads(payload),self.request)
            self.assertEqual(command[:3],['/usr/local/bin/tailscale','ssh','root@hermes'])
            code=shlex.split(command[3])[-1]
            decode=next(node for node in ast.walk(ast.parse(code)) if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and node.func.attr=='b64decode')
            encoded=ast.literal_eval(decode.args[0]);self.assertLess(len(encoded),120000)
            bootstrap=ast.parse(base64.b64decode(encoded).decode())
            assignment=next(node for node in bootstrap.body if isinstance(node,ast.Assign) and isinstance(node.targets[0],ast.Name) and node.targets[0].id=='bundle')
            sent=json.loads(ast.literal_eval(assignment.value.args[0]))
            self.assertEqual(set(sent),set(s.REMOTE_FILES));self.assertEqual(sent,self.bundle)
            self.assertNotIn('scripts/uat-restore-original.mjs',sent)
            self.assertNotIn('ops/uat/restoration-receiver.py',sent)
            return json.dumps(s.inspection_receipt('complete')).encode()
        with mock.patch.object(s,'context',return_value=self.request),mock.patch.object(s.t,'source_bundle',side_effect=source),mock.patch.object(s.subprocess,'check_output',return_value=(ROOT/s.SELF).read_bytes()),mock.patch.object(s.t,'exchange',side_effect=exchange):
            self.assertTrue(s.perform(ROOT,{'SOURCE_SHA':'a'*40})['precheckPassed'])


    def service_fixture(self):
        # Evaluate only the fixed expected literal from the reviewed local source.
        tree=ast.parse(self.bundle['ops/uat/restoration-preflight.py'])
        function=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='verify_service')
        expected=next(node.value for node in function.body if isinstance(node,ast.Assign) and node.targets[0].id=='expected')
        properties=eval(compile(ast.Expression(expected),'<fixed-test-fixture>','eval'),vars(s.p))
        self.assertEqual(set(properties),s.p.SERVICE_PROPERTY_NAMES)
        properties.update(MainPID=123,ControlGroup='/system.slice/'+s.p.SERVICE)
        process={'pid':123,'uids':[1001]*4,'gids':[1001]*4,'groups':[1001],
            'cwd':s.p.APP,'executable':'/usr/bin/node','NoNewPrivs':1,'Seccomp':2,
            'effectiveCapabilities':0,'cgroup':properties['ControlGroup'],
            'listeners':[{'address':'127.0.0.1','port':3108,'pid':123}]}
        return properties,process

    def test_each_expected_property_still_refuses_mismatch_or_absence(self):
        for name in sorted(s.p.SERVICE_PROPERTY_NAMES):
            for absent in (False,True):
                with self.subTest(name=name,absent=absent):
                    properties,process=self.service_fixture()
                    if absent:properties.pop(name)
                    else:properties[name]='password-canary /private/path'
                    with self.assertRaises(s.p.ServicePropertyGuardFailure) as caught:
                        s.p.verify_service(properties,process,1001,1001)
                    self.assertEqual(caught.exception.names,(name,))
                    self.assertNotIn('canary',str(caught.exception))
                    self.assertNotIn('/private',str(caught.exception))
        properties,process=self.service_fixture()
        self.assertTrue(all(s.p.verify_service(properties,process,1001,1001).values()))

    def test_process_checks_still_fail_without_property_details(self):
        properties,process=self.service_fixture()
        for key in process:
            with self.subTest(key=key),self.assertRaises(ValueError) as caught:
                s.p.verify_service(properties,dict(process,**{key:None}),1001,1001)
            self.assertNotIsInstance(caught.exception,s.p.ServicePropertyGuardFailure)

    def test_inspection_exports_only_fixed_names_and_never_restarts(self):
        properties,process=self.service_fixture()
        properties.update(ProtectSystem='password-canary /private/path',User='identity-canary')
        properties['unknown-private-property']='value-canary'
        def collect(*args,**kwargs):return s.p.verify_service(properties,process,1001,1001)
        for stage in ('isolation','identity-confirmation'):
            effects=[collect] if stage=='isolation' else [lambda *a,**k:self.evidence,collect]
            def next_collect(*args,**kwargs):return effects.pop(0)(*args,**kwargs)
            with mock.patch.object(s.os,'geteuid',return_value=0),mock.patch.object(s.c,'collect_restart_isolation',side_effect=next_collect),mock.patch.object(s,'loaded_unit',return_value={}),mock.patch.object(s,'quiet_sample'),mock.patch.object(s,'execute') as execute,mock.patch.object(s.t,'exchange') as exchange,mock.patch.object(s,'health') as health:
                value=s.inspect_prechecks(self.bundle,self.request)
                execute.assert_not_called();exchange.assert_not_called();health.assert_not_called()
            self.assertEqual(value['failureStage'],stage)
            self.assertEqual(value['failureProperties'],['ProtectSystem','User'])
            self.assertFalse(value['precheckPassed']);self.assertFalse(value['ok'])
            self.assertTrue(value['readOnly']);s.validate_inspection(value,self.bundle)
            self.assertNotIn('canary',json.dumps(value));self.assertNotIn('/private',json.dumps(value))
            with self.assertRaises(ValueError):s.validate_receipt(value)

    def test_generic_exception_cannot_inject_property_details(self):
        error=ValueError('password-canary /private/path')
        error.names=('User',)
        with mock.patch.object(s.os,'geteuid',return_value=0),mock.patch.object(s.c,'collect_restart_isolation',side_effect=error):
            value=s.inspect_prechecks(self.bundle,self.request)
        self.assertEqual(value['failureProperties'],[])
        self.assertNotIn('canary',json.dumps(value))

    def test_property_details_have_closed_schema(self):
        value=s.inspection_receipt('isolation')
        for names in (None,'User',('User',),[1],['Unknown'],['/private/path'],['User=canary'],['User','User'],['User','ProtectSystem']):
            with self.subTest(names=names),self.assertRaises(ValueError):
                s.validate_inspection(dict(value,failureProperties=names),self.bundle)
        for stage in ('complete','unavailable','loaded-unit','quiescence'):
            with self.subTest(stage=stage),self.assertRaises(ValueError):
                s.validate_inspection(s.inspection_receipt(stage,properties=['User']),self.bundle)
        value.pop('failureProperties')
        with self.assertRaises(ValueError):s.validate_inspection(value,self.bundle)
        for names in ([],['Unknown'],['User','User'],['User','ProtectSystem']):
            with self.subTest(names=names),self.assertRaises(ValueError):s.p.ServicePropertyGuardFailure(names)

if __name__=='__main__':unittest.main()
