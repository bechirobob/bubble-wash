import hashlib,os,tempfile,types,unittest,inspect
from pathlib import Path
from unittest.mock import Mock,patch
from contextlib import ExitStack
import complete_snapshot_receiver as m
class CompletionTests(unittest.TestCase):
 def case(self,fail=None):
  with tempfile.TemporaryDirectory() as tmp,ExitStack() as stack:
   root=Path(tmp);old=root/'old';old.mkdir();(old/'host.lock').touch();prior=root/'prior';prior.mkdir();raw=b'fixture';(prior/'artifact.tar.gz').write_bytes(raw);db=root/'uat.sqlite';db.touch();work=root/'complete'
   original=dict(runtimeRevision='a'*40,runtimeFiles={},unitSha256='b'*64);candidate={**original,'runtimeRevision':m.diagnostic.REVISION}
   base=dict(schema='c'*64,accounts='d'*64,active=[('fixture',m.prior.OLD_EXPIRY-604800000,m.prior.OLD_EXPIRY)],records={'staff_uat_accounts':'a','staff_uat_audit':'b'})
   extended={**base,'records':{**base['records'],'staff_uat_audit':'changed','staff_uat_extensions':'grant'}}
   calls=[];state={'extended':False}
   def commitments(p):
    if fail=='mismatch' and p.name=='snapshot.sqlite':return {**base,'schema':'wrong'}
    return extended if p==db and state['extended'] else base
   def action(name):
    def do(*a,**k):
     calls.append(name)
     if fail==name:raise ValueError('private-details')
     if name=='extension':state['extended']=True
    return do
   r=types.SimpleNamespace(c=types.SimpleNamespace(trusted=Mock(return_value=(1,2)),read=Mock(return_value=b'retained'),production_inventory=Mock(return_value=[]),collect_restart_isolation=Mock(return_value={'database':{'device':'1','inode':'2'},'productionPaths':[]})),loaded_unit=Mock(return_value='unit'),p=types.SimpleNamespace(verify_runtime=Mock()),t=types.SimpleNamespace(exchange=Mock(side_effect=action('start'))),health=Mock())
   diagnose=Mock(return_value={'readOnly':True,'guards':{k:True for k in m.diagnostic.GUARDS}})
   if fail=='admission':diagnose.return_value['guards']['unit-stopped']=False
   if fail=='revalidation':diagnose.side_effect=[diagnose.return_value,{'readOnly':True,'guards':{'stopped':False}}]
   patches=[patch.object(m,'WORK',work),patch.object(m,'ARTIFACT_SHA',hashlib.sha256(raw).hexdigest()),patch.object(m,'ARTIFACT_SIZE',len(raw)),patch.object(m.prior,'WORK',prior),patch.object(m.prior,'DATABASE',db),patch.object(m.admission,'WORK',old),patch.object(m.admission,'_retained',return_value='old'),patch.object(m.admission,'_stopped'),patch.object(m.prior,'config',return_value='e'*64),patch.object(m.prior,'commitments',side_effect=commitments),patch.object(m.prior,'extend_offline',side_effect=action('extension')),patch.object(m.diagnostic,'diagnose',diagnose),patch.object(m.prior.fs,'trusted_directory',side_effect=lambda p:os.open(p,os.O_RDONLY|os.O_DIRECTORY)),patch.object(m.prior.fs,'exchange_directories',side_effect=action('switch')),patch.object(m.prior.fs,'closed_snapshot',side_effect=AssertionError('must not recreate snapshot')),patch.object(m.os,'geteuid',return_value=0),patch.object(m.prior.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=1,pw_gid=1,pw_dir=str(root),pw_shell='/usr/sbin/nologin')),patch.object(m.time,'time',return_value=m.prior.OLD_EXPIRY/1000-3600),patch.object(m.time,'monotonic',return_value=100)]
   for p in patches:stack.enter_context(p)
   if fail=='expired':m.time.time.return_value=m.prior.OLD_EXPIRY/1000
   kwargs={'execution_deadline':150 if fail=='budget' else 1000} if 'execution_deadline' in inspect.signature(m.complete).parameters else {}
   result=m.complete(r,original,candidate,**kwargs)
   events=[]
   if (work/'journal'/(m.OP+'.jsonl')).exists():
    import json
    events=[json.loads(x)['event'] for x in (work/'journal'/(m.OP+'.jsonl')).read_text().splitlines()]
   return result,calls,events
 def test_success_no_snapshot_recreation(self):
  result,calls,events=self.case();self.assertEqual(result['state'],'verified');self.assertEqual(calls,['extension','switch','start']);self.assertEqual(events[-1],'done:postverify')
 def test_failed_admission_no_mutation(self):self.assertEqual(self.case('admission')[1],[])
 def test_changed_snapshot_no_mutation(self):self.assertEqual(self.case('mismatch')[1],[])
 def test_failed_revalidation_no_mutation(self):self.assertEqual(self.case('revalidation')[1],[])
 def test_expired_admission_no_mutation(self):self.assertEqual(self.case('expired')[1],[])
 def test_extension_failure_no_switch(self):
  r,c,e=self.case('extension');self.assertEqual(c,['extension']);self.assertEqual(e[-1],'uncertain:extension')
 def test_switch_failure_no_start_or_rollback(self):
  r,c,e=self.case('switch');self.assertEqual(c,['extension','switch']);self.assertEqual(e[-1],'uncertain:switch')
 def test_start_failure_no_retry(self):
  r,c,e=self.case('start');self.assertEqual(c,['extension','switch','start']);self.assertEqual(e[-1],'uncertain:start')
 def test_insufficient_monotonic_budget_no_mutation(self):
  self.assertIn('execution_deadline',inspect.signature(m.complete).parameters);self.assertEqual(self.case('budget')[1],[])
