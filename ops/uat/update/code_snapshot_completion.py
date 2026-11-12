"""Inspect a retained snapshot; complete only an exact, proven snapshot-only stop."""
import fcntl,hashlib,json,os,sqlite3,time
from pathlib import Path
import code_continue_stopped as prior
from code_update_host import HostAdapter
from uat_update_engine import Contract,FileJournal
from host_files import trusted_directory,private_directory,exchange_directories
require=prior.require
WORK=Path('/opt/bubblewash-uat/complete-code-snapshot-20261112')
OP='uat-complete-code-snapshot-20261112'
GUARDS=tuple('base-'+k for k in prior.GUARDS)+('recovery-private','recovery-layout','recovery-snapshot-only','snapshot-present','snapshot-private','snapshot-nonempty','snapshot-no-sidecars','snapshot-integrity','snapshot-readable','schema-match','accounts-match','records-match','expiry-match','completion-absent')

def retained(r):
 work=prior.RECOVERY;r.c.trusted(work,directory=True,mode=0o700);r.c.trusted(work/'journal',directory=True,mode=0o700)
 require(set(os.listdir(work))=={'journal','snapshot.sqlite'})
 require(set(os.listdir(work/'journal'))=={'active-operation',prior.RECOVERY_OP+'.jsonl'})
 raw=[]
 for name in ('active-operation',prior.RECOVERY_OP+'.jsonl'):
  path=work/'journal'/name;r.c.trusted(path,mode=0o600);raw.append(r.c.read(path,8192))
 require(raw[0]==(prior.RECOVERY_OP+'\n').encode())
 rows=[json.loads(x)for x in raw[1].splitlines()];events=['claimed','enter:snapshot','uncertain:snapshot'];require(len(rows)==len(events))
 for i,(row,event)in enumerate(zip(rows,events)):
  require(set(row)=={'sequence','event','contract'} and type(row['sequence'])is int and row['sequence']==i and row['event']==event)
  require(bool(prior.re.fullmatch('[a-f0-9]{64}',row['contract'])) if i==0 else row['contract']=='')
 return raw,rows[0]['contract']

def diagnose(r,original,candidate):
 base,evidence=prior.inspect(r,original,candidate);guards={key:False for key in GUARDS};guards.update({'base-'+k:v for k,v in base.items()})
 def check(k,fn):
  try:evidence[k]=fn();guards[k]=True
  except Exception:pass
 work=prior.RECOVERY;snapshot=work/'snapshot.sqlite'
 check('recovery-private',lambda:r.c.trusted(work,directory=True,mode=0o700))
 if not guards['recovery-private']:return guards,evidence
 check('recovery-layout',lambda:require(set(os.listdir(work))<={'journal','snapshot.sqlite','snapshot.sqlite-wal','snapshot.sqlite-shm','snapshot.sqlite-journal'}))
 check('recovery-snapshot-only',lambda:retained(r))
 check('snapshot-present',lambda:require(os.path.lexists(snapshot)))
 check('snapshot-private',lambda:r.c.trusted(snapshot,mode=0o600))
 check('snapshot-nonempty',lambda:require(snapshot.lstat().st_size>0))
 check('snapshot-no-sidecars',lambda:require(not any(os.path.lexists(str(snapshot)+x)for x in ('-wal','-shm','-journal'))))
 def integrity():
  require(all(guards[k]for k in ('snapshot-private','snapshot-nonempty','snapshot-no-sidecars')))
  db=sqlite3.connect(snapshot.as_uri()+'?mode=ro&immutable=1',uri=True,timeout=2)
  try:require(db.execute('PRAGMA integrity_check').fetchone()==('ok',))
  finally:db.close()
 check('snapshot-integrity',integrity)
 if guards['snapshot-integrity'] and guards['base-database-grants']:
  check('snapshot-readable',lambda:prior.commitments(snapshot))
  if guards['snapshot-readable']:
   for name,key in (('schema-match','schema'),('accounts-match','accounts'),('records-match','records'),('expiry-match','expiry')):guards[name]=evidence['snapshot-readable'][key]==evidence['database-grants'][key]
   # Bind the failed continuation's original claim, not only its event names.
   if guards['recovery-snapshot-only']:
    d=evidence['database-grants'];c=Contract(prior.RECOVERY_OP,prior.PREVIOUS,prior.CANDIDATE,prior.ARTIFACT,evidence['environment'],d['accounts'],d['schema'],prior.EXPIRY)
    guards['recovery-snapshot-only']=hashlib.sha256(json.dumps(c.__dict__,sort_keys=True,separators=(',',':')).encode()).hexdigest()==evidence['recovery-snapshot-only'][1]
 guards['completion-absent']=not os.path.lexists(WORK)
 return guards,evidence

def run(r,original,candidate,mode):
 require(mode in ('inspect','complete') and os.geteuid()==0)
 r.c.trusted(prior.SHARED_LOCK,mode=0o600);lock=os.open(prior.SHARED_LOCK,os.O_RDONLY|os.O_NOFOLLOW)
 journal=None;root=None;work=None;stage='admission';deadline=time.monotonic()+540
 try:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  guards,before=diagnose(r,original,candidate)
  if mode=='inspect':return {'readOnly':True,'automaticRetry':False,'guards':guards}
  require(all(v for k,v in guards.items()if k not in ('base-stopped-strict','base-recovery-absent')))
  production=r.c.production_inventory();owner=prior.pwd.getpwnam('bubblewash-uat').pw_uid;identity=r.c.trusted(prior.DATABASE,owner=owner,mode=0o600)[:2]
  snapshot=prior.RECOVERY/'snapshot.sqlite';snapshot_id=r.c.trusted(snapshot,mode=0o600)
  def stable():
   require(r.c.trusted(prior.DATABASE,owner=owner,mode=0o600)[:2]==identity)
   require(r.c.trusted(snapshot,mode=0o600)==snapshot_id and prior.commitments(snapshot)==before['database-grants'])
   require(prior.commitments(prior.DATABASE)==before['database-grants'])
   require(prior.journal(r)==before['journal-stopped-only'] and retained(r)==before['recovery-snapshot-only'])
   require(r.loaded_unit()==before['unit'] and r.c.production_inventory()==production)
   require(HostAdapter(r,original,candidate,None)._config()==before['environment'])
  stable();prior.stopped(r);require(diagnose(r,original,candidate)==(guards,before))
  require(deadline-time.monotonic()>=180)
  root=trusted_directory(WORK.parent);work=private_directory(root,WORK.name);j=private_directory(work,'journal');os.close(j)
  d=before['database-grants'];contract=Contract(OP,prior.PREVIOUS,prior.CANDIDATE,prior.ARTIFACT,before['environment'],d['accounts'],d['schema'],prior.EXPIRY)
  journal=FileJournal(WORK/'journal');journal.claim(contract)
  stage='switch';journal.record('enter:'+stage);stable();prior.stopped(r)
  r.p.verify_runtime(prior.APP,prior.UNIT,prior.PREVIOUS,original['runtimeFiles'],original['unitSha256'])
  r.p.verify_runtime(prior.WORK/'candidate',prior.UNIT,prior.CANDIDATE,candidate['runtimeFiles'],candidate['unitSha256'])
  exchange_directories(prior.APP,prior.WORK/'candidate')
  r.p.verify_runtime(prior.APP,prior.UNIT,prior.CANDIDATE,candidate['runtimeFiles'],candidate['unitSha256']);stable();prior.stopped(r);journal.record('done:'+stage)
  stage='start';journal.record('enter:'+stage)
  r.t.exchange(['/usr/bin/systemctl','--job-mode=fail','start',prior.SERVICE],b'',timeout=45,limit=4096);journal.record('done:'+stage)
  stage='postverify';journal.record('enter:'+stage);finish=time.monotonic()+30
  while True:
   try:
    after=r.c.collect_restart_isolation(candidate,before_restart=False);r.health();stable();require(after['database']=={'device':str(identity[0]),'inode':str(identity[1])});journal.record('done:'+stage)
    return {'readOnly':False,'automaticRetry':False,'state':'candidate-verified','stage':stage}
   except Exception:
    if time.monotonic()>=finish:raise
    time.sleep(1)
 except Exception:
  if journal is not None:
   try:journal.record('uncertain:'+stage)
   except Exception:pass
  return {'readOnly':mode=='inspect','automaticRetry':False,'state':'inspection-required','stage':stage}
 finally:
  if journal is not None:journal.close()
  for fd in (work,root,lock):
   if fd is not None:os.close(fd)
