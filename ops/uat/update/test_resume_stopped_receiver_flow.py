import io,hashlib,os,tempfile,time,types,unittest
from pathlib import Path
from unittest.mock import Mock,patch
import resume_stopped_receiver as m
from live_host_adapter import PIN_NAMES
class Tests(unittest.TestCase):
 def run_case(self,fail=None):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);old=root/'old';old.mkdir();(old/'host.lock').touch();db=root/'uat.sqlite';db.touch();work=root/'resume'
   original={'runtimeRevision':m.admission.REVISION,'runtimeFiles':{k:'a'*64 for k in PIN_NAMES},'unitSha256':'b'*64};candidate={**original,'runtimeRevision':'c'*40}
   raw=b'synthetic';request=dict(operationId='synthetic-approved-resume',candidateRevision='c'*40,artifactSha256=hashlib.sha256(raw).hexdigest(),artifactSize=len(raw),interruptionApproved=True,quietWindowCoordinated=True,adminRouteApproved=True,expectedExpiryMs=m.OLD_EXPIRY)
   baseline=dict(schema='d'*64,accounts='e'*64,records={'staff_uat_accounts':'accounts','staff_uat_audit':'audit'},active=[('synthetic',m.OLD_EXPIRY-604800000,m.OLD_EXPIRY)])
   extended={**baseline,'schema':'f'*64,'records':{**baseline['records'],'staff_uat_audit':'newaudit','staff_uat_extensions':'grant'}}
   state={'extended':False};calls=[]
   def commitments(path):return baseline if path.name=='snapshot.sqlite' or not state['extended'] else extended
   def snapshot(*args):
    calls.append('snapshot')
    if fail=='snapshot':raise ValueError('private')
   def extend(*args):
    calls.append('extension')
    if fail=='extension':raise ValueError('private')
    state['extended']=True
   def exchange(*args):
    calls.append('switch')
    if fail=='switch':raise ValueError('private')
   def start(*args,**kw):
    calls.append('start')
    if fail=='start':raise TimeoutError()
   r=types.SimpleNamespace(c=types.SimpleNamespace(trusted=Mock(return_value=(1,2)),production_inventory=Mock(return_value=[]),command=Mock(return_value='v22.1.0'),read=Mock(return_value=b'MemAvailable: 2097152 kB\n'),collect_restart_isolation=Mock(return_value={'database':{'device':'1','inode':'2'},'productionPaths':[]})),p=types.SimpleNamespace(verify_runtime=Mock()),loaded_unit=Mock(return_value='unit'),t=types.SimpleNamespace(exchange=Mock(side_effect=start)),health=Mock())
   if fail=='postverify':r.health.side_effect=ValueError('private')
   patches=[patch.object(m,'WORK',work),patch.object(m,'DATABASE',db),patch.object(m.admission,'WORK',old),patch.object(m.admission,'_retained',return_value='retained'),patch.object(m.admission,'_original',return_value='unit'),patch.object(m.admission,'_stopped'),patch.object(m,'config',return_value='f'*64),patch.object(m,'commitments',side_effect=commitments),patch.object(m,'extend_offline',side_effect=extend),patch.object(m.fs,'trusted_directory',side_effect=lambda p:os.open(p,os.O_RDONLY|os.O_DIRECTORY)),patch.object(m.fs,'extract_archive',side_effect=lambda *args:calls.append('stage')),patch.object(m.fs,'closed_snapshot',side_effect=snapshot),patch.object(m.fs,'exchange_directories',side_effect=exchange),patch.object(m.os,'geteuid',return_value=0),patch.object(m.os,'statvfs',return_value=types.SimpleNamespace(f_bavail=20,f_frsize=1024**3)),patch.object(m.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=1,pw_gid=1,pw_shell='/usr/sbin/nologin',pw_dir=str(root))),patch.object(m.time,'time',return_value=m.OLD_EXPIRY/1000-3600)]
   # Make postverify failure bounded with synthetic clock, no actual waits.
   if fail=='postverify':patches.extend([patch.object(m.time,'monotonic',side_effect=[0,0,100]),patch.object(m.time,'sleep')])
   for p in patches:p.start()
   try:receipt=m.receive(io.BytesIO(raw),request,r,original,candidate,1000000000)
   finally:
    for p in reversed(patches):p.stop()
   return receipt,calls,state['extended'],list((work/'journal').iterdir()) if (work/'journal').exists() else []
 def test_success_order_snapshot_before_extension_and_switch(self):
  r,calls,extended,_=self.run_case();self.assertEqual(r['state'],'verified');self.assertEqual(calls,['stage','stage','snapshot','extension','switch','start']);self.assertTrue(extended)
 def test_snapshot_failure_no_extension_switch_start(self):
  r,calls,extended,_=self.run_case('snapshot');self.assertEqual(r['stage'],'snapshot');self.assertFalse(extended);self.assertNotIn('start',calls)
 def test_extension_failure_no_switch_or_start(self):
  r,calls,_,_=self.run_case('extension');self.assertEqual(r['stage'],'extension');self.assertNotIn('switch',calls);self.assertNotIn('start',calls)
 def test_switch_failure_no_auto_start_rollback(self):
  r,calls,extended,_=self.run_case('switch');self.assertEqual(r['stage'],'switch');self.assertTrue(extended);self.assertNotIn('start',calls);self.assertEqual(calls.count('switch'),1)
 def test_start_failure_no_retry(self):
  r,calls,_,_=self.run_case('start');self.assertEqual(r['stage'],'start');self.assertEqual(calls.count('start'),1)
 def test_postcheck_failure_no_retry_or_rollback(self):
  r,calls,_,_=self.run_case('postverify');self.assertEqual(r['state'],'inspection-required');self.assertEqual(r['stage'],'postverify');self.assertEqual(calls.count('start'),1)
