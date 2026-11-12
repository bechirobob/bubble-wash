"""Exact stopped-only continuation: inspect first, separately approved snapshot/switch/start.
Never replays the update, restores a database, extends access or removes a journal.
"""
import fcntl,hashlib,json,os,pwd,shlex,time,sqlite3,stat,re
import host_files as fs
from pathlib import Path
from code_update_host import WORK,APP,UNIT,ENVIRONMENT,DATABASE,SERVICE,SHARED_LOCK,PREVIOUS,CANDIDATE,EXPIRY,pins,require
from uat_update_engine import Contract,FileJournal
OP='uat-code-only-20261112-final'
ARTIFACT='e9f49bc798ff88caa6c5c50a227aead043e53751e8e8584c9da30f86428bff6e'
SIZE=149974656
RECOVERY=Path('/opt/bubblewash-uat/continue-code-20261112')
RECOVERY_OP='uat-continue-code-20261112-final'
EVENTS=['claimed','enter:inspect','done:inspect','enter:stage','done:stage','enter:stop','done:stop','enter:stopped','uncertain:stopped']
GUARDS=('journal-stopped-only','original-runtime','candidate-retained','environment','unit','stopped-safe','stopped-strict','database-grants','original-commitment','recovery-absent','state-safe','pids-zero','cgroup-path-safe','cgroup-empty','job-empty','listener-empty')

def commitments(path):
 require(path in (DATABASE,RECOVERY/'snapshot.sqlite'))
 wal=Path(str(path)+'-wal');shm=Path(str(path)+'-shm')
 owner=path.stat().st_uid
 for sibling in (wal,shm,Path(str(path)+'-journal')):
  if os.path.lexists(sibling):
   info=sibling.lstat();require(stat.S_ISREG(info.st_mode) and info.st_uid==owner and stat.S_IMODE(info.st_mode)==0o600 and info.st_nlink==1)
   if sibling.name.endswith('-journal'):require(info.st_size==0)
 has_wal=wal.exists() and wal.stat().st_size>0
 require(not has_wal or (shm.exists() and shm.stat().st_size>0))
 db=sqlite3.connect(path.as_uri()+'?mode=ro'+('' if has_wal else '&immutable=1'),uri=True,timeout=2)
 try:
  db.execute('PRAGMA query_only=ON');db.execute('PRAGMA trusted_schema=OFF');db.execute('BEGIN')
  fp=fs.database_fingerprints(db)
  names=[x[0] for x in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
  records={}
  for name in names:
   require(re.fullmatch('[A-Za-z_][A-Za-z0-9_]*',name))
   if name=='driver_live_locations':continue
   rows=db.execute('SELECT * FROM "'+name+'"').fetchall();require(len(rows)<=100000)
   records[name]=hashlib.sha256(fs.canonical(sorted(fs.canonical(list(row)).decode() for row in rows))).hexdigest()
  active=db.execute("SELECT username,starts_at,expires_at FROM staff_uat_accounts WHERE status='active' ORDER BY username").fetchall()
  require(0<len(active)<=20)
  for username,start,end in active:
   version=db.execute('SELECT credential_version FROM staff_uat_accounts WHERE username=?',(username,)).fetchone()[0]
   grant=db.execute('SELECT credential_version,starts_at,original_expires_at,expires_at FROM staff_uat_extensions WHERE username=?',(username,)).fetchone()
   require(start==1793853008095 and end==1794457808095 and grant==(version,start,end,EXPIRY))
  return dict(fp,records=records,expiry=EXPIRY)
 finally:db.close()

def journal(r):
 r.c.trusted(WORK,directory=True,mode=0o700);r.c.trusted(WORK/'journal',directory=True,mode=0o700)
 require(set(os.listdir(WORK))=={'artifact.tar.gz','candidate','journal'})
 require(set(os.listdir(WORK/'journal'))=={'active-operation',OP+'.jsonl'})
 raw=[]
 for name in ('active-operation',OP+'.jsonl'):
  path=WORK/'journal'/name;r.c.trusted(path,mode=0o600);raw.append(r.c.read(path,8192))
 require(raw[0]==(OP+'\n').encode())
 rows=[json.loads(x) for x in raw[1].splitlines()];require(len(rows)==len(EVENTS))
 for i,(row,event) in enumerate(zip(rows,EVENTS)):
  require(set(row)=={'sequence','event','contract'} and type(row['sequence'])is int and row['sequence']==i and row['event']==event)
  require(bool(re.fullmatch('[a-f0-9]{64}',row['contract'])) if i==0 else row['contract']=='')
 return raw,rows[0]['contract']

def stopped(r,checks=None):
 checks={} if checks is None else checks
 raw=r.c.command(['/usr/bin/systemctl','show',SERVICE,'-p','ActiveState','-p','SubState','-p','MainPID','-p','ControlPID','-p','ControlGroup'])
 rows={}
 for line in raw.splitlines():
  k,sep,v=line.partition('=');require(sep and k not in rows);rows[k]=v
 require(set(rows)=={'ActiveState','SubState','MainPID','ControlPID','ControlGroup'})
 checks['state-safe']=(rows['ActiveState'],rows['SubState'])in(('inactive','dead'),('failed','failed'))
 checks['pids-zero']=rows['MainPID']=='0' and rows['ControlPID']=='0'
 checks['cgroup-path-safe']=rows['ControlGroup']in('','/system.slice/bubblewash-uat.service')
 job=r.c.command(['/usr/bin/busctl','--system','get-property','org.freedesktop.systemd1','/org/freedesktop/systemd1/unit/bubblewash_2duat_2eservice','org.freedesktop.systemd1.Unit','Job'])
 checks['job-empty']=shlex.split(job)==['(uo)','0','/']
 checks['cgroup-empty']=True
 for name in ('cgroup.events','cgroup.procs'):
  try:data=r.c.read('/sys/fs/cgroup/system.slice/bubblewash-uat.service/'+name,65536).decode()
  except FileNotFoundError:continue
  checks['cgroup-empty'] &= dict(line.split()for line in data.splitlines()).get('populated')=='0' if name=='cgroup.events' else data.strip()==''
 checks['listener-empty']=r.c.command(['/usr/bin/ss','-H','-ltnp','sport = :3108']).strip()==''
 require(all(checks[k] for k in ('state-safe','pids-zero','cgroup-path-safe','cgroup-empty','job-empty','listener-empty')));r.quiet_sample()
 return rows=={'ActiveState':'inactive','SubState':'dead','MainPID':'0','ControlPID':'0','ControlGroup':''}

def inspect(r,original,candidate):
 from code_update_host import HostAdapter
 result={key:False for key in GUARDS};evidence={}
 def check(key,fn):
  try:evidence[key]=fn();result[key]=True
  except Exception:pass
 pins(original,PREVIOUS);pins(candidate,CANDIDATE)
 check('journal-stopped-only',lambda:journal(r))
 check('original-runtime',lambda:r.p.verify_runtime(APP,UNIT,PREVIOUS,original['runtimeFiles'],original['unitSha256']))
 def staged():
  r.c.trusted(WORK/'artifact.tar.gz',mode=0o600)
  with (WORK/'artifact.tar.gz').open('rb')as f:require(os.fstat(f.fileno()).st_size==SIZE and hashlib.file_digest(f,'sha256').hexdigest()==ARTIFACT)
  return r.p.verify_runtime(WORK/'candidate',UNIT,CANDIDATE,candidate['runtimeFiles'],candidate['unitSha256'])
 check('candidate-retained',staged)
 def environment():
  r.c.trusted(ENVIRONMENT,mode=0o600);raw=r.c.read(ENVIRONMENT,16384)
  configured=r.p.parse_environment(raw)
  require(set(configured)==set(r.p.EXPECTED_ENV)|{'BUBBLEWASH_SESSION_SECRET'})
  require(all(configured[k]==v for k,v in r.p.EXPECTED_ENV.items()))
  require(bool(re.fullmatch('[A-Za-z0-9_-]{64}',configured['BUBBLEWASH_SESSION_SECRET'])))
  return HostAdapter(r,original,candidate,None)._config()
 check('environment',environment)
 check('unit',r.loaded_unit)
 check('stopped-safe',lambda:stopped(r,result));result['stopped-strict']=bool(evidence.get('stopped-safe'))
 def database():
  owner=pwd.getpwnam('bubblewash-uat');require(owner.pw_uid>0 and owner.pw_shell=='/usr/sbin/nologin' and owner.pw_dir==str(DATABASE.parent))
  r.c.trusted(DATABASE.parent,owner=owner.pw_uid,directory=True);r.c.trusted(DATABASE,owner=owner.pw_uid,mode=0o600)
  require(int(time.time()*1000)<EXPIRY-900000)
  return commitments(DATABASE)
 if all(result[k]for k in ('original-runtime','environment','unit','stopped-safe')):check('database-grants',database)
 def commitment():
  d=evidence['database-grants'];c=Contract(OP,PREVIOUS,CANDIDATE,ARTIFACT,evidence['environment'],d['accounts'],d['schema'],EXPIRY)
  require(hashlib.sha256(json.dumps(c.__dict__,sort_keys=True,separators=(',',':')).encode()).hexdigest()==evidence['journal-stopped-only'][1])
 check('original-commitment',commitment)
 result['recovery-absent']=not os.path.lexists(RECOVERY)
 return result,evidence

def run(r,original,candidate,mode):
 require(mode in ('inspect','continue') and os.geteuid()==0)
 r.c.trusted(SHARED_LOCK,mode=0o600);lock=os.open(SHARED_LOCK,os.O_RDONLY|os.O_NOFOLLOW)
 recovery_journal=None;stage='admission';root=None;work=None;deadline=time.monotonic()+540
 try:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  guards,before=inspect(r,original,candidate)
  if mode=='inspect':return {'readOnly':True,'automaticRetry':False,'guards':guards}
  require(all(v for k,v in guards.items()if k!='stopped-strict'))
  production=r.c.production_inventory();require(inspect(r,original,candidate)==(guards,before))
  require(os.statvfs(WORK).f_bavail*os.statvfs(WORK).f_frsize>=8*1024**3)
  owner=pwd.getpwnam('bubblewash-uat').pw_uid
  identity=r.c.trusted(DATABASE,owner=owner,mode=0o600)[:2]
  from code_update_host import HostAdapter
  def stable():
   require(r.c.trusted(DATABASE,owner=owner,mode=0o600)[:2]==identity)
   require(r.loaded_unit()==before['unit'] and r.c.production_inventory()==production)
   require(HostAdapter(r,original,candidate,None)._config()==before['environment'])
   require(journal(r)==before['journal-stopped-only'])
   require(commitments(DATABASE)==before['database-grants'])
  stable();stopped(r)
  root=fs.trusted_directory(RECOVERY.parent);work=fs.private_directory(root,RECOVERY.name)
  j=fs.private_directory(work,'journal');os.close(j)
  d=before['database-grants'];c=Contract(RECOVERY_OP,PREVIOUS,CANDIDATE,ARTIFACT,before['environment'],d['accounts'],d['schema'],EXPIRY)
  recovery_journal=FileJournal(RECOVERY/'journal');recovery_journal.claim(c)
  require(deadline-time.monotonic()>=180)
  stage='snapshot';recovery_journal.record('enter:'+stage)
  stable();stopped(r)
  data=os.open(DATABASE.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try:fs.closed_snapshot(data,DATABASE.name,work,'snapshot.sqlite',d['schema'],d['accounts'])
  finally:os.close(data)
  require(commitments(RECOVERY/'snapshot.sqlite')==d);stable();stopped(r);recovery_journal.record('done:'+stage)
  require(deadline-time.monotonic()>=90)
  stage='switch';recovery_journal.record('enter:'+stage)
  r.p.verify_runtime(APP,UNIT,PREVIOUS,original['runtimeFiles'],original['unitSha256'])
  r.p.verify_runtime(WORK/'candidate',UNIT,CANDIDATE,candidate['runtimeFiles'],candidate['unitSha256'])
  fs.exchange_directories(APP,WORK/'candidate')
  r.p.verify_runtime(APP,UNIT,CANDIDATE,candidate['runtimeFiles'],candidate['unitSha256']);stable();stopped(r);recovery_journal.record('done:'+stage)
  stage='start';recovery_journal.record('enter:'+stage)
  r.t.exchange(['/usr/bin/systemctl','--job-mode=fail','start',SERVICE],b'',timeout=45,limit=4096);recovery_journal.record('done:'+stage)
  stage='postverify';recovery_journal.record('enter:'+stage);deadline=time.monotonic()+30
  while True:
   try:
    after=r.c.collect_restart_isolation(candidate,before_restart=False);r.health();stable()
    require(after['database']=={'device':str(identity[0]),'inode':str(identity[1])})
    recovery_journal.record('done:'+stage)
    return {'readOnly':False,'automaticRetry':False,'state':'candidate-verified','stage':stage}
   except Exception:
    if time.monotonic()>=deadline:raise
    time.sleep(1)
 except Exception:
  if recovery_journal is not None:
   try:recovery_journal.record('uncertain:'+stage)
   except Exception:pass
  return {'readOnly':mode=='inspect','automaticRetry':False,'state':'inspection-required','stage':stage}
 finally:
  if recovery_journal is not None:recovery_journal.close()
  for fd in (work,root,lock):
   if fd is not None:os.close(fd)
