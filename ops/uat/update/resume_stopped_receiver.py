"""One stopped-state continuation: protected snapshot, approved grants, new code.
No old-only restart, automatic retry, rollback, production or credential reset.
"""
import fcntl,hashlib,json,os,pwd,re,sqlite3,stat,subprocess,sys,time
from pathlib import Path
import host_files as fs
from live_host_adapter import APP,DATABASE,ENVIRONMENT,UNIT,SERVICE,pins,digest
from update_receiver_draft import validate_request,receive_artifact
from uat_update_engine import Contract,FileJournal
import stopped_resume_guards as admission
import offline_uat_extension as extension
WORK=Path('/opt/bubblewash-uat/resume-with-extension')
OLD_EXPIRY=1794457808095
NEW_EXPIRY=1795062608095

def require(ok):
 if not ok:raise ValueError('stopped continuation refused')

def commitments(path):
 require(path in (DATABASE,WORK/'snapshot.sqlite'))
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
   records[name]=digest(fs.canonical(sorted(fs.canonical(list(row)).decode() for row in rows)))
  active=db.execute("SELECT username,starts_at,expires_at FROM staff_uat_accounts WHERE status='active' ORDER BY username").fetchall()
  require(0<len(active)<=1000)
  return dict(fp,records=records,active=active)
 finally:db.close()

def config(r):
 return digest(fs.canonical([[str(p),r.c.trusted(p,mode=0o600 if p==ENVIRONMENT else None),digest(r.c.read(p,16384))] for p in (ENVIRONMENT,UNIT)]))

def extend_offline(r,baseline,operation,owner):
 """Grant helper runs as the service identity, never creates root-owned WAL."""
 payload={'schema':baseline['schema'],'accounts':baseline['accounts'],
          'usernames':[row[0] for row in baseline['active']],'operationId':operation,
          'actor':'user-approved-seven-day-extension'}
 source=extension.__source__
 bootstrap="import json,sys,os,sqlite3;os.umask(0o077);p=json.loads(sys.stdin.buffer.read(1048576));exec(compile(p['source'],'reviewed-extension','exec'));db=sqlite3.connect('file:/var/lib/bubblewash-uat/uat.sqlite?mode=rw',uri=True,timeout=2);result=extend(db,p['request']);db.close();print(json.dumps(result,sort_keys=True))"
 result=subprocess.run(['/usr/bin/python3','-I','-B','-c',bootstrap],input=json.dumps({'source':source,'request':payload}).encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30,check=False,user=owner.pw_uid,group=owner.pw_gid,extra_groups=[],env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
 require(result.returncode==0 and len(result.stdout)<=4096 and not result.stderr)
 receipt=json.loads(result.stdout);require(receipt=={'extended':len(baseline['active']),'expiresAt':NEW_EXPIRY,'originalAccountsUnchanged':True,'otherRecordsUnchanged':True})
 for suffix in ('','-wal','-shm'):
  p=Path(str(DATABASE)+suffix)
  if os.path.lexists(p):r.c.trusted(p,owner=owner.pw_uid,mode=0o600)


def receive(stream,request,r,original,candidate,execution_deadline):
 stage='admission';lock=None;root=None;work=None;journal=None
 try:
  validate_request(request);require(os.geteuid()==0 and request['expectedExpiryMs']==OLD_EXPIRY)
  pins(original,admission.REVISION);pins(candidate,request['candidateRevision']);require(original['unitSha256']==candidate['unitSha256'])
  retained=admission._retained(r)
  r.c.trusted(admission.WORK/'host.lock',mode=0o600)
  lock=os.open(admission.WORK/'host.lock',os.O_RDONLY|os.O_NOFOLLOW);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  loaded=admission._original(r,original);admission._stopped(r)
  production=r.c.production_inventory();configuration=config(r)
  owner=pwd.getpwnam('bubblewash-uat');require(owner.pw_uid>0 and owner.pw_gid>0 and owner.pw_shell=='/usr/sbin/nologin' and owner.pw_dir==str(DATABASE.parent))
  r.c.trusted(DATABASE.parent,owner=owner.pw_uid,directory=True)
  identity=r.c.trusted(DATABASE,owner=owner.pw_uid,mode=0o600)[:2]
  for path in production:
   if os.path.exists(path):require((os.stat(path).st_dev,os.stat(path).st_ino)!=identity)
  require(re.fullmatch(r'v22\.[0-9]+\.[0-9]+',r.c.command(['/usr/bin/node','--version'],limit=128).strip()))
  require(os.statvfs(WORK.parent).f_bavail*os.statvfs(WORK.parent).f_frsize>=8*1024**3)
  memory=re.search(r'^MemAvailable:\s+(\d+) kB$',r.c.read('/proc/meminfo',16384).decode(),re.M);require(memory and int(memory[1])>=1024**2)
  require(int(time.time()*1000)<OLD_EXPIRY-900000)
  baseline=commitments(DATABASE)
  require('staff_uat_extensions' not in baseline['records'])
  require(all(start==OLD_EXPIRY-604800000 and end==OLD_EXPIRY for _,start,end in baseline['active']))
  root=fs.trusted_directory(WORK.parent);work=fs.private_directory(root,WORK.name)
  fd=fs.private_directory(work,'journal');os.close(fd)
  contract=Contract(request['operationId'],original['runtimeRevision'],request['candidateRevision'],request['artifactSha256'],configuration,baseline['accounts'],baseline['schema'],OLD_EXPIRY)
  contract.validate();journal=FileJournal(WORK/'journal');journal.claim(contract)
  def event(name):journal.record(name)
  def stable(stopped=True):
   require(admission._retained(r)==retained and r.loaded_unit()==loaded and config(r)==configuration and r.c.production_inventory()==production)
   require(r.c.trusted(DATABASE,owner=owner.pw_uid,mode=0o600)[:2]==identity)
   if stopped:admission._stopped(r)
  stage='artifact';event('enter:'+stage);receive_artifact(stream,work,request['artifactSize'],request['artifactSha256']);event('done:'+stage)
  stage='stage';event('enter:'+stage)
  for name in ('candidate','compatible-rollback'):
   fs.extract_archive(WORK/'artifact.tar.gz',WORK/name,request['artifactSha256'],request['candidateRevision'],candidate['runtimeFiles'])
   r.p.verify_runtime(WORK/name,UNIT,candidate['runtimeRevision'],candidate['runtimeFiles'],candidate['unitSha256'])
  event('done:'+stage)
  stable();require(admission._original(r,original)==loaded and commitments(DATABASE)==baseline)
  require(execution_deadline-time.monotonic()>=180 and int(time.time()*1000)<OLD_EXPIRY-180000)
  stage='snapshot';event('enter:'+stage)
  data=os.open(DATABASE.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try:fs.closed_snapshot(data,DATABASE.name,work,'snapshot.sqlite',baseline['schema'],baseline['accounts'])
  finally:os.close(data)
  require(commitments(WORK/'snapshot.sqlite')==baseline);stable();event('done:'+stage)
  require(execution_deadline-time.monotonic()>=120 and int(time.time()*1000)<OLD_EXPIRY-120000)
  stage='extension';event('enter:'+stage)
  extend_offline(r,baseline,request['operationId'],owner)
  extended=commitments(DATABASE)
  require(extended['accounts']==baseline['accounts'] and extended['active']==baseline['active'])
  require(set(extended['records'])==set(baseline['records'])|{'staff_uat_extensions'})
  require(all(extended['records'][k]==v for k,v in baseline['records'].items() if k!='staff_uat_audit'))
  stable();event('done:'+stage)
  stage='switch';event('enter:'+stage)
  r.p.verify_runtime(APP,UNIT,original['runtimeRevision'],original['runtimeFiles'],original['unitSha256'])
  fs.exchange_directories(APP,WORK/'candidate')
  r.p.verify_runtime(APP,UNIT,candidate['runtimeRevision'],candidate['runtimeFiles'],candidate['unitSha256']);stable();event('done:'+stage)
  stage='start';event('enter:'+stage)
  r.t.exchange(['/usr/bin/systemctl','--job-mode=fail','start',SERVICE],b'',timeout=45,limit=4096);event('done:'+stage)
  stage='postverify';event('enter:'+stage);deadline=time.monotonic()+30
  while True:
   try:
    after=r.c.collect_restart_isolation(candidate,before_restart=False)
    require(after['database']=={'device':str(identity[0]),'inode':str(identity[1])} and after['productionPaths']==production)
    stable(False);r.health();require(commitments(DATABASE)==extended)
    require(r.c.collect_restart_isolation(candidate,before_restart=False)==after)
    event('done:'+stage)
    return {'state':'verified','stage':stage,'automaticRetry':False}
   except Exception:
    if time.monotonic()>=deadline:raise
    time.sleep(1)
 except Exception:
  if journal is not None:
   try:journal.record('uncertain:'+stage)
   except Exception:pass
  return {'state':'inspection-required','stage':stage,'automaticRetry':False}
 finally:
  if journal is not None:journal.close()
  for fd in (work,root,lock):
   if fd is not None:os.close(fd)
