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
 require((rows['ActiveState'],rows['SubState']) in (('inactive','dead'),('failed','failed')))
 require(rows['MainPID']=='0' and rows['ControlPID']=='0')
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

