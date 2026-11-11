"""Dedicated UAT host adapter, no CLI/transport and no import-time host operations.

Only invoke after independent review and an explicitly approved UAT interruption.
A protected workflow must provide exact-source controls, artifact and candidate
pins. This module does not infer authorization from an argument or test result.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import pwd
import sqlite3
import stat
import shlex
import time
import fcntl
from uat_update_engine import Evidence, Refused
from host_files import canonical, database_fingerprints

APP=Path('/opt/bubblewash-uat/app')
WORK=Path('/opt/bubblewash-uat/update')
DATABASE=Path('/var/lib/bubblewash-uat/uat.sqlite')
ENVIRONMENT=Path('/etc/bubblewash-uat/environment')
UNIT=Path('/etc/systemd/system/bubblewash-uat.service')
SERVICE='bubblewash-uat.service'
PIN_NAMES={'src/lib/uat-environment.ts','src/lib/passwords.ts','src/lib/uat-accounts.ts','src/lib/auth.ts','scripts/uat-account.mjs','scripts/uat-sealed-handover.mjs'}

def require(ok):
    if not ok:raise Refused('UAT update guard refused')

def digest(raw):return hashlib.sha256(raw).hexdigest()

def pins(value,revision):
    require(type(value) is dict and set(value)=={'runtimeRevision','runtimeFiles','unitSha256'})
    require(value['runtimeRevision']==revision and re.fullmatch('[0-9a-f]{40}',revision))
    require(type(value['runtimeFiles']) is dict and set(value['runtimeFiles'])==PIN_NAMES)
    require(all(type(v) is str and re.fullmatch('[0-9a-f]{64}',v) for v in [value['unitSha256'],*value['runtimeFiles'].values()]))

def stopped_properties(raw):
    rows={}
    for line in raw.splitlines():
        key,sep,value=line.partition('=');require(sep and key not in rows);rows[key]=value
    require(rows=={'ActiveState':'inactive','SubState':'dead','MainPID':'0','ControlPID':'0','ControlGroup':''})


def stopped_runtime(job, previous_ticks, current_ticks, cgroup_processes):
    require(shlex.split(job)==['(uo)','0','/'])
    require(current_ticks is None or current_ticks!=previous_ticks)
    require(cgroup_processes is None or cgroup_processes.strip()=='')


def database_commitments(path):
    """Read-only SQL. Caller establishes trusted path and quiescence as needed.

No account value is returned publicly. Existing private SQLite shm sidecars may
be accessed by SQLite; this is not claimed to be a zero-filesystem-write probe.
"""
    require(path==DATABASE or (path.parent==WORK and path.name=='snapshot.sqlite'))
    db=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=2)
    try:
        db.execute('PRAGMA query_only=ON');db.execute('PRAGMA trusted_schema=OFF');db.execute('BEGIN')
        schema=db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()
        tables=[r[1] for r in schema if r[0]=='table'];require('staff_uat_accounts' in tables)
        account_rows=db.execute('SELECT * FROM staff_uat_accounts ORDER BY username').fetchall()
        require(0<len(account_rows)<=1000)
        expiry=db.execute("SELECT min(expires_at) FROM staff_uat_accounts WHERE status='active'").fetchone()[0]
        require(type(expiry) is int)
        values={}
        for name in tables:
            require(re.fullmatch('[A-Za-z_][A-Za-z0-9_]*',name))
            # Existing application removes stale GPS readings on startup. All
            # business/account/ledger records remain under exact comparisons.
            if name=='driver_live_locations':continue
            rows=db.execute('SELECT * FROM "'+name+'"').fetchall()
            require(len(rows)<=100000)
            values[name]=digest(canonical(sorted([canonical(list(r)).decode() for r in rows])))
        fingerprints=database_fingerprints(db)
        return {'schema':fingerprints['schema'],'accounts':fingerprints['accounts'],
                'expiry':expiry,'records':values}
    finally:db.close()


class HostAdapter:
    def __init__(self, controls, original_pins, candidate_pins, filesystem, execution_deadline=None):
        # controls is the already reviewed single-restart module with its
        # collector/preflight dependencies. Construction does no host IO.
        self.r=controls;self.c=controls.c;self.p=controls.p;self.fs=filesystem
        self.original=original_pins;self.candidate=candidate_pins
        self.lock=None;self.baseline=None;self.loaded=None;self.before=None
        self.execution_deadline=execution_deadline
        self.stopped_ok=False;self.switched=False

    def now_ms(self):return int(time.time()*1000)

    def _private(self):
        require(os.geteuid()==0)
        self.c.trusted(WORK,directory=True,mode=0o700)
        self.c.trusted(ENVIRONMENT,mode=0o600);self.c.trusted(UNIT)
        self.c.trusted(APP,directory=True)

    def _config(self):
        rows=[]
        for path in (ENVIRONMENT,UNIT):
            identity=self.c.trusted(path,mode=0o600 if path==ENVIRONMENT else None)
            rows.append([str(path),identity,digest(self.c.read(str(path),16384))])
        return digest(canonical(rows))

    def _evidence(self,revision):
        value=database_commitments(DATABASE)
        if self.baseline is not None:require(value['records']==self.baseline['records'])
        require(self.r.loaded_unit()==self.loaded)
        require(self.c.production_inventory()==self.before['productionPaths'])
        return Evidence(revision,self._config(),value['accounts'],value['schema'],value['expiry'],True,True,True,True)

    def inspect(self,c):
        pins(self.original,c.previous_revision);pins(self.candidate,c.candidate_revision)
        require(self.original['unitSha256']==self.candidate['unitSha256'])
        self._private()
        # Fixed global coordination complements the persistent engine journal.
        self.lock=os.open(WORK/'host.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
        info=os.fstat(self.lock);require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o600 and info.st_nlink==1)
        fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        require(re.fullmatch(r'v22\.[0-9]+\.[0-9]+',self.c.command(['/usr/bin/node','--version'],limit=128).strip()))
        first=self.c.collect_restart_isolation(self.original,before_restart=False)
        self.loaded=self.r.loaded_unit();self.r.quiet_sample()
        self.before=first
        self.baseline=database_commitments(DATABASE)
        free=os.statvfs(WORK);require(free.f_bavail*free.f_frsize>=8*1024**3)
        memory=self.c.read('/proc/meminfo',16384).decode();m=re.search(r'^MemAvailable:\s+(\d+) kB$',memory,re.M)
        require(m and int(m[1])>=1024**2)
        require(self.c.collect_restart_isolation(self.original,before_restart=False)==first)
        return self._evidence(c.previous_revision)

    def stage(self,c):
        require(self.baseline is not None)
        self.c.trusted(WORK/'artifact.tar.gz',mode=0o600)
        self.fs.extract_archive(WORK/'artifact.tar.gz',WORK/'candidate',c.artifact_sha256,c.candidate_revision,self.candidate['runtimeFiles'])
        self.p.verify_runtime(WORK/'candidate',UNIT,c.candidate_revision,self.candidate['runtimeFiles'],self.candidate['unitSha256'])
        return c.artifact_sha256

    def _require_stop_budget(self):
        require(type(self.execution_deadline) in (int,float))
        require(self.execution_deadline-time.monotonic()>=180)

    def stop(self,c):
        self._require_stop_budget()
        require(self.baseline is not None and not self.stopped_ok)
        self._private();self.r.quiet_sample()
        require(self.c.collect_restart_isolation(self.original,before_restart=False)==self.before)
        self._evidence(c.previous_revision).require(c,c.previous_revision)
        self._require_stop_budget()
        self.r.t.exchange(['/usr/bin/systemctl','--job-mode=fail','stop',SERVICE],b'',timeout=45,limit=4096)

    def _stopped(self):
        raw=self.c.command(['/usr/bin/systemctl','show',SERVICE,'-p','ActiveState','-p','SubState','-p','MainPID','-p','ControlPID','-p','ControlGroup'])
        stopped_properties(raw)
        job=self.c.command(['/usr/bin/busctl','--system','get-property','org.freedesktop.systemd1','/org/freedesktop/systemd1/unit/bubblewash_2duat_2eservice','org.freedesktop.systemd1.Unit','Job'])
        try:current_ticks=self.c.start(self.before['pid'])
        except FileNotFoundError:current_ticks=None
        try:group=self.c.read('/sys/fs/cgroup/system.slice/bubblewash-uat.service/cgroup.procs',65536).decode()
        except FileNotFoundError:group=None
        stopped_runtime(job,self.before['startTicks'],current_ticks,group)
        require(self.c.command(['/usr/bin/ss','-H','-ltnp','sport = :3108']).strip()=='')
        self.r.quiet_sample()
        # systemd cgroup empty/removal plus coordinated host window is required;
        # arbitrary privileged concurrent DB writers cannot be ruled out here.
        require(self.r.loaded_unit()==self.loaded)

    def stopped(self,c):
        self._stopped();self.stopped_ok=True
        return self._evidence(c.previous_revision)

    def snapshot(self,c):
        require(self.stopped_ok);self._stopped()
        # Existing collector validates UAT-owned data ancestry and DB identity.
        # Use held no-follow descriptors; root-only path wrapper is unsuitable.
        owner=pwd.getpwnam('bubblewash-uat').pw_uid
        require(owner>0)
        self.c.trusted(DATABASE.parent,owner=owner,directory=True)
        self.c.trusted(DATABASE,owner=owner,mode=0o600)
        data_fd=os.open(DATABASE.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        work_fd=self.fs.trusted_directory(WORK)
        try:
            self.fs.closed_snapshot(data_fd,DATABASE.name,work_fd,'snapshot.sqlite',c.schema_sha256,c.accounts_sha256)
        finally:os.close(data_fd);os.close(work_fd)
        value=database_commitments(WORK/'snapshot.sqlite')
        require(value==self.baseline)
        self._stopped();return True

    def switch(self,c):
        require(self.stopped_ok and not self.switched);self._stopped()
        self._evidence(c.previous_revision).require(c,c.previous_revision)
        self.p.verify_runtime(WORK/'candidate',UNIT,c.candidate_revision,self.candidate['runtimeFiles'],self.candidate['unitSha256'])
        self.fs.exchange_directories(APP,WORK/'candidate')
        self.switched=True
        self.p.verify_runtime(APP,UNIT,c.candidate_revision,self.candidate['runtimeFiles'],self.candidate['unitSha256'])

    def start(self,c):
        require(self.switched);self._stopped()
        require(self._config()==c.configuration_sha256)
        self.r.t.exchange(['/usr/bin/systemctl','--job-mode=fail','start',SERVICE],b'',timeout=45,limit=4096)

    def postverify(self,c):
        require(self.switched)
        deadline=time.monotonic()+30
        while True:
            try:
                after=self.c.collect_restart_isolation(self.candidate,before_restart=False)
                require((after['pid'],after['startTicks'])!=(self.before['pid'],self.before['startTicks']))
                require(after['database']==self.before['database'] and after['productionPaths']==self.before['productionPaths'])
                self.r.health()
                result=self._evidence(c.candidate_revision)
                result.require(c,c.candidate_revision)
                require(self.c.collect_restart_isolation(self.candidate,before_restart=False)==after)
                return result
            except Exception:
                if time.monotonic()>=deadline:raise
                time.sleep(1)

    def close(self):
        if self.lock is not None:os.close(self.lock);self.lock=None
