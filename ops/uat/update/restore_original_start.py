"""One guarded original-code start after the exact stopped-only UAT attempt.
No CLI, network, DB reads/writes, credential changes, swap or retry.
"""
import fcntl,json,os,re,shlex,time
from pathlib import Path
WORK=Path('/opt/bubblewash-uat/update')
APP=Path('/opt/bubblewash-uat/app')
UNIT=Path('/etc/systemd/system/bubblewash-uat.service')
ENV=Path('/etc/bubblewash-uat/environment')
SERVICE='bubblewash-uat.service'
OP='uat-update-20261111-a7cb5be-03'
REVISION='f4fd4ce424c2b363fc5a2196432e0ac2ce7c05a1'
ATTEMPT='original-start-recovery-attempt'
EVENTS=['claimed','enter:inspect','done:inspect','enter:stage','done:stage','enter:stop','done:stop','enter:stopped','uncertain:stopped']

def require(ok):
 if not ok:raise ValueError('original start recovery refused')

def validate_journal(marker,raw):
 require(marker==(OP+'\n').encode() and 0<len(raw)<=8192)
 rows=[json.loads(x) for x in raw.splitlines()];require(len(rows)==len(EVENTS))
 for i,(row,event) in enumerate(zip(rows,EVENTS)):
  require(type(row)is dict and set(row)=={'sequence','event','contract'} and type(row['sequence'])is int and row['sequence']==i and row['event']==event)
  require(bool(re.fullmatch('[a-f0-9]{64}',row['contract'])) if i==0 else row['contract']=='')

def _original(r,pins):
 require(pins['runtimeRevision']==REVISION)
 r.c.trusted(APP,directory=True);r.c.trusted(UNIT);r.c.trusted(ENV,mode=0o600)
 r.p.verify_runtime(APP,UNIT,REVISION,pins['runtimeFiles'],pins['unitSha256'])
 configured=r.p.parse_environment(r.c.read(ENV,16384))
 require(set(configured)==set(r.p.EXPECTED_ENV)|{'BUBBLEWASH_SESSION_SECRET'})
 require(all(configured[k]==v for k,v in r.p.EXPECTED_ENV.items()))
 require(bool(re.fullmatch('[A-Za-z0-9_-]{64}',configured['BUBBLEWASH_SESSION_SECRET'])))
 return r.loaded_unit()

def _stopped(r):
 raw=r.c.command(['/usr/bin/systemctl','show',SERVICE,'-p','ActiveState','-p','SubState','-p','MainPID','-p','ControlPID','-p','ControlGroup'])
 rows={}
 for line in raw.splitlines():
  k,sep,v=line.partition('=');require(sep and k not in rows);rows[k]=v
 require(set(rows)=={'ActiveState','SubState','MainPID','ControlPID','ControlGroup'})
 require(all(rows[k]==v for k,v in {'ActiveState':'inactive','SubState':'dead','MainPID':'0','ControlPID':'0'}.items()))
 require(rows['ControlGroup'] in ('','/system.slice/bubblewash-uat.service'))
 job=r.c.command(['/usr/bin/busctl','--system','get-property','org.freedesktop.systemd1','/org/freedesktop/systemd1/unit/bubblewash_2duat_2eservice','org.freedesktop.systemd1.Unit','Job'])
 require(shlex.split(job)==['(uo)','0','/'])
 try:
  raw=r.c.read('/sys/fs/cgroup/system.slice/bubblewash-uat.service/cgroup.events',4096).decode()
 except FileNotFoundError:raw=None
 if raw is not None:
  events=dict(line.split() for line in raw.splitlines());require(events.get('populated')=='0')
 require(r.c.command(['/usr/bin/ss','-H','-ltnp','sport = :3108']).strip()=='')
 r.quiet_sample()

def _retained(r):
 r.c.trusted(WORK,directory=True,mode=0o700);r.c.trusted(WORK/'journal',directory=True,mode=0o700)
 require(set(os.listdir(WORK))=={'artifact.tar.gz','candidate','host.lock','journal'})
 require(set(os.listdir(WORK/'journal'))=={'active-operation',OP+'.jsonl'})
 paths=(WORK/'journal/active-operation',WORK/'journal'/(OP+'.jsonl'))
 ids=[r.c.trusted(p,mode=0o600) for p in paths]
 raw=[r.c.read(p,8192) for p in paths];validate_journal(*raw)
 return ids,raw

def restore(r,pins):
 lock=None;directory=None;stage='precheck-failed'
 try:
  require(os.geteuid()==0)
  first=_retained(r);r.c.trusted(WORK/'host.lock',mode=0o600)
  lock=os.open(WORK/'host.lock',os.O_RDONLY|os.O_NOFOLLOW);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  loaded=_original(r,pins);_stopped(r)
  require(_retained(r)==first and _original(r,pins)==loaded);_stopped(r)
  directory=os.open(WORK,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  fd=os.open(ATTEMPT,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=directory)
  try:
   os.fchmod(fd,0o600);raw=b'original-runtime-start-one-attempt\n';offset=0
   while offset<len(raw):
    n=os.write(fd,raw[offset:]);require(n>0);offset+=n
   os.fsync(fd)
  finally:os.close(fd)
  os.fsync(directory)
  stage='start-uncertain'
  r.t.exchange(['/usr/bin/systemctl','--job-mode=fail','start',SERVICE],b'',timeout=45,limit=4096)
  stage='postcheck-failed';deadline=time.monotonic()+30
  while True:
   try:
    r.c.collect_restart_isolation(pins,before_restart=False)
    require(_original(r,pins)==loaded);r.health()
    return {'state':'verified','originalRuntime':True,'automaticRetry':False}
   except Exception:
    if time.monotonic()>=deadline:raise
    time.sleep(1)
 except Exception:return {'state':stage,'originalRuntime':False,'automaticRetry':False}
 finally:
  if directory is not None:os.close(directory)
  if lock is not None:os.close(lock)
