"""Pinned surgical cleanup coordinator. No broad reset or migration journal update.

Only the emitter may provide hash-verified modules/pins. Uncertain mutation stays
held; before-mutation failure may restore service only after exact revalidation.
"""
import argparse
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import sqlite3
import stat
import sys
import tempfile
import time
import types

STATE=Path('/var/lib/bubblewash-release')
RUNTIME=Path('/home/ubuntu/bubblewash-runtime')
ENV=Path('/home/ubuntu/.config/bubblewash/env')
CURRENT=Path('/home/ubuntu/bubblewash-pilot')
LIVE='1ddf328332836aeefe41d4a4e6f05ed79d4589a3'
PACKAGE='6a060a0b9950f874e2fb46db0739521b4b8be847903598928d03ff0094f81d7c'
PLAN_SHA='9c745a619732c53f3fe61a55de59cd4c10a24c714c4f1595d09642db099cb60b'
JOURNAL='fa82c3eac9f920f86a04f45a64ec3a9259b567585fdd74ac30b06b7d7062dd65'
STAGE='binding'
CHECKPOINTS=frozenset(('alternate-environment-sources', 'app-hold-absent', 'backup-archive-bytes', 'backup-archive-pin', 'backup-paths', 'backup-receipt-file', 'backup-verification-and-freshness', 'child-operation-refused', 'child-result-channel', 'completed-migration-journal', 'current-code-marker', 'database-app-uid', 'database-configured-path', 'database-connection-pragmas', 'database-file-identity', 'database-inventory-core', 'database-open', 'database-sidecars', 'deploy-lock', 'durable-evidence-files', 'durable-evidence-unchanged', 'durable-state-metadata', 'effective-legacy-login-keys', 'effective-runtime', 'environment-cleanup-policy', 'environment-file-metadata', 'environment-group-preservation', 'expected-plan-fingerprint', 'initial', 'installed-sentinel', 'known-unit-inventory', 'legacy-import-absent', 'live-database-inventory', 'live-host-preflight', 'loaded-gates', 'local-health', 'maintenance-hold', 'maintenance-units-inactive', 'owned-app-hold-unchanged', 'public-health', 'runtime-pointer', 'runtime-release-marker', 'runtime-root-ownership', 'runtime-source-content', 'runtime-source-manifest'))
CHECKPOINT='initial'

def checkpoint(label):
    global CHECKPOINT
    require(label in CHECKPOINTS)
    CHECKPOINT=label

def require(ok):
    if not ok:raise ValueError('exact cleanup refused')

def backup_store_id(value):
    # Pins/CI use text; the frozen verifier deliberately requires numeric receipt identity.
    # Accept only this reviewed canonical private repository ID, not coercible aliases.
    require(type(value) is str and value=='1403152795')
    return int(value)

def sha(raw):return hashlib.sha256(raw).hexdigest()

def fsync_dir(path):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)

def atomic_env(path,original,replacement,identity):
    """Replace only our exact original, preserving owner/mode; never restore blindly."""
    require(path.read_bytes()==original and file_identity(path)==identity)
    fd,name=tempfile.mkstemp(prefix='.cleanup-env-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as stream:
            os.fchmod(stream.fileno(),stat.S_IMODE(identity[2]));os.fchown(stream.fileno(),identity[3],identity[4])
            stream.write(replacement);stream.flush();os.fsync(stream.fileno())
        require(path.read_bytes()==original and file_identity(path)==identity)
        os.replace(name,path);fsync_dir(path.parent)
    finally:
        if os.path.lexists(name):os.unlink(name)

def file_identity(path):
    s=path.lstat();require(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and not s.st_mode&0o022)
    return tuple(getattr(s,k) for k in ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns'))

def run_cleanup(host,core,expected,confirmation,apply=False):
    global STAGE
    require(confirmation==core.CONFIRMATION and (not apply or re.fullmatch('[a-f0-9]{64}',expected or '')))
    with host.locked():
        STAGE='live-preflight'
        checkpoint('live-host-preflight')
        raw=host.preflight()
        checkpoint('live-database-inventory')
        plan=host.snapshot_plan(raw)
        checkpoint('expected-plan-fingerprint')
        require(not expected or plan['fingerprint']==expected)
        if not apply:return {**core.public_plan(plan),'checkOnly':True,'configurationChanged':False}
        host.recovery_copy(raw,plan)
        held=False;mutation=False
        try:
            STAGE='hold-and-stop';held=True
            host.hold();host.stop();host.quiet();host.unchanged(raw)
            STAGE='stopped-revalidation'
            require(host.snapshot_plan(raw)['fingerprint']==expected)
            host.quiet();host.unchanged(raw)
            STAGE='exact-mutation';mutation=True
            replacement=host.mutate(raw,expected,confirmation)
            STAGE='committed-verification'
            host.verify_committed(plan,replacement)
            STAGE='restart';host.resume(replacement)
            return {'ok':True,'legacyLoginBundlesRemoved':3,'syntheticResearchRowsDeleted':1,
                    'linkedResearchOutboxRowsDeleted':1,'adminsPreserved':True,
                    'maintenanceResumed':False,'databaseRestored':False}
        except BaseException:
            if held:
                if not mutation:
                    STAGE='unchanged-recovery'
                    # This may itself fail: then the app remains held, never guessed healthy.
                    host.quiet();host.unchanged(raw)
                    require(host.snapshot_plan(raw)['fingerprint']==expected)
                    try:host.resume(raw)
                    except BaseException:
                        host.emergency_hold_stop();raise
                else:
                    STAGE='uncertain-mutation-held'
                    host.emergency_hold_stop()
            raise

class Host:
    def __init__(self,pins,modules,cleanup):
        self.pins=pins;self.cleanup=cleanup
        self.core=modules['preserving'];self.guards=modules['guards'];self.update=modules['update']
        self.guards.core=self.core;self.update.guards=self.guards;self.update.pins=pins['runtimePins']
        self.owner=pwd.getpwnam('ubuntu');require(self.owner.pw_uid>0)
        self.current=STATE/'releases'/LIVE
        self.guard_files={};self.held_identity=None;self.stopped=False
        package=STATE/'packages'/PACKAGE
        self.protected(package,0,True)
        planpath=STATE/'plans'/(PACKAGE+'.json');self.protected(planpath,0)
        planraw=planpath.read_bytes();require(sha(planraw)==PLAN_SHA)
        self.plan=json.loads(planraw)
        self.protected(package/'source-contracts.json',0)
        require(sha((package/'source-contracts.json').read_bytes())==self.plan['sourceContractSha256'])
        # Verify every historical helper before import, not just its filename.
        for name,pin in self.plan['adapterFiles'].items():
            path=package/name;require(path.is_relative_to(package) and '..' not in Path(name).parts)
            self.protected(path,0);require(sha(path.read_bytes())==pin)
        sys.dont_write_bytecode=True;sys.path.insert(0,str(package))
        def load(name,path):
            spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
        contracts=load('contracts',package/'contracts.py');sys.modules['contracts']=contracts
        self.adapter=load('cleanup_frozen_host_adapter',package/'host_adapter.py')
        self.controller=contracts.load_controller()
        self.host=self.adapter.Host(self.plan,self.controller)
        self.host.scan_roots += [STATE/'releases',Path('/home/ubuntu/bubblewash-releases')]
        self.state=self.controller.DurableState(STATE)
        self.state_identity=(STATE.stat().st_dev,STATE.stat().st_ino)
        self.gates=self.controller.LoadedGates(self.state,self.controller.SystemdReader(self.owner.pw_uid,self.host.run),
            {(manager,unit):{name:self.plan['units'][manager+'/'+unit]['files'][name]
              for name in self.plan['units'][manager+'/'+unit]['dropins']} for manager,unit in self.controller.core.UNITS})

    def protected(self,path,uid,directory=False):
        require(path.resolve(strict=True)==path)
        for p in (*path.parents,path):
            s=p.lstat();require(s.st_uid in (0,uid) and not s.st_mode&0o022)
        require(stat.S_ISDIR(path.stat().st_mode) if directory else stat.S_ISREG(path.stat().st_mode))

    @contextmanager
    def locked(self):
        require(os.geteuid()==0 and self.pins['runtimeSha']==LIVE and self.pins['runtimePins']['runtimeSha']==LIVE)
        with self.core.deployment_lock(RUNTIME,self.owner.pw_uid) as check:
            self.lock_check=check;yield

    def stable(self):
        checkpoint('deploy-lock');self.lock_check()
        checkpoint('loaded-gates');self.gates()
        checkpoint('durable-state-metadata');self.state.check()
        checkpoint('runtime-pointer')
        require(CURRENT.is_symlink() and CURRENT.resolve(strict=True)==self.current)
        checkpoint('runtime-root-ownership')
        self.protected(self.current,0,True)
        checkpoint('runtime-release-marker')
        require((self.current/'.release-sha').read_text().strip()==LIVE)
        checkpoint('runtime-source-manifest')
        require(self.core.source_manifest(self.current)==self.pins['runtimePins']['candidateSource'])
        checkpoint('runtime-source-content')
        files,_=self.update.source_snapshot(self.current,self.owner)
        require(self.update.content_commitment(files)==self.pins['runtimePins']['runtimeContent'])
        checkpoint('durable-evidence-unchanged')
        for path,(identity,raw) in self.guard_files.items():require(file_identity(path)==identity and path.read_bytes()==raw)
        checkpoint('owned-app-hold-unchanged')
        if self.held_identity is not None:require(file_identity(STATE/'app-hold')==self.held_identity and (STATE/'app-hold').read_bytes()==b'held\n')
        checkpoint('known-unit-inventory')
        require(self.adapter.object_digest(self.host.inventory())==self.plan['hostAcceptance']['knownInvokersSha256'])

    def backup(self,values):
        checkpoint('backup-receipt-file')
        receiptpath=self.core.RECEIPT;self.guards.safe_path(receiptpath,self.owner)
        raw=self.guards.inspect_read(receiptpath,self.owner,'backup');receipt=json.loads(raw)
        checkpoint('backup-archive-pin')
        require(receipt['sha256']==self.pins['backupSha256'])
        checkpoint('backup-paths')
        status=Path(values['BUBBLEWASH_BACKUP_STATUS_PATH']);archive=Path(values['BUBBLEWASH_BACKUP_OFFSITE_DIR'])/receipt['filename']
        self.guards.safe_path(status,self.owner);self.guards.safe_path(archive,self.owner)
        checkpoint('backup-verification-and-freshness')
        self.core.verify_receipt(receipt,json.loads(status.read_bytes()),time.time(),self.pins['receiptRun'],self.pins['storeSha'],backup_store_id(self.pins['storeId']))
        checkpoint('backup-archive-bytes')
        require(archive.stat().st_size==receipt['size'] and self.core.digest(archive)==self.pins['backupSha256'])

    def preflight(self):
        checkpoint('app-hold-absent')
        require(not os.path.lexists(STATE/'app-hold'))
        checkpoint('durable-evidence-files')
        for name in ('installed-v1','maintenance-hold','transition.json'):
            path=STATE/name;self.protected(path,0);self.guard_files[path]=(file_identity(path),path.read_bytes())
        checkpoint('installed-sentinel')
        require(self.guard_files[STATE/'installed-v1'][1]==b'bubblewash-release-gate-v1\n')
        checkpoint('maintenance-hold')
        require(self.guard_files[STATE/'maintenance-hold'][1]==b'held\n')
        checkpoint('completed-migration-journal')
        journal=json.loads(self.guard_files[STATE/'transition.json'][1])
        require(journal=={'schema':1,'phase':'CANDIDATE_READY','planHash':JOURNAL,'target':str(STATE/'releases'/'5f256800d65dbe3b69f54e95afa0e8ab30b5e881')})
        checkpoint('current-code-marker')
        marker=RUNTIME/'current-release';self.guards.safe_path(marker,self.owner)
        self.guard_files[marker]=(file_identity(marker),marker.read_bytes())
        require(self.core.parse(marker.read_bytes()).get('sha')==LIVE and self.core.parse(marker.read_bytes()).get('path')==str(self.current))
        checkpoint('environment-file-metadata')
        raw,self.env_id=self.guards.environment_snapshot(ENV,self.owner,None)
        # The app-UID writer must be able to preserve the existing group exactly.
        checkpoint('environment-group-preservation')
        require(self.env_id[1][4]==self.owner.pw_gid)
        checkpoint('environment-cleanup-policy')
        self.original=raw;self.values,self.replacement=self.cleanup.config(raw)
        checkpoint('database-configured-path')
        self.dbpath=Path(self.values['BUBBLEWASH_DATABASE_PATH'])
        require(self.dbpath.is_absolute() and not self.dbpath.is_relative_to(STATE) and not self.dbpath.is_relative_to(Path('/home/ubuntu/bubblewash-releases')))
        require(str(self.dbpath)==self.plan['database'])
        checkpoint('database-file-identity')
        self.db_id=self.guards.database_identity(self.dbpath,self.owner)
        require(tuple(self.db_id[:2])==tuple(self.plan['databaseIdentity']))
        checkpoint('legacy-import-absent')
        require(not (self.current/'data/submissions.jsonl').exists())
        self.stable();self.backup(self.values);self.no_alternate_login_sources();self.effective(self.values)
        # Existing maintenance inhibition is preserved, never resumed.
        checkpoint('maintenance-units-inactive')
        for manager,unit in self.controller.core.UNITS:
            if manager=='system':
                p=self.controller.core.parse_properties(self.host.show(manager,unit))
                require(p['ActiveState']=='inactive' and p['SubState']=='dead' and not p.get('Job'))
        return raw

    @contextmanager
    def database(self,readonly):
        checkpoint('database-app-uid')
        require(os.geteuid()==self.owner.pw_uid)
        checkpoint('database-sidecars')
        for suffix in ('-wal','-shm'):
            sidecar=Path(str(self.dbpath)+suffix)
            if os.path.lexists(sidecar):self.guards.safe_path(sidecar,self.owner)
            else:require(self.stopped)
        checkpoint('database-open')
        db=sqlite3.connect(self.dbpath.as_uri()+('?mode=ro' if readonly else '?mode=rw'),uri=True,timeout=5,isolation_level=None)
        started=time.monotonic()
        db.set_progress_handler(lambda: int(time.monotonic()-started>60),10000)
        try:
            checkpoint('database-connection-pragmas')
            db.execute('PRAGMA trusted_schema=OFF');db.execute('PRAGMA foreign_keys=ON')
            if readonly:db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
            yield db
        finally:
            if db.in_transaction:db.rollback()
            db.close()

    def unchanged(self,raw):
        self.stable();require(self.guards.environment_snapshot(ENV,self.owner,None)==(raw,self.env_id))
        require(self.guards.database_identity(self.dbpath,self.owner)==self.db_id)
        self.backup(self.values)

    def recovery_copy(self,raw,plan):
        parent=STATE/'rehearsal-evidence';self.protected(parent,0,True)
        self.recovery=parent/('exact-cleanup-'+plan['fingerprint']);self.recovery.mkdir(mode=0o700)
        for name,data in (('env.before',raw),('operation.json',json.dumps({'fingerprint':plan['fingerprint'],'runtimeSha':LIVE,'backupSha256':self.pins['backupSha256']}).encode())):
            fd=os.open(self.recovery/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
        fsync_dir(self.recovery);fsync_dir(parent)

    def hold(self):
        self.stable()
        path=STATE/'app-hold'
        if self.held_identity is not None:return
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as stream:stream.write(b'held\n');stream.flush();os.fsync(stream.fileno())
        fsync_dir(STATE);self.held_identity=file_identity(path)

    def stop(self):
        self.host.capture();errors=[]
        for manager,unit in self.controller.core.UNITS:
            try:self.host.service(manager,'stop',unit)
            except BaseException as e:errors.append(type(e).__name__)
        self.host.quiet();self.stopped=True
        require(not errors)

    def quiet(self):self.host.quiet();self.stable();self.stopped=True

    def as_app(self,operation):
        # Failure labels do not acknowledge success or permit retry. Child errors
        # still fail the frozen UID-drop helper; only allowlisted labels return.
        with tempfile.TemporaryFile(dir='/run') as result:
            def child():
                try:
                    value=operation()
                    raw=json.dumps(value,default=lambda v:{'__bytes__':v.hex()} if isinstance(v,bytes) else None).encode()
                    require(len(raw)<=2*1024*1024)
                    result.write(raw);result.flush()
                except BaseException:
                    failure={'diagnosticFailure':True,'check':CHECKPOINT}
                    core_check=getattr(self.cleanup,'CHECKPOINT','initial')
                    if CHECKPOINT in ('environment-cleanup-policy','database-inventory-core') and core_check in getattr(self.cleanup,'CHECKPOINTS',()):failure['coreCheck']=core_check
                    result.seek(0);result.truncate();result.write(json.dumps(failure).encode());result.flush()
                    raise
            try:self.guards.migrate_as_app(self.owner,child)
            except BaseException:
                try:
                    result.seek(0);failure=json.loads(result.read(4097))
                    if failure.get('diagnosticFailure') is True:
                        label=failure.get('check')
                        if label in CHECKPOINTS:checkpoint(label)
                        label=failure.get('coreCheck')
                        if label in getattr(self.cleanup,'CHECKPOINTS',()):self.cleanup.checkpoint(label)
                except BaseException:pass
                raise
            checkpoint('child-result-channel')
            result.seek(0);raw=result.read(2*1024*1024+1);require(len(raw)<=2*1024*1024)
            value=json.loads(raw,object_hook=lambda v:bytes.fromhex(v['__bytes__']) if set(v)=={'__bytes__'} else v)
            require(not (isinstance(value,dict) and value.get('diagnosticFailure') is True))
            return value

    def snapshot_plan(self,raw):
        def read():
            with self.database(readonly=True) as db:
                checkpoint('database-inventory-core')
                return self.cleanup.inspect(db,raw)
        return self.as_app(read)

    def mutate(self,raw,expected,confirmation):
        self.quiet();self.unchanged(raw)
        def operation():
            with self.database(readonly=False) as db:
                db.execute('BEGIN IMMEDIATE')
                replacement=self.cleanup.apply_in_transaction(db,raw,expected,confirmation)
                atomic_env(ENV,raw,replacement,self.env_id[1])
                db.commit()
                return replacement
        return self.as_app(operation)

    def verify_committed(self,plan,replacement):
        self.quiet();require(ENV.read_bytes()==replacement)
        require(self.guards.database_identity(self.dbpath,self.owner)==self.db_id)
        def verify():
            with self.database(readonly=True) as db:
                schema,contents=self.cleanup.database_state(db)
                require(schema==plan['_schema'] and {k:v for k,v in contents.items() if k not in ('research_responses','research_notification_outbox')}==plan['_preserved'])
                require(db.execute('SELECT count(*) FROM research_responses').fetchone()[0]==0 and db.execute('SELECT count(*) FROM research_notification_outbox').fetchone()[0]==0)
                require(list(db.execute('PRAGMA foreign_key_check'))==[])
            return True
        require(self.as_app(verify) is True)

    def emergency_hold_stop(self):
        # Fail closed even when a late verification rejects source/config drift.
        # Do not require the very checks that failed before inhibiting writers.
        self.protected(STATE,0,True)
        require((STATE.stat().st_dev,STATE.stat().st_ino)==self.state_identity)
        path=STATE/'app-hold'
        if not os.path.lexists(path):
            fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'wb') as stream:stream.write(b'held\n');stream.flush();os.fsync(stream.fileno())
            fsync_dir(STATE)
        self.protected(path,0);require(path.read_bytes()==b'held\n')
        self.held_identity=file_identity(path)
        # A capture/evidence failure must not prevent attempts to stop known units.
        errors=[]
        try:self.host.capture()
        except BaseException:errors.append('capture')
        for manager,unit in self.controller.core.UNITS:
            try:self.host.service(manager,'stop',unit)
            except BaseException:errors.append('stop')
        self.host.quiet();self.stopped=True
        require(not errors)

    def no_alternate_login_sources(self):
        # Catch predictable legacy-login resurrection before stopping production.
        # Values stay private; the exact loaded command/source is separately pinned.
        checkpoint('alternate-environment-sources')
        props=self.core.parse(self.core.ctl('show',self.core.UNIT,'--property=Environment,PassEnvironment').encode())
        require(set(props)=={'Environment','PassEnvironment'})
        inline={item.split('=',1)[0] for item in shlex.split(props['Environment'])}
        inherited=set(shlex.split(props['PassEnvironment']))
        require(not (inline|inherited)&self.cleanup.REMOVE_KEYS)

    def effective(self,values):
        checkpoint('effective-runtime');self.core.check_runtime(self.current,values)
        checkpoint('local-health');self.core.health(3000)
        checkpoint('effective-legacy-login-keys')
        p=self.core.parse(self.core.ctl('show',self.core.UNIT,'--property=MainPID').encode());pid=p['MainPID']
        listeners=self.core.command(['ss','-H','-ltnp','sport = :3000']);pids={pid,*re.findall(r'pid=(\d+)',listeners)}
        for process in pids:
            raw=(Path('/proc')/process/'environ').read_bytes()
            env=dict(item.decode().split('=',1) for item in raw.split(b'\0') if b'=' in item)
            require(all((key in env)==(key in values) and env.get(key)==values.get(key) for key in self.cleanup.REMOVE_KEYS))
        checkpoint('public-health')
        self.core.public_health()

    def resume(self,raw):
        self.quiet();require(ENV.read_bytes()==raw)
        require(file_identity(STATE/'app-hold')==self.held_identity)
        (STATE/'app-hold').unlink();fsync_dir(STATE);self.held_identity=None
        try:
            self.host.service('user','start',self.controller.core.APP)
            self.stopped=False
            values=self.core.parse(raw);self.effective(values);self.stable()
        except BaseException:
            self.emergency_hold_stop();raise


def entry(pins,sources):
    """Source strings are separately frozen in the publication's exact pins."""
    global STAGE
    cleanup=None
    try:
        require(pins.get('schema')=='bubblewash-exact-cleanup-host/v1')
        require(set(sources)=={'cleanup','preserving','guards','update'}==set(pins['dependencies']))
        require(all(sha(raw.encode())==pins['dependencies'][name] for name,raw in sources.items()))
        def module(name,extra=None):
            m=types.ModuleType(name);m.__dict__.update(extra or {});exec(compile(sources[name],name,'exec'),m.__dict__);return m
        cleanup=module('cleanup')
        modules={name:module(name) for name in ('preserving','guards','update')}
        parser=argparse.ArgumentParser();parser.add_argument('--operation',choices=('preflight','apply'),default='preflight');parser.add_argument('--plan-fingerprint',default='')
        args=parser.parse_args();host=Host(pins,modules,cleanup)
        result=run_cleanup(host,cleanup,args.plan_fingerprint,cleanup.CONFIRMATION,args.operation=='apply')
        print(json.dumps(result,sort_keys=True))
    except BaseException:
        failure={'ok':False,'stage':STAGE,'check':CHECKPOINT if CHECKPOINT in CHECKPOINTS else 'initial','inspectBeforeRetry':True,'automaticDatabaseRestore':False}
        label=getattr(cleanup,'CHECKPOINT','initial')
        if CHECKPOINT in ('environment-cleanup-policy','database-inventory-core') and label in getattr(cleanup,'CHECKPOINTS',()):failure['coreCheck']=label
        print(json.dumps(failure))
        raise SystemExit(1)
