"""Synthetic inspect-only diagnostic tests; no live host/configuration reads."""
from contextlib import ExitStack
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
p=load('identity_preflight','ops/uat/restoration-preflight.py')
with mock.patch.dict(sys.modules,{'uat_restore_preflight':p}):
    c=load('identity_collector','ops/uat/restoration-collector.py')
t=load('identity_transport','ops/uat/restoration-transport.py')
r=load('identity_receiver','ops/uat/restoration-receiver.py')


class Identity(unittest.TestCase):
    def setUp(self):
        self.identity=(1,2,101_700_000_000,101_700_000_000)
        self.props={'MainPID':123}
        config=dict(p.EXPECTED_ENV,BUBBLEWASH_SESSION_SECRET='x'*64)
        process=dict(config,NODE_ENV='production',HOME=p.DATA,PATH='/usr/bin:/bin')
        self.config='\n'.join(k+'='+v for k,v in config.items()).encode()
        self.process=b'\0'.join((k+'='+v).encode() for k,v in process.items())+b'\0'

    def evidence(self,**overrides):
        patches={'show':{'return_value':self.props},'start':{'return_value':100},
            'trusted':{'return_value':self.identity},'read':{'side_effect':[self.config,self.process]}}
        patches.update(overrides)
        with ExitStack() as stack:
            mocks={name:stack.enter_context(mock.patch.object(c,name,**args)) for name,args in patches.items()}
            result=c.environment_identity_evidence(self.identity,self.props,123,100)
            for call in mocks['read'].call_args_list:
                self.assertIn(call.args,[(p.ENVIRONMENT,16384),('/proc/123/environ',65536)])
            return result

    def test_exact_match_and_value_mismatch_are_private(self):
        self.assertEqual(self.evidence(),{'state':'matched'})
        self.process=self.process.replace(b'x'*64,b'y'*64)
        value=self.evidence();self.assertEqual(value,{'state':'mismatched'})
        for private in ('x'*64,'y'*64,p.ENVIRONMENT,'123',p.DATABASE):self.assertNotIn(private,json.dumps(value))

    def test_unknown_and_forbidden_process_fields_fail_existing_validator(self):
        for field in (b'UNKNOWN=private-canary\0',b'AWS_SECRET_ACCESS_KEY=private-canary\0'):
            with self.subTest(field=field):
                self.assertEqual(self.evidence(read={'side_effect':[self.config,self.process+field]}),{'state':'mismatched'})

    def test_unavailable_reads_and_unexpected_validator_error_are_unavailable(self):
        for reads in ([PermissionError('private-canary')],[self.config,FileNotFoundError('private-canary')]):
            self.assertEqual(self.evidence(read={'side_effect':reads}),{'state':'unavailable'})
        with mock.patch.object(p,'verify_environment',side_effect=RuntimeError('private-canary')):
            self.assertEqual(self.evidence(),{'state':'unavailable'})

    def test_pid_ticks_and_file_identity_changes_at_every_checkpoint_are_unavailable(self):
        for name,old,new in (('show',self.props,{'MainPID':124}),('start',100,101),
                ('trusted',self.identity,(1,3,*self.identity[2:])),
                ('trusted',self.identity,(1,2,self.identity[2]+1,self.identity[3]))):
            for position in range(3):
                values=[old]*3;values[position]=new
                with self.subTest(name=name,position=position):
                    self.assertEqual(self.evidence(**{name:{'side_effect':values}}),{'state':'unavailable'})

    def bundle(self):return {name:(ROOT/name).read_text() for name in t.SOURCE_FILES}

    def receipt(self,state):
        error=p.TimestampGuardFailure([('environment','ctime-after-process-start')])
        error.environment_identity_evidence={'state':state}
        with mock.patch.dict(sys.modules,{'uat_restore_preflight':p}):
            return t.inspection_failure(error,self.bundle(),'host-inspection')

    def test_every_receipt_stays_failed_and_other_modes_reject_it(self):
        for state in ('matched','mismatched','unavailable'):
            result=self.receipt(state)
            self.assertEqual(result['environmentIdentityEvidence'],{'state':state})
            self.assertFalse(result['ok']);self.assertFalse(result['automaticRetry'])
            self.assertEqual(result['state'],'inspection-failed')
            t.validate_inspection_failure(result,self.bundle(),host_only=True)
            for mode in ('restore','receipt'):
                with self.assertRaises(ValueError):t.validate_receipt(json.dumps(result).encode(),mode,inspection_bundle=self.bundle())

    def test_unknown_receipt_states_fields_categories_and_stages_are_rejected(self):
        result=self.receipt('matched')
        for value in ({'state':'yes'},{'state':True},{'state':'matched','raw':'private-canary'},{}):
            with self.assertRaises(ValueError):t.validate_inspection_failure(dict(result,environmentIdentityEvidence=value),self.bundle())
        for changed in ({'failureStage':'transport'}, {'ok':True},
                {'timestampFailures':[{'category':'service-unit','comparison':'ctime-after-process-start'}]}):
            with self.assertRaises(ValueError):t.validate_inspection_failure(dict(result,**changed),self.bundle())

    def test_collect_always_reraises_original_guard_and_no_other_checks_run(self):
        for enabled,mixed in ((False,False),(True,False),(True,True)):
            for state in ('matched','mismatched','unavailable'):
                with self.subTest(enabled=enabled,mixed=mixed,state=state),ExitStack() as stack:
                    stack.enter_context(mock.patch.object(c.os,'geteuid',return_value=0))
                    stack.enter_context(mock.patch.object(c.pwd,'getpwnam',return_value=SimpleNamespace(pw_uid=1001,pw_gid=1001,pw_dir=p.DATA,pw_shell='/usr/sbin/nologin')))
                    stack.enter_context(mock.patch.object(c,'show',return_value=self.props))
                    stack.enter_context(mock.patch.object(c,'process_evidence',return_value=({'pid':123},100)))
                    stack.enter_context(mock.patch.object(c,'trusted',return_value=self.identity))
                    stack.enter_context(mock.patch.object(c.os.path,'lexists',return_value=False))
                    stack.enter_context(mock.patch.object(c,'read',return_value=b'btime 100\n'))
                    stack.enter_context(mock.patch.object(c.os,'sysconf',return_value=100))
                    failures=[('environment','ctime-after-process-start')]
                    if mixed:failures.append(('service-unit','mtime-after-process-start'))
                    original=p.TimestampGuardFailure(failures)
                    stack.enter_context(mock.patch.object(c,'verify_config_timestamps',side_effect=original))
                    stack.enter_context(mock.patch.object(c,'environment_timestamp_evidence',return_value={'state':'unavailable'}))
                    diagnostic=stack.enter_context(mock.patch.object(c,'environment_identity_evidence',return_value={'state':state}))
                    later=[stack.enter_context(mock.patch.object(p,name)) for name in ('verify_runtime','verify_service','inspect_accounts')]
                    with self.assertRaises(p.TimestampGuardFailure) as captured:
                        c.collect({'runtimeRevision':'a'*40,'runtimeFiles':{},'unitSha256':'b'*64},timestamp_diagnostic=enabled)
                    self.assertIs(captured.exception,original)
                    self.assertEqual(diagnostic.call_count,int(enabled and not mixed))
                    for check in later:check.assert_not_called()

    def test_only_inspect_receiver_enables_diagnostics(self):
        for mode in ('inspect','restore','receipt'):
            with mock.patch.object(r,'dependencies',return_value=(p,c,t)),mock.patch.object(r.os,'geteuid',return_value=0),\
                    mock.patch.object(c,'collect',side_effect=p.TimestampGuardFailure([('environment','ctime-after-process-start')])) as collector,\
                    mock.patch.object(r,'node_request') as node:
                request={'mode':mode,'operationId':'e01f1a5d-3297-4c22-b246-7bdb509289ca'}
                if mode=='restore':request['accounts']=[]
                if mode=='inspect':self.assertFalse(r.execute(self.bundle(),request)['ok'])
                else:
                    with self.assertRaises(p.TimestampGuardFailure):r.execute(self.bundle(),request)
                self.assertEqual(collector.call_args.kwargs.get('timestamp_diagnostic',False),mode=='inspect')
                node.assert_not_called()


if __name__=='__main__':unittest.main()
