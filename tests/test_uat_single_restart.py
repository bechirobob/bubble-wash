"""Local synthetic restart boundaries; never invokes host/service/network commands."""
from contextlib import ExitStack
import importlib.util
import json
from pathlib import Path
import shlex
import sys
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('single_restart_review',ROOT/'ops/uat/single-restart.py')
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)

class Restart(unittest.TestCase):
    def setUp(self):
        self.request={'operationId':'e01f1a5d-3297-4c22-b246-7bdb509289ca','restartApproved':True,'quietWindowCoordinated':True}
        self.bundle={'ops/uat/restoration-runtime-pins.json':'{}'}
        self.before={'pid':123,'startTicks':100,'database':[1,2], 'configObjects':{'private':'canary'},'productionPaths':['private-path']}
        self.after=dict(self.before,pid=124,startTicks=200)
    def execute(self,observations=None,exchange_error=None):
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(s.os,'geteuid',return_value=0))
            collect=stack.enter_context(mock.patch.object(s.c,'collect_restart_isolation',side_effect=observations or [self.before,self.before,self.after,self.after]))
            loaded=stack.enter_context(mock.patch.object(s,'loaded_unit',return_value={'verified':True}))
            quiet=stack.enter_context(mock.patch.object(s,'quiet_sample'))
            health=stack.enter_context(mock.patch.object(s,'health'))
            exchange=stack.enter_context(mock.patch.object(s.t,'exchange',side_effect=exchange_error,return_value=b''))
            stack.enter_context(mock.patch.object(s.time,'monotonic',side_effect=[0,100,200,300]))
            stack.enter_context(mock.patch.object(s.time,'sleep'))
            result=s.execute(self.bundle,self.request)
            self.assertNotIn('canary',json.dumps(result));self.assertNotIn('private-path',json.dumps(result))
            return result,collect,exchange,quiet,health
    def test_success_requests_exactly_one_restart_and_never_account_action(self):
        result,collect,exchange,quiet,health=self.execute()
        self.assertEqual(result,s.receipt('verified'));exchange.assert_called_once_with(['/usr/bin/systemctl','--job-mode=fail','restart',s.p.SERVICE],b'',timeout=45,limit=4096)
        self.assertEqual([call.kwargs['before_restart'] for call in collect.call_args_list],[True,True,False,False])
        self.assertEqual(quiet.call_count,2);health.assert_called_once()
    def test_precheck_error_and_identity_drift_never_request_restart(self):
        for observations in ([ValueError('private-canary')],[self.before,dict(self.before,pid=125)]):
            result,_,exchange,_,_=self.execute(observations)
            self.assertEqual(result,s.receipt('precheck-failed'));exchange.assert_not_called()
    def test_timeout_is_uncertain_without_retry_or_postcheck(self):
        result,collect,exchange,_,health=self.execute(exchange_error=TimeoutError('private-canary'))
        self.assertEqual(result,s.receipt('restart-uncertain'));self.assertEqual(exchange.call_count,1)
        self.assertEqual(collect.call_count,2);health.assert_not_called()
    def test_postcheck_failure_or_identity_drift_never_issues_second_action(self):
        for changed in (ValueError('private-canary'),self.before,dict(self.after,database=[1,3]),dict(self.after,configObjects={}),dict(self.after,productionPaths=[])):
            result,_,exchange,_,_=self.execute([self.before,self.before,changed])
            self.assertEqual(result,s.receipt('postcheck-failed'));self.assertEqual(exchange.call_count,1)
    def test_receipts_are_closed_and_boolean_typed(self):
        for state in ('verified','precheck-failed','restart-uncertain','postcheck-failed'):
            value=s.receipt(state);self.assertEqual(s.validate_receipt(value),value)
            for changed in (dict(value,raw='canary'),dict(value,accountAction=True),dict(value,ok=int(value['ok']))):
                with self.assertRaises(ValueError):s.validate_receipt(changed)
        with self.assertRaises(ValueError):s.validate_receipt({'state':'arbitrary'})
    def test_missing_or_nonboolean_authorization_rejected_before_any_check(self):
        for field in ('restartApproved','quietWindowCoordinated'):
            for value in (False,1,'true',None):
                request=dict(self.request,**{field:value})
                with mock.patch.object(s.os,'geteuid',return_value=0),mock.patch.object(s.c,'collect_restart_isolation') as collect:
                    with self.assertRaises(ValueError):s.execute(self.bundle,request)
                    collect.assert_not_called()
    def test_loaded_unit_typed_execstart_and_exact_properties(self):
        rows={**{key:'' for key in s.EMPTY},**s.FIXED,'Requires':'sysinit.target system.slice','Wants':'','Conflicts':'shutdown.target'}
        raw='\n'.join(k+'='+v for k,v in rows.items())
        typed=shlex.join(['a(sasbttttuii)','1',s.ARGV[0],str(len(s.ARGV)),*s.ARGV,'false',*['0']*7])
        with mock.patch.object(s,'dependency_state',return_value={'verified':True}),mock.patch.object(s.c,'command',side_effect=[raw,typed]):
            self.assertEqual(s.loaded_unit(),dict(rows,dependencyEvidence={name:{'verified':True} for name in ('sysinit.target','system.slice')}))
        for bad in (raw+'\nUnknown=x',raw.replace('ExecStop=','ExecStop=/bin/false'),raw.replace('Requires=sysinit.target system.slice','Requires=production.service')):
            with mock.patch.object(s.c,'command',return_value=bad),self.assertRaises(ValueError):s.loaded_unit()
        for bad in (typed.replace('3108','3100'),typed.replace('false','true'),typed+' 0'):
            with mock.patch.object(s,'dependency_state',return_value={'verified':True}),mock.patch.object(s.c,'command',side_effect=[raw,bad]),self.assertRaises(ValueError):s.loaded_unit()
    def test_source_mismatch_refuses_before_any_transport_action(self):
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/s.SELF;file.parent.mkdir(parents=True);file.write_text('reviewed-source')
            with mock.patch.object(s,'context',return_value=self.request),mock.patch.object(s.t,'source_bundle',return_value={}),mock.patch.object(s.subprocess,'check_output',return_value=b'different-source'),mock.patch.object(s.t,'exchange') as exchange:
                with self.assertRaises(ValueError):s.perform(directory,{'SOURCE_SHA':'a'*40})
                exchange.assert_not_called()

    def test_context_requires_existing_inspect_admin_validation(self):
        env={'UAT_RESTORE_MODE':'inspect','UAT_RESTART_APPROVED':'true','UAT_QUIET_WINDOW_COORDINATED':'true'}
        with mock.patch.object(s.t,'private_input',return_value={'operationId':self.request['operationId']}) as verify:
            self.assertEqual(s.context(env),self.request);verify.assert_called_once_with(env)
        with mock.patch.object(s.t,'private_input',side_effect=ValueError('refused')),self.assertRaises(ValueError):s.context(env)

if __name__=='__main__':unittest.main()
