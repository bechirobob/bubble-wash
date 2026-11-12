import json,sqlite3,tempfile,types,unittest,os
from pathlib import Path
from unittest.mock import patch
import code_continue_stopped as g
import code_continue_runner as runner
from uat_update_engine import Refused

class Stopped(unittest.TestCase):
 def fake(self,state='failed',sub='failed',group='/system.slice/bubblewash-uat.service',pop='0',pids='',job='(uo) 0 "/"',listener=''):
  def command(args,**kw):
   if args[0]=='/usr/bin/systemctl':return f'ActiveState={state}\nSubState={sub}\nMainPID=0\nControlPID=0\nControlGroup={group}\n'
   if args[0]=='/usr/bin/busctl':return job
   return listener
  def read(path,*a):return ('populated '+pop+'\nfrozen 0\n' if path.endswith('events')else pids).encode()
  return types.SimpleNamespace(c=types.SimpleNamespace(command=command,read=read),quiet_sample=lambda:None)
 def test_realistic_retained_empty_cgroup_is_stopped_not_running(self):
  checks={};self.assertFalse(g.stopped(self.fake(),checks));self.assertTrue(all(checks.values()))
  self.assertTrue(g.stopped(self.fake(state='inactive',sub='dead',group='')))
  for args in ({'pop':'1'},{'pids':'123\n'},{'state':'active','sub':'running'},{'group':'/other'},{'job':'(uo) 1 "/job"'},{'listener':'LISTEN'}):
   with self.subTest(args=args),self.assertRaises(Refused):g.stopped(self.fake(**args))
 def test_closed_sqlite_no_sidecars_and_grant_binding(self):
  with tempfile.TemporaryDirectory()as d:
   p=Path(d)/'db';db=sqlite3.connect(p)
   db.executescript("CREATE TABLE staff_uat_accounts(username TEXT,status TEXT,starts_at INT,expires_at INT,credential_version TEXT); CREATE TABLE staff_uat_extensions(username TEXT,credential_version TEXT,starts_at INT,original_expires_at INT,expires_at INT);")
   db.execute('INSERT INTO staff_uat_accounts VALUES(?,?,?,?,?)',('synthetic','active',1793853008095,1794457808095,'version'))
   db.execute('INSERT INTO staff_uat_extensions VALUES(?,?,?,?,?)',('synthetic','version',1793853008095,1794457808095,g.EXPIRY));db.commit();db.close();p.chmod(0o600)
   with patch.object(g,'DATABASE',p):
    before=p.read_bytes();self.assertEqual(g.commitments(p)['expiry'],g.EXPIRY);self.assertEqual(p.read_bytes(),before);self.assertEqual(list(Path(d).iterdir()),[p])
    Path(str(p)+'-wal').write_bytes(b'wal');Path(str(p)+'-wal').chmod(0o600)
    with patch.object(g.sqlite3,'connect')as connect,self.assertRaises(Refused):g.commitments(p)
    connect.assert_not_called()
 def test_bootstrap_mode_receipts_and_exact_workflow(self):
  compile(runner.bootstrap(),'synthetic','exec')
  self.assertIn('code_continue_stopped',runner.bootstrap())
  self.assertNotIn('restore_previous',runner.bootstrap())
  runner.validate_receipt(json.dumps({'readOnly':True,'automaticRetry':False,'guards':dict.fromkeys(g.GUARDS,False)}))
  runner.validate_receipt(json.dumps({'readOnly':False,'automaticRetry':False,'state':'candidate-verified','stage':'postverify'}))
  with self.assertRaises(Refused):runner.validate_receipt('{"arbitrary":"secret"}')
  for readOnly,stage in [(True,'postverify'),(False,'snapshot')]:
   with self.assertRaises(Refused):runner.validate_receipt(json.dumps({'readOnly':readOnly,'automaticRetry':False,'state':'candidate-verified','stage':stage}))
 def test_journal_refuses_any_snapshot_or_switch_evidence(self):
  with tempfile.TemporaryDirectory()as d:
   work=Path(d);(work/'journal').mkdir();(work/'candidate').mkdir();(work/'artifact.tar.gz').touch()
   (work/'journal/active-operation').write_text(g.OP+'\n')
   rows=[dict(sequence=i,event=e,contract='a'*64 if i==0 else '')for i,e in enumerate(g.EVENTS)]
   log=work/'journal'/(g.OP+'.jsonl');log.write_text('\n'.join(json.dumps(x)for x in rows))
   r=types.SimpleNamespace(c=types.SimpleNamespace(trusted=lambda *a,**k:None,read=lambda p,*a:Path(p).read_bytes()))
   with patch.object(g,'WORK',work):
    self.assertEqual(g.journal(r)[1],'a'*64)
    rows[-1]['event']='enter:snapshot';log.write_text('\n'.join(json.dumps(x)for x in rows))
    with self.assertRaises(Refused):g.journal(r)

class Continuation(unittest.TestCase):
 def exercise(self,failure=None):
  import code_update_host as host
  calls=[]
  with tempfile.TemporaryDirectory()as directory:
   root=Path(directory);work=root/'retained';work.mkdir();app=root/'app';app.mkdir();candidate=work/'candidate';candidate.mkdir();recovery=root/'recovery';db=root/'db';db.write_bytes(b'unchanged')
   (app/'SOURCE_REVISION').write_text(g.PREVIOUS);(candidate/'SOURCE_REVISION').write_text(g.CANDIDATE)
   baseline={'schema':'a'*64,'accounts':'b'*64,'records':{'synthetic':'c'*64},'expiry':g.EXPIRY}
   before={'database-grants':baseline,'environment':'d'*64,'unit':{'synthetic':True},'journal-stopped-only':([b'marker',b'journal'],'e'*64)}
   guards=dict.fromkeys(g.GUARDS,True);guards['stopped-strict']=False
   lock=root/'lock';lock.touch(mode=0o600);identity=(db.stat().st_dev,db.stat().st_ino)
   def verify(path,unit,revision,*rest):
    self.assertEqual((path/'SOURCE_REVISION').read_text(),revision)
   def exchange(command,*a,**kw):calls.append('start');self.assertEqual(command[2],'start')
   def snapshot(data,name,out,target,*a):
    calls.append('snapshot')
    if failure=='snapshot':raise ValueError('synthetic')
    fd=os.open(target,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600,dir_fd=out);os.write(fd,b'snapshot');os.close(fd)
   r=types.SimpleNamespace(c=types.SimpleNamespace(trusted=lambda *a,**kw:(*identity,),production_inventory=lambda:{'production':'unchanged'},read=lambda path,*a:b'marker'if str(path).endswith('active-operation')else b'journal',collect_restart_isolation=lambda *a,**kw:{'database':{'device':str(identity[0]),'inode':str(identity[1])}}),p=types.SimpleNamespace(verify_runtime=verify),t=types.SimpleNamespace(exchange=exchange),loaded_unit=lambda:before['unit'],health=lambda:None)
   original={'runtimeFiles':{},'unitSha256':'f'*64};target=dict(original)
   with patch.multiple(g,WORK=work,APP=app,RECOVERY=recovery,DATABASE=db,SHARED_LOCK=lock),patch.object(g,'inspect',return_value=(guards,before)),patch.object(g,'journal',return_value=before['journal-stopped-only']),patch.object(g,'commitments',return_value=baseline),patch.object(g,'stopped',return_value=False),patch.object(g.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=os.getuid())),patch.object(host.HostAdapter,'_config',return_value=before['environment']),patch.object(g.fs,'closed_snapshot',side_effect=snapshot),patch.object(g.os,'geteuid',return_value=0),patch.object(g.os,'statvfs',return_value=types.SimpleNamespace(f_bavail=10*1024**3,f_frsize=1)),patch.object(g.fs,'trusted_directory',side_effect=lambda path:os.open(path,os.O_RDONLY|os.O_DIRECTORY)):
    result=g.run(r,original,target,'continue')
    if failure:
     self.assertEqual((app/'SOURCE_REVISION').read_text(),g.PREVIOUS);self.assertNotIn('start',calls);self.assertEqual(result['stage'],'snapshot')
    else:
     self.assertEqual(result['state'],'candidate-verified');self.assertEqual((app/'SOURCE_REVISION').read_text(),g.CANDIDATE);self.assertEqual((candidate/'SOURCE_REVISION').read_text(),g.PREVIOUS);self.assertEqual(calls,['snapshot','start'])
    self.assertEqual(db.read_bytes(),b'unchanged')
    self.assertTrue((recovery/'journal'/'active-operation').exists())
    again=g.run(r,original,target,'continue');self.assertEqual(again['state'],'inspection-required')
 def test_success_retains_previous_application_and_data(self):self.exercise()
 def test_snapshot_failure_never_switches_or_starts(self):self.exercise('snapshot')
