"""Synthetic contract/transport tests. No network, host execution or real credentials."""
import base64, copy, hashlib, importlib.util, io, json, types, unittest
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
  with mock.patch.object(transport,'source',return_value=json.dumps({'deploymentAccepted':False}).encode()),mock.patch.object(transport,'input_request',side_effect=AssertionError('No request permitted')),mock.patch.object(transport,'module',side_effect=AssertionError('No invocation permitted')),redirect_stdout(io.StringIO()) as out:
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
 def test_release_body_exact_bounded_roundtrip(self):
  raw=b'{"synthetic":"encrypted-envelope-only"}';digest=hashlib.sha256(raw).hexdigest()
  body=transport.release_body(raw)
  self.assertEqual(transport.recover_release_body(body,len(raw),digest),raw)
  self.assertNotIn('activationUrl',body);self.assertNotIn('abigail@',body)
  maximum=b'x'*16384;self.assertEqual(transport.recover_release_body(transport.release_body(maximum),len(maximum),hashlib.sha256(maximum).hexdigest()),maximum)
  for invalid in [b'',b'x'*16385]:
   with self.assertRaises(ValueError):transport.release_body(invalid)
 def test_release_body_does_not_trust_mutable_body_checksum(self):
  raw=b'ciphertext';digest=hashlib.sha256(raw).hexdigest();body=transport.release_body(raw)
  for altered in [body+' ',body[:-1],body.replace('envelopeBase64','duplicate'),transport.release_body(b'changed')]:
   if altered==body:continue
   with self.assertRaises(ValueError):transport.recover_release_body(altered,len(raw),digest)
  value=json.loads(body);value['envelopeBase64']=base64.b64encode(b'different!').decode()
  with self.assertRaises(ValueError):transport.recover_release_body(json.dumps(value,sort_keys=True,separators=(',',':')),len(raw),digest)
  for size,sha in [(len(raw)+1,digest),(len(raw),'0'*64),(True,digest)]:
   with self.assertRaises(ValueError):transport.recover_release_body(body,size,sha)
 def test_publish_readbacks_and_assets_are_mandatory(self):
  raw=b'encrypted-synthetic-only'
  actual_backup=load('backup_validation','.github/backup/backup_release.py')
  for bad_stage in [None,'draft','patch','final','download']:
   with self.subTest(bad_stage=bad_stage):
    class Api:
     def __init__(self):self.release={};self.bytes={};self.downloads=0;self.patches=0
     def api(self,path,method='GET',data=None):
      if method=='POST':
       self.release={**data,'id':7,'assets':[]};return copy.deepcopy(self.release)
      if method=='PATCH':
       self.patches+=1;self.release.update(data);self.release['published_at']='synthetic'
       result=copy.deepcopy(self.release)
       if bad_stage=='patch':result['body']='altered'
       return result
      result=copy.deepcopy(self.release)
      if bad_stage==('draft' if result['draft'] else 'final'):result['body']='altered'
      return result
     def upload(self,identity,path):
      value=path.read_bytes();identifier=len(self.bytes)+1;self.bytes[identifier]=value
      self.release['assets'].append({'id':identifier,'name':path.name,'size':len(value),'state':'uploaded','content_type':'application/octet-stream','digest':'sha256:'+hashlib.sha256(value).hexdigest()})
     def download(self,identifier,path,size):
      self.downloads+=1;path.write_bytes(self.bytes[identifier] if bad_stage!='download' else b'altered')
    api=Api();fake_host=types.SimpleNamespace(old=types.SimpleNamespace(envelope=mock.Mock(),context=lambda _:contract.context(req)))
    with mock.patch.object(transport,'store_preflight'):
     if bad_stage:
      with self.assertRaises(ValueError):transport.publish(actual_backup,api,{'BACKUP_STORE_SHA':'f'*40},req,raw,fake_host)
     else:
      result=transport.publish(actual_backup,api,{'BACKUP_STORE_SHA':'f'*40},req,raw,fake_host)
      self.assertTrue(result['ok']);self.assertEqual(api.downloads,2)
      self.assertEqual(transport.recover_release_body(api.release['body'],len(raw),hashlib.sha256(raw).hexdigest()),raw)
    fake_host.old.envelope.assert_called_once_with(raw,req)
    if bad_stage in ('draft','download'):self.assertEqual(api.patches,0)
 def test_publish_checks_metadata_and_retains_asset_verification(self):
  source=(ROOT/'ops/administrator-transition-transport.py').read_text()
  self.assertIn("host.old.envelope(raw,request);body=release_body(raw);store_preflight",source)
  self.assertIn("api.download(asset['id'],target,asset['size'])",source)
  self.assertIn("require(backup.digest(target)==expected[asset['name']][1])",source)
  self.assertIn("draft.get('body')==body",source)
  self.assertIn("require(recover_release_body(final['body'],len(raw),digest)==raw)",source)
 def test_context_is_operation_bound(self):
  self.assertEqual(contract.context(req)['operation'],contract.OPERATION)
 def test_workflow_shared_serialization(self):
  text=(ROOT/'.github/workflows/administrator-invitation-transition.yml').read_text()
  for expected in ['workflow_dispatch:','group: bubblewash-production','cancel-in-progress: false','--runner-only','deploymentAccepted','contents: read']:self.assertIn(expected,text)
if __name__=='__main__':unittest.main()
