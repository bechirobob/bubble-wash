import hashlib,json,os,shutil,sqlite3,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
import code_snapshot_completion as g
import code_snapshot_runner as runner
from uat_update_engine import Contract,Refused
import host_files as fs

class Snapshot(unittest.TestCase):
 def test_real_closed_and_wal_snapshots_and_inspection(self):
  for wal in (False,True):
   with self.subTest(wal=wal),tempfile.TemporaryDirectory()as directory:
    root=Path(directory);data=root/'data';data.mkdir();rec=root/'recovery';rec.mkdir();src=data/'db';db=sqlite3.connect(src)
    if wal:db.execute('PRAGMA journal_mode=WAL');db.execute('PRAGMA wal_autocheckpoint=0')
    db.executescript("CREATE TABLE staff_uat_accounts(username TEXT,status TEXT,starts_at INT,expires_at INT,credential_version TEXT); CREATE TABLE staff_uat_extensions(username TEXT,credential_version TEXT,starts_at INT,original_expires_at INT,expires_at INT); CREATE TABLE orders(id TEXT,status TEXT); INSERT INTO orders VALUES('synthetic','open');")
    db.execute('INSERT INTO staff_uat_accounts VALUES(?,?,?,?,?)',('synthetic','active',1793853008095,1794457808095,'version'));db.execute('INSERT INTO staff_uat_extensions VALUES(?,?,?,?,?)',('synthetic','version',1793853008095,1794457808095,g.prior.EXPIRY));db.commit()
    if wal:
     for suffix in ('','-wal','-shm'):shutil.copyfile(str(src)+suffix,str(data/'closed')+suffix)
     db.close();src=data/'closed'
    else:db.close()
    for file in data.iterdir():file.chmod(0o600)
    with patch.multiple(g.prior,DATABASE=src,RECOVERY=rec):
     baseline=g.prior.commitments(src);a=os.open(data,os.O_RDONLY|os.O_DIRECTORY);b=os.open(rec,os.O_RDONLY|os.O_DIRECTORY)
     try:fs.closed_snapshot(a,src.name,b,'snapshot.sqlite',baseline['schema'],baseline['accounts'])
     finally:os.close(a);os.close(b)
     self.assertEqual(g.prior.commitments(rec/'snapshot.sqlite'),baseline);self.assertEqual(g.prior.commitments(src),baseline)
     (rec/'journal').mkdir();(rec/'journal/active-operation').write_text(g.prior.RECOVERY_OP+'\n')
     contract=Contract(g.prior.RECOVERY_OP,g.prior.PREVIOUS,g.prior.CANDIDATE,g.prior.ARTIFACT,'d'*64,baseline['accounts'],baseline['schema'],g.prior.EXPIRY)
     digest=hashlib.sha256(json.dumps(contract.__dict__,sort_keys=True,separators=(',',':')).encode()).hexdigest()
     log=rec/'journal'/(g.prior.RECOVERY_OP+'.jsonl');log.write_text('\n'.join(json.dumps(dict(sequence=i,event=e,contract=digest if i==0 else ''))for i,e in enumerate(['claimed','enter:snapshot','uncertain:snapshot'])))
     r=types.SimpleNamespace(c=types.SimpleNamespace(trusted=lambda p,**k:(Path(p).stat().st_ino,),read=lambda p,*a:Path(p).read_bytes()))
     base=dict.fromkeys(g.prior.GUARDS,True);base['stopped-strict']=False;base['recovery-absent']=False
     evidence={'database-grants':baseline,'environment':'d'*64}
     with patch.object(g.prior,'inspect',side_effect=lambda *a:(dict(base),dict(evidence))),patch.object(g,'WORK',root/'completion'):
      result,_=g.diagnose(r,{},{});self.assertTrue(all(v for k,v in result.items()if k not in ('base-stopped-strict','base-recovery-absent')),result)
      snap=sqlite3.connect(rec/'snapshot.sqlite');snap.execute("UPDATE orders SET status='corrupt-copy'");snap.commit();snap.close()
      result,_=g.diagnose(r,{},{});self.assertFalse(result['records-match']);self.assertEqual(g.prior.commitments(src),baseline)
      rows=[json.loads(x)for x in log.read_text().splitlines()];rows[-1]['event']='enter:switch';log.write_text('\n'.join(json.dumps(x)for x in rows))
      result,_=g.diagnose(r,{},{});self.assertFalse(result['recovery-snapshot-only'])
 def test_bootstrap_and_receipt_do_not_call_old_continuation(self):
  code=runner.bootstrap();compile(code,'synthetic','exec');self.assertIn("sys.modules['code_snapshot_completion'].run",code);self.assertNotIn("sys.modules['code_continue_stopped'].run",code)
  runner.validate_receipt(json.dumps({'readOnly':True,'automaticRetry':False,'guards':dict.fromkeys(g.GUARDS,False)}))
  with self.assertRaises(Refused):runner.validate_receipt(json.dumps({'readOnly':False,'automaticRetry':False,'state':'candidate-verified','stage':'switch'}))

class Completion(unittest.TestCase):
 def test_verified_snapshot_completion_never_repeats_backup(self):
  with tempfile.TemporaryDirectory()as directory:
   root=Path(directory);retained=root/'retained';retained.mkdir();rec=root/'recovery';rec.mkdir();app=root/'app';app.mkdir();candidate=retained/'candidate';candidate.mkdir();db=root/'db';db.write_bytes(b'unchanged');snapshot=rec/'snapshot.sqlite';snapshot.write_bytes(b'verified-copy');lock=root/'lock';lock.touch()
   (app/'SOURCE_REVISION').write_text(g.prior.PREVIOUS);(candidate/'SOURCE_REVISION').write_text(g.prior.CANDIDATE)
   baseline={'schema':'a'*64,'accounts':'b'*64,'records':{'synthetic':'c'*64},'expiry':g.prior.EXPIRY};before={'database-grants':baseline,'environment':'d'*64,'unit':{},'journal-stopped-only':([b'marker',b'journal'],'e'*64),'recovery-snapshot-only':([b'recovery',b'log'],'f'*64)};guards=dict.fromkeys(g.GUARDS,True);guards['base-stopped-strict']=False;guards['base-recovery-absent']=False
   identity=(db.stat().st_dev,db.stat().st_ino);calls=[]
   def verify(path,unit,revision,*args):self.assertEqual((path/'SOURCE_REVISION').read_text(),revision)
   r=types.SimpleNamespace(c=types.SimpleNamespace(trusted=lambda *a,**k:identity,production_inventory=lambda:{},collect_restart_isolation=lambda *a,**k:{'database':{'device':str(identity[0]),'inode':str(identity[1])}}),p=types.SimpleNamespace(verify_runtime=verify),t=types.SimpleNamespace(exchange=lambda *a,**k:calls.append('start')),loaded_unit=lambda:{},health=lambda:None)
   pins={'runtimeFiles':{},'unitSha256':'f'*64}
   with patch.multiple(g.prior,WORK=retained,RECOVERY=rec,APP=app,DATABASE=db,SHARED_LOCK=lock),patch.object(g,'WORK',root/'completion'),patch.object(g,'diagnose',side_effect=lambda *a:(dict(guards),dict(before))),patch.object(g,'retained',return_value=before['recovery-snapshot-only']),patch.object(g.prior,'journal',return_value=before['journal-stopped-only']),patch.object(g.prior,'commitments',return_value=baseline),patch.object(g.prior,'stopped',return_value=False),patch.object(g.prior.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=os.getuid())),patch.object(g.HostAdapter,'_config',return_value='d'*64),patch.object(g.os,'geteuid',return_value=0),patch.object(g,'trusted_directory',side_effect=lambda p:os.open(p,os.O_RDONLY|os.O_DIRECTORY)),patch.object(fs,'trusted_directory',side_effect=lambda p:os.open(p,os.O_RDONLY|os.O_DIRECTORY)),patch.object(fs,'closed_snapshot',side_effect=AssertionError('backup must not repeat')):
    result=g.run(r,pins,pins,'complete');self.assertEqual(result['state'],'candidate-verified');self.assertEqual(calls,['start']);self.assertEqual(db.read_bytes(),b'unchanged');self.assertEqual(snapshot.read_bytes(),b'verified-copy');self.assertEqual((app/'SOURCE_REVISION').read_text(),g.prior.CANDIDATE);self.assertEqual((candidate/'SOURCE_REVISION').read_text(),g.prior.PREVIOUS)
    self.assertEqual(g.run(r,pins,pins,'complete')['state'],'inspection-required');self.assertEqual(calls,['start'])
