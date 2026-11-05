"""Synthetic contract/transport tests. No network, host execution or real credentials."""
import copy, importlib.util, io, json, types, unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock
ROOT=Path(__file__).resolve().parents[1]
def load(name,path):
 s=importlib.util.spec_from_file_location(name,ROOT/path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
host=load('administrator_host','ops/administrator-transition-host.py')
contract=load('administrator_contract','ops/administrator-transition-contract.py')
contract.owner=load('original_owner','ops/owner-document-host.py');host.old=contract
transport=load('administrator_transport','ops/administrator-transition-transport.py')
pins={'deploymentAccepted':True,'runtimeSha':'b'*40,'runtimePins':{'runtimeSha':'b'*40},'runtimeSources':{'ops/administrator-invitation-transition.ts':'c'*64},'schemaBeforeSha256':'d'*64,'schemaAfterSha256':'e'*64}
req={'operation':contract.OPERATION,'mode':'check','approved':False,'recipient':{'email':'abigail@bubblewash.co','name':'Abigail Kabirou'},'context':{'controlSha':'a'*40,'runtimeSha':'b'*40,'runId':'123','runAttempt':'1','actor':'fixture'},'publicKey':'','backup':None,'expectedFingerprint':''}
class AdapterTests(unittest.TestCase):
 def setUp(self):host.pins=copy.deepcopy(pins)
 def test_check_contract(self):self.assertEqual(host.validate(copy.deepcopy(req)),req)
 def test_disabled_acceptance(self):
  host.pins['deploymentAccepted']=False
  with self.assertRaises(ValueError):host.validate(req)
 def test_wrong_operation_recipient_runtime_retry(self):
  bad=[]
  for k,v in [('operation','owner'),('mode','renew-document'),('recipient',{'email':'other@example.invalid','name':'Other'}),('expectedFingerprint','f'*64)]:bad.append({**req,k:v})
  for k,v in [('runtimeSha','f'*40),('runAttempt','2')]:bad.append({**req,'context':{**req['context'],k:v}})
  for r in bad:
   with self.assertRaises(ValueError):host.validate(r)
 def test_transition_requires_approval_and_backup(self):
  with self.assertRaises(ValueError):host.validate({**req,'mode':'transition-document'})
 def test_uat_configuration_refused(self):
  host.modules={'preserving':types.SimpleNamespace(parse=lambda x:json.loads(x))}
  config={'NODE_ENV':'production','BUBBLEWASH_BOOKINGS_DISABLED':'true','BUBBLEWASH_STAFF_AUTH_DISABLED':'false','BUBBLEWASH_DISABLE_DEMO_LOGIN':'true','NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED':'false'}
  host.configuration(json.dumps(config).encode())
  with self.assertRaises(ValueError):host.configuration(json.dumps({**config,'BUBBLEWASH_UAT_ENABLED':'true'}).encode())
 def test_source_pins_and_payload(self):
  for name in transport.SOURCE_PINS:transport.source(name)
  raw=transport.payload(req,pins);compile(raw,'synthetic','exec');self.assertIn(b'old.owner=owner',raw)
 def test_acceptance_false_stops_before_any_invocation(self):
  with mock.patch.object(transport,'module',side_effect=AssertionError('No invocation permitted')),redirect_stdout(io.StringIO()) as out:
   with self.assertRaises(SystemExit):transport.main()
  result=json.loads(out.getvalue());self.assertEqual(result['state'],'blocked');self.assertEqual(result['stage'],'input');self.assertFalse(result['retryPermitted'])
 def test_ambiguous_host_and_storage_outcomes_stop(self):
  r={**req,'mode':'transition-document'}
  for storage in [False,True]:
   facts=types.SimpleNamespace(bounded=mock.Mock(return_value=b'{"schema":"synthetic"}') if storage else mock.Mock(side_effect=TimeoutError()))
   backup=types.SimpleNamespace(GitHub=lambda _:object())
   with mock.patch.object(transport,'source',return_value=json.dumps(pins).encode()),mock.patch.object(transport,'input_request',return_value=(r,host)),mock.patch.object(transport,'module',side_effect=[facts,backup]),mock.patch.object(transport,'store_preflight'),mock.patch.object(transport,'payload',return_value=b'synthetic'),mock.patch.object(transport,'runner_environment',return_value={}),mock.patch.object(transport,'publish',side_effect=RuntimeError('storage ambiguous')) as publish,redirect_stdout(io.StringIO()) as out:
    with self.assertRaises(SystemExit):transport.main()
   result=json.loads(out.getvalue());self.assertEqual(result['state'],'outcome-uncertain-stop');self.assertFalse(result['retryPermitted']);self.assertEqual(facts.bounded.call_count,1);self.assertEqual(publish.call_count,int(storage))
 def test_context_is_operation_bound(self):
  self.assertEqual(contract.context(req)['operation'],contract.OPERATION)
 def test_workflow_shared_serialization(self):
  text=(ROOT/'.github/workflows/administrator-invitation-transition.yml').read_text()
  for expected in ['workflow_dispatch:','group: bubblewash-production','cancel-in-progress: false','--runner-only','deploymentAccepted','contents: read']:self.assertIn(expected,text)
if __name__=='__main__':unittest.main()
