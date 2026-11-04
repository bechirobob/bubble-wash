import importlib.util
import base64
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module
p = load('uat_restore_preflight', 'ops/uat/restoration-preflight.py')
c = load('uat_restore_collector', 'ops/uat/restoration-collector.py')
t = load('uat_restore_transport', 'ops/uat/restoration-transport.py')
h = load('uat_handoff_host', 'ops/uat/handoff-host.py')
r = load('uat_second_receiver', 'ops/uat/second-cohort-receiver.py')
s = load('uat_second_transport', 'ops/uat/second-cohort-transport.py')

class Integration(unittest.TestCase):
    def bundle(self):
        return {name: (ROOT/name).read_text() for name in s.FILES}

    def test_bootstrap_uses_existing_fixed_route_and_bounded_source(self):
        command = s.remote_command(self.bundle())
        self.assertEqual(command[:3], ['/usr/local/bin/tailscale', 'ssh', 'root@hermes'])
        self.assertLess(len(command[-1].encode()), 120000)
        with self.assertRaises(ValueError):
            s.remote_command(dict(self.bundle(), extra='unexpected'))

    def test_failed_isolation_never_reaches_operator(self):
        with mock.patch.object(c, 'collect', side_effect=ValueError('synthetic isolation failure')), mock.patch.object(r, 'node_request') as node, mock.patch.object(r.os, 'geteuid', return_value=0):
            with self.assertRaises(ValueError):
                r.execute(self.bundle(), {'action':'inspect'})
            node.assert_not_called()

    def test_current_evidence_before_and_after_and_changed_process_refused(self):
        first = {'private':{'database':{'device':'1','inode':'2'},'pid':123}}
        changed = {'private':{'database':{'device':'1','inode':'2'},'pid':124}}
        with mock.patch.object(c, 'collect', side_effect=[first, changed]) as collect, mock.patch.object(r, 'node_request', return_value={'stateSha256':'a'*64,'inspectedAt':1}) as node, mock.patch.object(r.os, 'geteuid', return_value=0):
            with self.assertRaises(ValueError):
                r.execute(self.bundle(), {'action':'inspect'})
            self.assertEqual(collect.call_count, 2)
            self.assertEqual(collect.call_args.kwargs, {'eligible':False,'private':True})
            self.assertEqual(node.call_args.args[1]['expectedDatabaseIdentity'], first['private']['database'])

    def test_node_request_uses_stdin_and_unchanged_sandbox(self):
        payload = {'action':'inspect','expectedDatabaseIdentity':{'device':'1','inode':'2'}}
        with mock.patch.object(c, 'read', return_value=(ROOT/'ops/uat/bubblewash-uat.service').read_bytes()), mock.patch.object(t, 'exchange', return_value=b'{"stateSha256":"synthetic"}') as exchange:
            r.node_request(self.bundle(), payload)
            command, raw = exchange.call_args.args
            self.assertEqual(json.loads(raw), payload)
            self.assertIn('SystemCallFilter=~connect', command)
            self.assertIn('RuntimeMaxSec=120s', command)
            self.assertIn('InaccessiblePaths=-/var/lib/bubblewash -/opt/bubblewash -/etc/bubblewash', command)
            self.assertNotIn('expectedDatabaseIdentity', command[-1])

    def test_unknown_or_extra_request_fields_refused(self):
        for request in [{'action':'restore'}, {'action':'inspect','approved':True}, {'action':'issue'}]:
            with mock.patch.object(r.os, 'geteuid', return_value=0), mock.patch.object(c, 'collect') as collect:
                with self.assertRaises(ValueError):r.execute(self.bundle(), request)
                collect.assert_not_called()

    def test_missing_live_approvals_never_call_transport(self):
        env={'GITHUB_REPOSITORY':'bechirobob/bubble-wash','GITHUB_REF':'refs/heads/main',
             'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_RUN_ATTEMPT':'1','SOURCE_SHA':'a'*40,
             'GITHUB_SHA':'a'*40,'ADMIN_ROUTE_APPROVED':'true','PRIVATE_HANDOVER_APPROVED':'true',
             'RECIPIENT_KEY_VERIFIED':'true','SECOND_COHORT_ISSUANCE_APPROVED':'true'}
        for key in ['ADMIN_ROUTE_APPROVED','PRIVATE_HANDOVER_APPROVED','RECIPIENT_KEY_VERIFIED','SECOND_COHORT_ISSUANCE_APPROVED']:
            with mock.patch.object(s, 'source_bundle') as source, mock.patch.object(t, 'exchange') as exchange:
                with self.assertRaises(ValueError):s.perform(ROOT, dict(env, **{key:'false'}), {'action':'issue'})
                source.assert_not_called();exchange.assert_not_called()

    def test_refuse_unvalidated_remote_output(self):
        for raw in [b'{"password":"synthetic"}', b'{"ok":false,"state":"uncertain-stop"}', b'x'*16385]:
            with self.assertRaises(ValueError):s.validate_result(raw, {'action':'inspect'})

    def test_no_automatic_cli_entrypoint(self):
        import subprocess
        result=subprocess.run([sys.executable, str(ROOT/'ops/uat/second-cohort-transport.py')], capture_output=True)
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(json.loads(result.stdout)['entrypointEnabled'])


class RecipientBinding(unittest.TestCase):
    def test_historical_instance_is_not_modified(self):
        isolated=load('uat_second_private_handoff','ops/uat/private-handoff.py')
        historical=load('uat_original_private_handoff','ops/uat/private-handoff.py')
        old=historical.RECIPIENT
        s.bind_second_recipient(isolated)
        self.assertEqual(isolated.RECIPIENT,s.SECOND_RECIPIENT)
        self.assertEqual(historical.RECIPIENT,old)
        self.assertEqual(old,s.HISTORICAL_RECIPIENT)
        with self.assertRaises(ValueError):s.bind_second_recipient(historical)

    def test_new_operation_cannot_use_this_delivery_key(self):
        env={'GITHUB_REPOSITORY':'bechirobob/bubble-wash','GITHUB_REF':'refs/heads/main',
             'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_RUN_ATTEMPT':'1','SOURCE_SHA':'a'*40,
             'GITHUB_SHA':'a'*40,'ADMIN_ROUTE_APPROVED':'true','PRIVATE_HANDOVER_APPROVED':'true',
             'RECIPIENT_KEY_VERIFIED':'true','SECOND_COHORT_ISSUANCE_APPROVED':'true'}
        for action in ('issue','retrieve'):
            with self.assertRaises(ValueError):s.authorize(env,{'action':action,'operationId':'different-operation'})
            pem='-----BEGIN PUBLIC KEY-----\n'+base64.b64encode(b's'*400).decode()+'\n-----END PUBLIC KEY-----\n'
            with self.assertRaises(ValueError):s.authorize(env,{'action':action,'operationId':s.SECOND_OPERATION_ID,'publicKey':pem})
            with mock.patch.object(s,'SECOND_RECIPIENT',hashlib.sha256(b's'*400).hexdigest()):
                s.authorize(env,{'action':action,'operationId':s.SECOND_OPERATION_ID,'publicKey':pem})


class PrivateStorage(unittest.TestCase):
    def setUp(self):
        self.env={'GITHUB_REPOSITORY':'bechirobob/bubble-wash','GITHUB_REF':'refs/heads/main',
             'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_RUN_ATTEMPT':'1','SOURCE_SHA':'a'*40,
             'GITHUB_SHA':'a'*40,'ADMIN_ROUTE_APPROVED':'true','PRIVATE_HANDOVER_APPROVED':'true',
             'RECIPIENT_KEY_VERIFIED':'true','SECOND_COHORT_ISSUANCE_APPROVED':'true'}
        self.pem='-----BEGIN PUBLIC KEY-----\n'+base64.b64encode(b's'*400).decode()+'\n-----END PUBLIC KEY-----\n'
        self.request={'action':'issue','publicKey':self.pem,'operationId':s.SECOND_OPERATION_ID}
        self.handoff=mock.Mock();self.backup=mock.Mock()
        self.handoff.__name__='uat_second_private_handoff';self.handoff.RECIPIENT=s.HISTORICAL_RECIPIENT
        runtime=json.loads((ROOT/'ops/uat/restoration-runtime-pins.json').read_text())['runtimeRevision']
        self.handoff.context.return_value={'mode':'issue','publicKey':self.pem,'runtimeSha':runtime}
        self.events=[]
        self.handoff.private_store.side_effect=lambda *args:self.events.append('store')
        self.handoff.publish.side_effect=lambda *args:self.events.append('publish') or {'ok':True}
        self.stack=__import__('contextlib').ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(s,'SECOND_RECIPIENT',hashlib.sha256(b's'*400).hexdigest()))
        self.stack.enter_context(mock.patch.object(s,'source_bundle',return_value={}))
        self.stack.enter_context(mock.patch.object(s.subprocess,'check_output',side_effect=lambda args,**kw:(ROOT/args[-1].split(':',1)[1]).read_bytes()))
        self.stack.enter_context(mock.patch.object(s.importlib.util,'spec_from_file_location',return_value=mock.Mock()))
        self.stack.enter_context(mock.patch.object(s.importlib.util,'module_from_spec',side_effect=[self.handoff,self.backup]))
        self.perform=self.stack.enter_context(mock.patch.object(s,'perform',side_effect=lambda *args:self.events.append('issue') or {'synthetic':'ciphertext'}))

    def test_approval_failure_precedes_storage(self):
        with self.assertRaises(ValueError):s.perform_private_handoff(ROOT,dict(self.env,ADMIN_ROUTE_APPROVED='false'),self.request)
        self.handoff.private_store.assert_not_called();self.perform.assert_not_called()

    def test_recipient_mismatch_precedes_storage(self):
        self.handoff.context.return_value['publicKey']='different-key'
        with self.assertRaises(ValueError):s.perform_private_handoff(ROOT,self.env,self.request)
        self.handoff.private_store.assert_not_called();self.perform.assert_not_called()

    def test_runtime_mismatch_precedes_storage(self):
        self.handoff.context.return_value['runtimeSha']='b'*40
        with self.assertRaises(ValueError):s.perform_private_handoff(ROOT,self.env,self.request)
        self.handoff.private_store.assert_not_called();self.perform.assert_not_called()

    def test_storage_failure_prevents_issuance(self):
        self.handoff.private_store.side_effect=ValueError('synthetic storage failure')
        with self.assertRaises(ValueError):s.perform_private_handoff(ROOT,self.env,self.request)
        self.perform.assert_not_called();self.handoff.publish.assert_not_called()

    def test_storage_then_issue_then_publish(self):
        self.assertEqual(s.perform_private_handoff(ROOT,self.env,self.request),{'ok':True})
        self.assertEqual(self.events,['store','issue','publish'])

    def test_publication_failure_never_reissues(self):
        self.handoff.publish.side_effect=ValueError('synthetic publication failure')
        with self.assertRaises(ValueError):s.perform_private_handoff(ROOT,self.env,self.request)
        self.perform.assert_called_once();self.assertEqual(self.events,['store','issue'])

if __name__ == '__main__':unittest.main()
