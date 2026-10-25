import contextlib
import hashlib
import importlib.util
import json
import os
import signal
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
m=load('recovery',Path(__file__).resolve().parents[1]/'ops/restore-original-service.py')
e=m

class RecoveryTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
  self.uid=os.getuid();self.calls=[];self.fail_start=False;self.fail_ready=False;self.fail_fsync=False;self.change_db=False;self.interrupt_start=False
  self.state=self.root/'state';self.state.mkdir();self.runtime=self.root/'runtime';self.runtime.mkdir()
  self.old=self.root/'old';self.old.mkdir();(self.old/'.release-sha').write_text('a'*40)
  self.current=self.root/'current';self.current.symlink_to(self.old)
  self.env=self.root/'env';self.env.write_bytes(b'configuration');self.receipt=self.root/'receipt';self.receipt.write_bytes(b'{}')
  self.db=self.root/'db.sqlite'
  for suffix in ('','-wal','-shm'):
   p=Path(str(self.db)+suffix);p.write_bytes(b'original');p.chmod(0o600)
  self.plan={'old':str(self.old),'oldSha':'a'*40,'candidate':str(self.root/'candidate'),'fallback':str(self.root/'fallback'),
    'database':str(self.db),'databaseIdentity':(self.db.stat().st_dev,self.db.stat().st_ino),'snapshot':str(self.runtime/'snapshot.sqlite'),
    'guards':{'envSha256':m.digest(self.env.read_bytes()),'database':str(self.db)},'hostAcceptance':{'riskApprovalSha256':'c'*64}}
  (self.runtime/'current-release').write_text('sha='+('a'*40)+'\nrelease=old\npath='+str(self.old)+'\n')
  self.request={'action':'restore-original','runId':'123','operatorReviewReference':'b'*64,'riskApprovalSha256':'c'*64,'backup':dict(m.BACKUP)}
  self.durable=types.SimpleNamespace(journal=self.state/'transition.json',app_hold=self.state/'app-hold',maintenance_hold=self.state/'maintenance-hold',check=lambda:None)
  self.durable.app_hold.write_bytes(b'held\n');self.durable.maintenance_hold.write_bytes(b'held\n')
  outer=self
  class Host:
   def __init__(self,*a):self.uid=outer.uid
   def inventory(self):return {'units':'fixed'}
   def feature(self,db,mode):
    outer.calls.append(('preflight',mode))
    if outer.change_db:Path(db).write_bytes(b'changed')
    return json.dumps({'ok':True,'status':'exact-pre-migration-ready','databaseChanged':False})
   def acknowledgement(self,raw,expected):m.require(json.loads(raw)==expected)
   def service(self,manager,action,unit):
    outer.calls.append(('service',action))
    if action=='start' and outer.fail_start:raise ValueError('private')
    if action=='start' and outer.interrupt_start:signal.raise_signal(signal.SIGTERM)
   def readiness(self,old):
    outer.calls.append(('readiness',))
    if outer.fail_ready:raise ValueError('private')
    return True
  class Guard:
   def __init__(self,*args):outer.calls.append(('guard',args[3]))
   @contextlib.contextmanager
   def locked(self):
    outer.calls.append(('lock',));yield lambda:True
  def fsync(path):
   if self.fail_fsync and path==self.state and not self.durable.app_hold.exists():raise OSError('private')
  self.adapter=types.SimpleNamespace(validate_plan=lambda plan:True,Host=Host,ENV=self.env,RECEIPT=self.receipt,RUNTIME=self.runtime,CURRENT=self.current,object_digest=lambda obj:m.digest(json.dumps(obj).encode()))
  self.c=types.SimpleNamespace(DurableState=lambda path:self.durable,HostGuards=Guard,fsync_dir=fsync,atomic_write=lambda path,raw:path.write_bytes(raw),core=types.SimpleNamespace(APP='bubblewash-local.service'))
  self.prepare=types.SimpleNamespace(source_files=lambda *a:{'source':'same'},git_tree=lambda files:'tree')
  self.stack=contextlib.ExitStack();self.addCleanup(self.stack.close)
  self.stack.enter_context(patch.object(m,'STATE',self.state));self.stack.enter_context(patch.object(m,'quiet',lambda *a:None));self.stack.enter_context(patch.object(m,'verify_units',lambda *a:None))
  self.stack.enter_context(patch.dict(sys.modules,{'contracts':types.SimpleNamespace(LIVE_TREE='tree',RESIDUAL_ASSUMPTION_SHA256='e'*64)}))
  read=m.read
  self.stack.enter_context(patch.object(m,'read',lambda path,owner=0,limit=16*1024**2:b'machine' if str(path)=='/etc/machine-id' else read(path,self.uid,limit)))
  old_stat=Path.stat
  def root_audit(path,*a,**kw):
   value=old_stat(path,*a,**kw)
   if path.name=='original-recovery':fields=list(value);fields[4]=0;return os.stat_result(fields)
   return value
  self.stack.enter_context(patch.object(Path,'stat',root_audit))
 def run_recovery(self):return m.recover(self.request,self.plan,self.adapter,self.c,self.prepare)
 def test_inspect_never_releases_or_starts(self):
  self.request['action']='inspect';result=self.run_recovery();self.assertTrue(result['ok']);self.assertTrue(self.durable.app_hold.exists());self.assertFalse(any(x[0]=='service' for x in self.calls))
 def test_restore_starts_only_original_preserves_maintenance_and_plan(self):
  before=json.dumps(self.plan,sort_keys=True);result=self.run_recovery();self.assertTrue(result['ok'],result)
  self.assertFalse(self.durable.app_hold.exists());self.assertEqual(self.durable.maintenance_hold.read_bytes(),b'held\n')
  self.assertEqual(before,json.dumps(self.plan,sort_keys=True));self.assertEqual([x for x in self.calls if x[0]=='service'],[('service','start')])
 def test_journal_or_snapshot_prevents_start(self):
  self.durable.journal.write_bytes(b'anything');result=self.run_recovery();self.assertFalse(result['ok']);self.assertTrue(self.durable.app_hold.exists());self.assertFalse(any(x[0]=='service' for x in self.calls))
 def test_preflight_byte_change_refuses_start(self):
  self.change_db=True;result=self.run_recovery();self.assertFalse(result['ok']);self.assertTrue(self.durable.app_hold.exists());self.assertFalse(any(x[0]=='service' for x in self.calls))
 def test_start_failure_reholds_and_stops(self):
  self.fail_start=True;result=self.run_recovery();self.assertFalse(result['ok']);self.assertTrue(result['appHoldRestored']);self.assertEqual(self.durable.app_hold.read_bytes(),b'held\n');self.assertIn(('service','stop'),self.calls)
 def test_post_unlink_fsync_failure_reholds_before_exit(self):
  self.fail_fsync=True;result=self.run_recovery();self.assertFalse(result['ok']);self.assertTrue(self.durable.app_hold.exists());self.assertNotIn(('service','start'),self.calls);self.assertIn(('service','stop'),self.calls)
 def test_readiness_failure_reholds_and_stops(self):
  self.fail_ready=True;result=self.run_recovery();self.assertFalse(result['ok']);self.assertTrue(self.durable.app_hold.exists());self.assertIn(('service','stop'),self.calls)
 def test_sigterm_during_start_reholds_and_stops(self):
  self.interrupt_start=True;before=signal.getsignal(signal.SIGTERM)
  with patch.object(m.os,'geteuid',return_value=0),patch.object(m,'load_original',return_value=(self.plan,self.adapter,self.c,self.prepare)),contextlib.redirect_stdout(__import__('io').StringIO()):
   result=m.main(self.request,b'unused synthetic source')
  self.assertFalse(result['ok']);self.assertTrue(self.durable.app_hold.exists());self.assertIn(('service','stop'),self.calls)
  self.assertEqual(signal.getsignal(signal.SIGTERM),before)
 def test_wrong_backup_risk_or_action_refused(self):
  for field,value in [('action','execute'),('riskApprovalSha256','d'*64),('backup',{})]:
   request={**self.request,field:value}
   with self.assertRaises(ValueError):m.validate_request(request,self.plan)
 def test_emitter_rejects_unpinned_source_or_implicit_action(self):
  with self.assertRaises(ValueError):e.emit('restore-original',self.request,b'code',b'wrong')
  with self.assertRaises(ValueError):e.emit('inspect',self.request,b'code',b'wrong')

if __name__=='__main__':unittest.main()
