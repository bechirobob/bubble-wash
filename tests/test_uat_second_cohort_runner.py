import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('runner',ROOT/'ops/uat/second-cohort-runner.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)


def environment(mode='issue'):
    return {'GITHUB_REPOSITORY':'bechirobob/bubble-wash','GITHUB_REF':'refs/heads/main',
            'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_RUN_ATTEMPT':'1','SOURCE_SHA':'a'*40,
            'GITHUB_SHA':'a'*40,'MODE':mode,'UAT_OPERATION_ID':'6cd01672-7084-4e80-9dbb-2172dc78707b',
            **{key:'true' for key in r.GATES}}


class Runner(unittest.TestCase):
    def test_each_missing_gate_stops_before_source_or_host_work(self):
        for gate in r.GATES:
            with self.subTest(gate=gate),mock.patch.object(r,'pinned_module') as loader:
                with self.assertRaises(ValueError):r.prepare(ROOT,dict(environment(),**{gate:'false'}))
                loader.assert_not_called()

    def test_exact_context_first_attempt_no_debug(self):
        for key,value in [('MODE','restore'),('SOURCE_SHA','b'*40),('GITHUB_RUN_ATTEMPT','2'),
                          ('GITHUB_REF','refs/heads/other'),('RUNNER_DEBUG','1'),
                          ('ACTIONS_STEP_DEBUG','true'),('UAT_OPERATION_ID','bad')]:
            with self.subTest(key=key),mock.patch.object(r,'pinned_module') as loader:
                with self.assertRaises(ValueError):r.prepare(ROOT,dict(environment(),**{key:value}))
                loader.assert_not_called()

    def test_prepare_derives_only_reviewed_runtime_and_verified_context(self):
        transport=mock.Mock();handoff=mock.Mock()
        transport.source_bundle.return_value={'ops/uat/restoration-runtime-pins.json':json.dumps({'runtimeRevision':'c'*40})}
        handoff.context.return_value={'publicKey':'synthetic-public-key'}
        with mock.patch.object(r.subprocess,'check_output',side_effect=lambda args,**kw:(ROOT/args[-1].split(':',1)[1]).read_bytes()),mock.patch.object(r,'pinned_module',side_effect=[mock.Mock(),transport,handoff]):
            result,env,request=r.prepare(ROOT,environment())
        self.assertIs(result,transport);self.assertEqual(env['RUNTIME_SHA'],'c'*40)
        self.assertEqual(request['publicKey'],'synthetic-public-key')
        self.assertNotIn('expectedStateSha256',request)
        handoff.context.assert_called_once();transport.authorize.assert_called_once()

    def test_wrong_recipient_context_prevents_all_host_work(self):
        transport=mock.Mock();handoff=mock.Mock();handoff.context.side_effect=ValueError('synthetic key mismatch')
        transport.source_bundle.return_value={'ops/uat/restoration-runtime-pins.json':'{"runtimeRevision":"synthetic"}'}
        with mock.patch.object(r.subprocess,'check_output',side_effect=lambda args,**kw:(ROOT/args[-1].split(':',1)[1]).read_bytes()),mock.patch.object(r,'pinned_module',side_effect=[mock.Mock(),transport,handoff]):
            with self.assertRaises(ValueError):r.prepare(ROOT,environment())
        transport.perform.assert_not_called();transport.perform_private_handoff.assert_not_called()

    def test_issue_uses_host_snapshot_privately_once(self):
        transport=mock.Mock();transport.perform.return_value={'stateSha256':'d'*64,'inspectedAt':1000}
        transport.perform_private_handoff.return_value={'ok':True,'state':'sealed-uat-handover-stored'}
        request={'action':'issue','operationId':'synthetic-operation'}
        with mock.patch.object(r,'prepare',return_value=(transport,environment(),request)):
            result=r.run(ROOT,environment())
        transport.perform.assert_called_once_with(ROOT,environment(),{'action':'inspect'})
        self.assertEqual(request['notBefore'],1000);self.assertEqual(request['approvedUntil'],301000)
        self.assertEqual(request['expectedStateSha256'],'d'*64)
        self.assertNotIn('stateSha256',result);transport.perform_private_handoff.assert_called_once()

    def test_retrieve_does_not_inspect_or_issue(self):
        transport=mock.Mock();request={'action':'retrieve','operationId':'same-operation'}
        with mock.patch.object(r,'prepare',return_value=(transport,environment('retrieve'),request)):
            r.run(ROOT,environment('retrieve'))
        transport.perform.assert_not_called();transport.perform_private_handoff.assert_called_once()
        self.assertEqual(request,{'action':'retrieve','operationId':'same-operation'})

    def test_inspection_failure_prevents_issuance(self):
        transport=mock.Mock();transport.perform.side_effect=ValueError('synthetic failure')
        with mock.patch.object(r,'prepare',return_value=(transport,environment(),{'action':'issue'})):
            with self.assertRaises(ValueError):r.run(ROOT,environment())
        transport.perform_private_handoff.assert_not_called()

    def test_uncertain_failure_never_echoes_or_retries(self):
        output=io.StringIO()
        with mock.patch.object(r,'run',side_effect=ValueError('synthetic-private-password')) as run,contextlib.redirect_stdout(output):
            self.assertEqual(r.main([]),1)
        run.assert_called_once()
        self.assertEqual(json.loads(output.getvalue()),{'ok':False,'automaticRetry':False,'state':'uncertain-stop'})

    def test_check_only_never_claims_handover_ready(self):
        output=io.StringIO()
        with mock.patch.object(r,'prepare'),mock.patch.object(r,'run') as run,contextlib.redirect_stdout(output):
            self.assertEqual(r.main(['--check']),0)
        run.assert_not_called()
        self.assertEqual(json.loads(output.getvalue()),{'ok':True,'localGatesAccepted':True,'hostContacted':False})

    def test_protected_workflow_order_and_secret_scope(self):
        source=(ROOT/'.github/workflows/uat-second-cohort.yml').read_text()
        self.assertIn('environment: backup-storage',source)
        self.assertIn('group: bubblewash-production',source)
        self.assertIn('cancel-in-progress: false',source)
        self.assertIn('contents: read',source)
        self.assertLess(source.index('runner.py --check'),source.index('ops/check-release-ci.py'))
        self.assertLess(source.index('ops/check-release-ci.py'),source.index('uses: tailscale/github-action@'))
        self.assertLess(source.index('uses: tailscale/github-action@'),source.index('GH_TOKEN:'))
        self.assertEqual(source.count('secrets.'),3)
        self.assertNotIn('upload-artifact',source)
        self.assertTrue(all('${{ inputs.' not in line for line in source.splitlines() if line.lstrip().startswith('run:')))
        self.assertNotIn('set -x',source)

if __name__=='__main__':unittest.main()
