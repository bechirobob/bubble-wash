"""Fixed-path read-only inspection of the stopped resume snapshot. No retries."""
import json,os,sqlite3,stat
import resume_stopped_receiver as resume
import stopped_resume_guards as admission
OP='uat-resume-20261111-8bd37b0-01'
REVISION='8bd37b028b550967f9a3eefcd60a52cbcb4f2da9'
GUARDS=('original-runtime','unit-stopped','original-record-retained','resume-private','resume-layout','resume-journal-snapshot-only','candidate-exact','compatible-rollback-exact','snapshot-present','snapshot-private','snapshot-nonempty','snapshot-integrity','live-readable','original-expiry','extension-absent','snapshot-readable','snapshot-schema-matches','snapshot-accounts-match','snapshot-records-match','production-isolated')

def diagnose(r,original,candidate):
 result={k:False for k in GUARDS}
 def check(k,f):
  try:result[k]=f() is True
  except Exception:pass
 check('original-runtime',lambda: isinstance(admission._original(r,original),dict))
 check('unit-stopped',lambda: admission._stopped(r) is None)
 check('original-record-retained',lambda: bool(admission._retained(r)))
 work=resume.WORK;snapshot=work/'snapshot.sqlite'
 check('resume-private',lambda: bool(r.c.trusted(work,directory=True,mode=0o700)))
 if not result['resume-private']:return {'readOnly':True,'automaticRetry':False,'guards':result}
 check('resume-layout',lambda: set(os.listdir(work)) <= {'artifact.tar.gz','candidate','compatible-rollback','journal','snapshot.sqlite','snapshot.sqlite-wal','snapshot.sqlite-shm','snapshot.sqlite-journal'})
 def journal():
  r.c.trusted(work/'journal',directory=True,mode=0o700)
  assert set(os.listdir(work/'journal'))=={'active-operation',OP+'.jsonl'}
  for p in (work/'journal/active-operation',work/'journal'/(OP+'.jsonl')):r.c.trusted(p,mode=0o600)
  assert r.c.read(work/'journal/active-operation',8192)==(OP+'\n').encode()
  rows=[json.loads(line) for line in r.c.read(work/'journal'/(OP+'.jsonl'),8192).splitlines()]
  assert [row['event'] for row in rows]==['claimed','enter:artifact','done:artifact','enter:stage','done:stage','enter:snapshot','uncertain:snapshot']
  return True
 check('resume-journal-snapshot-only',journal)
 for key,name in (('candidate-exact','candidate'),('compatible-rollback-exact','compatible-rollback')):
  check(key,lambda name=name: bool(r.p.verify_runtime(work/name,resume.UNIT,REVISION,candidate['runtimeFiles'],candidate['unitSha256'])))
 check('snapshot-present',lambda: os.path.lexists(snapshot))
 check('snapshot-private',lambda: bool(r.c.trusted(snapshot,mode=0o600)))
 check('snapshot-nonempty',lambda: snapshot.lstat().st_size>0)
 def integrity():
  if not result['snapshot-private']:return False
  # Snapshot must not require recovery or create sidecars.
  if any(os.path.lexists(str(snapshot)+s) for s in ('-wal','-shm','-journal')):return False
  db=sqlite3.connect(snapshot.as_uri()+'?mode=ro&immutable=1',uri=True,timeout=2)
  try:return db.execute('PRAGMA integrity_check').fetchone()==('ok',)
  finally:db.close()
 check('snapshot-integrity',integrity)
 if result['original-runtime'] and result['unit-stopped'] and result['original-record-retained'] and result['resume-journal-snapshot-only']:
  try:
   owner=resume.pwd.getpwnam('bubblewash-uat').pw_uid
   r.c.trusted(resume.DATABASE.parent,owner=owner,directory=True);identity=r.c.trusted(resume.DATABASE,owner=owner,mode=0o600)
   production=r.c.production_inventory()
   result['production-isolated']=all(not os.path.exists(p) or (os.stat(p).st_dev,os.stat(p).st_ino)!=identity[:2] for p in production)
   if not result['production-isolated']:raise ValueError('isolation')
   live=resume.commitments(resume.DATABASE);result['live-readable']=True
   result['original-expiry']=all(start==resume.OLD_EXPIRY-604800000 and end==resume.OLD_EXPIRY for _,start,end in live['active'])
   result['extension-absent']='staff_uat_extensions' not in live['records']
   if result['snapshot-integrity']:
    copy=resume.commitments(snapshot);result['snapshot-readable']=True
    result['snapshot-schema-matches']=copy['schema']==live['schema'];result['snapshot-accounts-match']=copy['accounts']==live['accounts'];result['snapshot-records-match']=copy['records']==live['records']
  except Exception:pass
 return {'readOnly':True,'automaticRetry':False,'guards':result}
