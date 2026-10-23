"""Durable local release-controller candidate. No installation or live CLI.

Host bindings use the exact existing lock/backup guards; app selection requires
reviewed owner source pins. This module is executable via --self-test only.
"""
import argparse
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import shlex
import subprocess
import sys
import tempfile
import time

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE / 'bubblewash-migration-transition'))
import transition as core
require = core.require


def guards_module():
    source = BASE / 'bubblewash-web-a476-baseline/ops/deploy-preserving.py'
    require(core.digest(source) == '29006085ee39680daa30fc34d05c3761b410f0f860835943eab8a60168da076a', 'guard source drift')
    spec = importlib.util.spec_from_file_location('durable_pinned_guards', source)
    module = importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)


def atomic_write(path, data, preserve_metadata=False):
    path = Path(path)
    metadata=path.lstat() if preserve_metadata and path.exists() else None
    if metadata:require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink==1,'unsafe marker')
    fd, temporary = tempfile.mkstemp(prefix='.release-', dir=path.parent)
    try:
        os.fchmod(fd, stat.S_IMODE(metadata.st_mode) if metadata else 0o600)
        if metadata:os.fchown(fd,metadata.st_uid,metadata.st_gid)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data);handle.flush();os.fsync(handle.fileno())
        os.replace(temporary, path);fsync_dir(path.parent)
    finally:
        if os.path.exists(temporary):os.unlink(temporary)


def file_identity(path):
    info = Path(path).lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'nonregular linked guard file')
    return tuple(getattr(info, key) for key in ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink'))


class HostGuards:
    """Concrete reuse of existing lock, config, receipt and archive validation."""
    def __init__(self, runtime, env_file, receipt_file, expected, app_uid):
        self.runtime=Path(runtime);self.env_file=Path(env_file);self.receipt_file=Path(receipt_file)
        self.expected=expected;self.app_uid=app_uid;self.module=guards_module()
    @contextmanager
    def locked(self):
        with self.module.deployment_lock(self.runtime,self.app_uid) as unchanged_lock:
            raw=self.env_file.read_bytes();identity=file_identity(self.env_file)
            receipt_raw=self.receipt_file.read_bytes();receipt_identity=file_identity(self.receipt_file)
            require(core.digest(self.env_file)==self.expected['envSha256'], 'configuration pin differs')
            require(core.digest(self.receipt_file)==self.expected['receiptSha256'], 'receipt pin differs')
            values=self.module.parse(raw)
            database=Path(values['BUBBLEWASH_DATABASE_PATH'])
            require(database.is_absolute() and database.resolve(strict=True)==database
                    and str(database)==self.expected['database'],'guarded configuration database differs')
            receipt=json.loads(receipt_raw)
            archive=Path(values['BUBBLEWASH_BACKUP_OFFSITE_DIR'])/receipt['filename']
            archive_identity=file_identity(archive)
            def verify():
                unchanged_lock()
                require(file_identity(self.env_file)==identity and self.env_file.read_bytes()==raw,'configuration changed')
                require(file_identity(self.receipt_file)==receipt_identity and self.receipt_file.read_bytes()==receipt_raw,'receipt changed')
                status_path=Path(values['BUBBLEWASH_BACKUP_STATUS_PATH']);file_identity(status_path)
                self.module.verify_receipt(receipt,json.loads(status_path.read_bytes()),time.time(),self.expected['receiptRun'],self.expected['storeSha'],self.expected['storeId'])
                require(file_identity(archive)==archive_identity and archive.stat().st_size==receipt['size']
                        and core.digest(archive)==receipt['sha256']==self.expected['archiveSha256'],'backup archive changed')
                return True
            verify.database_path=database
            verify.marker_path=self.runtime/'current-release'
            verify();yield verify


class SystemdReader:
    """Read-only busctl adapter using the deployment's ubuntu user-manager model.

    Commands are injectable for local fixtures; construction performs no access.
    """
    def __init__(self, app_uid, run=None):
        self.app_uid=int(app_uid)
        self.run=run or (lambda args: subprocess.check_output(args,text=True,timeout=30))
    def __call__(self,manager,unit):
        require((manager,unit) in core.UNITS,'unknown unit manager')
        escaped=''.join(char if char.isascii() and char.isalnum() else '_'+format(ord(char),'02x') for char in unit)
        prefix=[] if manager=='system' else ['runuser','-u','ubuntu','--','env',
            f'XDG_RUNTIME_DIR=/run/user/{self.app_uid}',f'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{self.app_uid}/bus']
        base=prefix+['busctl','--system' if manager=='system' else '--user','get-property',
            'org.freedesktop.systemd1','/org/freedesktop/systemd1/unit/'+escaped,'org.freedesktop.systemd1.Unit']
        result={}
        for property_name in ('Conditions','NeedDaemonReload','DropInPaths'):
            tokens=shlex.split(self.run(base+[property_name]))
            if property_name=='NeedDaemonReload':
                require(len(tokens)==2 and tokens[0]=='b' and tokens[1] in ('true','false'),'invalid boolean property')
                result[property_name]=tokens[1]=='true';continue
            expected='a(sbbsi)' if property_name=='Conditions' else 'as'
            require(len(tokens)>=2 and tokens[0]==expected and tokens[1].isdigit(),'invalid array property')
            count=int(tokens[1]);values=tokens[2:];width=5 if property_name=='Conditions' else 1
            require(len(values)==count*width,'truncated array property')
            if width==1:result[property_name]=values;continue
            rows=[]
            for index in range(0,len(values),5):
                name,trigger,negated,path,status=values[index:index+5]
                require(trigger in ('true','false') and negated in ('true','false'),'invalid condition booleans')
                rows.append([name,trigger=='true',negated=='true',path,int(status)])
            result[property_name]=rows
        return result


class LoadedGates:
    """Validate structured D-Bus Unit properties from the correct manager.

    Reader must return Conditions (a(sbbsi)), NeedDaemonReload and DropInPaths.
    Host reader installation is deliberately outside this local candidate.
    """
    def __init__(self, state, reader, dropin_pins):
        self.state=state;self.reader=reader;self.dropin_pins=dropin_pins
    def __call__(self):
        for manager,unit in core.UNITS:
            properties=self.reader(manager,unit)
            require(properties.get('NeedDaemonReload') is False,'unit requires daemon reload')
            hold=self.state.app_hold if unit==core.APP else self.state.maintenance_hold
            expected={('ConditionPathExists',False,False,str(self.state.sentinel)),
                      ('ConditionPathExists',False,True,str(hold))}
            conditions=properties.get('Conditions',[])
            require(all(len(row)==5 and type(row[1]) is bool and type(row[2]) is bool
                        and row[1] is False for row in conditions),'unsafe loaded condition structure')
            require(expected.issubset({tuple(row[:4]) for row in conditions}),'loaded gate missing')
            paths=properties.get('DropInPaths',[])
            pins=self.dropin_pins.get((manager,unit),{})
            require(bool(pins) and set(paths)==set(pins),'loaded drop-in set differs')
            for name,digest in pins.items():
                identity=file_identity(name)
                require(identity[3]==self.state.owner_uid and not stat.S_IMODE(identity[2]) & 0o022
                        and core.digest(name)==digest,'loaded drop-in source changed')
        return True


class DurableState:
    def __init__(self, directory, owner_uid=0):
        self.directory=Path(directory);self.owner_uid=owner_uid
        require(self.directory.resolve(strict=True)==self.directory, 'state directory not canonical')
        info=self.directory.stat()
        require(info.st_uid==owner_uid and stat.S_IMODE(info.st_mode)==0o755,'state directory must be owner-controlled 0755')
        self.directory_identity=(info.st_dev,info.st_ino)
        self.sentinel=self.directory/'installed-v1';self.app_hold=self.directory/'app-hold'
        self.maintenance_hold=self.directory/'maintenance-hold';self.journal=self.directory/'transition.json'
        require(file_identity(self.sentinel)[3]==owner_uid and self.sentinel.read_bytes()==b'bubblewash-release-gate-v1\n','installation sentinel missing or invalid')
    def check(self):
        info=self.directory.lstat()
        require((info.st_dev,info.st_ino)==self.directory_identity and stat.S_ISDIR(info.st_mode) and info.st_uid==self.owner_uid and stat.S_IMODE(info.st_mode)==0o755,'state directory changed')
        for path in (self.sentinel,self.app_hold,self.maintenance_hold,self.journal):
            if path.exists() or path.is_symlink():
                identity=file_identity(path)
                require(identity[3]==self.owner_uid and not stat.S_IMODE(identity[2]) & 0o022,'unsafe durable file')
        require(self.sentinel.read_bytes()==b'bubblewash-release-gate-v1\n','installation sentinel changed')
    def hold(self):
        self.check()
        # Independent holds: clearing app permission must never enable maintenance.
        atomic_write(self.maintenance_hold,b'held\n');atomic_write(self.app_hold,b'held\n')
    def record(self, phase, plan_hash, target=None):
        self.check();atomic_write(self.journal,json.dumps({'schema':1,'phase':phase,'planHash':plan_hash,'target':str(target) if target else None},sort_keys=True).encode())
    def read(self):
        self.check();return json.loads(self.journal.read_bytes())
    def allow_app(self):
        self.check();require(self.maintenance_hold.exists(),'maintenance must remain inhibited')
        require(self.read()['phase'] in ('TARGET_SELECTED','FALLBACK_SELECTED'),'no durable compatible target selection')
        self.app_hold.unlink();fsync_dir(self.directory)


def owner_compatible(target, manifest, contract):
    require(contract.get('reviewed') is True and isinstance(contract.get('evidenceSha256'),str)
            and len(contract['evidenceSha256'])==64,'reviewed owner contract missing')
    required={'src/lib/auth.ts','src/lib/admin-mfa.ts','src/lib/staff-accounts.ts'}
    require(required.issubset(contract.get('files',{})),'owner contract incomplete')
    for name,value in contract['files'].items():
        require(manifest['files'].get(name)==value and core.digest(Path(target)/name)==value,'target is not owner-compatible')


def durable_pointer(current,target):
    core.switch_pointer(current,target);fsync_dir(Path(current).parent)


class Controller:
    """Minimal durable orchestration. All starts go through installed unit gates."""
    def __init__(self,plan,state,guard,service,quiescent,migrate,verify_database,readiness,verify_gates,hook=lambda _:None):
        self.plan=plan;self.state=state;self.guard=guard;self.service=service;self.quiescent=quiescent
        self.migrate=migrate;self.verify_database=verify_database;self.readiness=readiness;self.verify_gates=verify_gates;self.hook=hook
        self.plan_hash=hashlib.sha256(json.dumps(plan,sort_keys=True).encode()).hexdigest()
    def pins(self):
        require(hashlib.sha256(json.dumps(self.plan,sort_keys=True).encode()).hexdigest()==self.plan_hash,'release plan mutated')
        roots=[Path(self.plan[key]) for key in ('old','candidate','fallback')]
        require(len(set(roots))==3 and all(path.is_dir() and not path.is_symlink() and path.resolve(strict=True)==path for path in roots),'release roots must be independent and canonical')
        require(Path(self.plan['current']).is_symlink(),'current must remain symlink')
        database=Path(self.plan['database']);snapshot=Path(self.plan['snapshot'])
        require(database.is_absolute() and database.resolve(strict=True)==database and not any(database.is_relative_to(root) for root in roots),'unstable database path')
        require(snapshot.is_absolute() and snapshot!=database and not any(snapshot.is_relative_to(root) for root in roots),'unsafe snapshot path')
        required_helpers={str(Path(__file__).resolve()),str(Path(core.__file__).resolve())}
        require(required_helpers.issubset(self.plan.get('controllerPins',{})),'controller/helper pins missing')
        for name,digest in self.plan['controllerPins'].items():require(core.digest(name)==digest,'controller/helper changed')
        require(self.guard() is True,'host lock/backup/config not verified')
        require(getattr(self.guard,'database_path',None)==Path(self.plan['database']),'guarded database not bound to plan')
        require(getattr(self.guard,'marker_path',None)==Path(self.plan['marker']),'guarded release marker not bound to plan')
        self.state.check();require(self.verify_gates() is True,'effective installed gates not verified')
        require(self.plan.get('externalInvokersExcluded') is True,'external invokers not excluded')
        for key in ('candidate','fallback'):
            target=Path(self.plan[key]);manifest=self.plan['manifests'][key]
            require(manifest.get('releaseSha')==self.plan['releaseShas'][key],'release identity differs')
            core.verify_release(target,manifest);owner_compatible(target,manifest,self.plan['ownerContract'])
        db=Path(self.plan['database']);require(file_identity(db)[:2]==tuple(self.plan['databaseIdentity']),'database replaced')
    def phase(self,name,target=None):
        self.state.record(name,self.plan_hash,target);self.hook(name)
    def stop(self):
        errors=[]
        for manager,unit in core.UNITS:
            try:self.service(manager,'stop',unit)
            except BaseException as error:errors.append(error)
        require(self.quiescent() is True,'writers remain')
        if errors:raise errors[0]
    def inhibit(self):
        try:
            self.state.hold();self.hook('HOLDS_DURABLE')
        except BaseException:
            self.stop();raise
        self.stop()
    def select_start(self,key):
        target=Path(self.plan[key]);self.pins();require(self.verify_database(Path(self.plan['database'])) is True,'database acceptance missing')
        durable_pointer(Path(self.plan['current']),target);self.hook('POINTER_DURABLE')
        # Release marker is updated before permitting a boot/restart of this target.
        sha=self.plan['releaseShas'][key]
        require(len(sha)==40 and all(char in '0123456789abcdef' for char in sha),'invalid selected release SHA')
        marker=f'sha={sha}\nrelease={target.name}\npath={target}\n'.encode()
        atomic_write(Path(self.plan['marker']),marker,preserve_metadata=True)
        self.hook('MARKER_DURABLE')
        self.phase('TARGET_SELECTED' if key=='candidate' else 'FALLBACK_SELECTED',target)
        self.pins();require(Path(self.plan['current']).resolve(strict=True)==target and Path(self.plan['marker']).read_bytes()==marker,'selected pointer/marker drift')
        self.state.allow_app();self.hook('APP_HOLD_RELEASED')
        self.service('user','start',core.APP);self.hook('APP_STARTED')
        require(self.readiness(target) is True,'exact readiness missing');self.pins()
        require(Path(self.plan['current']).resolve(strict=True)==target and Path(self.plan['marker']).read_bytes()==marker,'ready pointer/marker drift')
        self.phase('CANDIDATE_READY' if key=='candidate' else 'FALLBACK_READY',target)
        return key+'-ready'
    def execute(self):
        self.pins();require(not self.state.journal.exists(),'unfinished or completed transaction requires explicit recovery/new plan')
        require(Path(self.plan['current']).resolve()==Path(self.plan['old']),'current target drift')
        old=Path(self.plan['old'])
        expected=f"sha={self.plan['oldSha']}\nrelease={old.name}\npath={old}\n".encode()
        require(Path(self.plan['marker']).read_bytes()==expected,'initial release marker differs')
        self.inhibit();self.phase('STOPPED')
        try:
            core.consistent_backup(Path(self.plan['database']),Path(self.plan['snapshot']))
            fd=os.open(self.plan['snapshot'],os.O_RDONLY|os.O_NOFOLLOW)
            try:os.fsync(fd)
            finally:os.close(fd)
            fsync_dir(Path(self.plan['snapshot']).parent)
            self.phase('BACKED_UP');self.pins();require(self.quiescent() is True,'quiescence lost')
            self.phase('MIGRATING');require(self.migrate(Path(self.plan['database'])) is True,'migration uncertain')
            self.hook('DB_COMMITTED');require(self.verify_database(Path(self.plan['database'])) is True,'migration not accepted')
            self.phase('MIGRATED');self.pins();require(self.quiescent() is True,'quiescence lost after migration')
            try:return self.select_start('candidate')
            except Exception:
                self.inhibit();self.pins();return self.select_start('fallback')
        except BaseException:
            self.inhibit();raise
    def recover(self):
        # Hold first even after a crash with an app already running. Never infer
        # safety from journal phase alone, and never restore a stale database.
        self.inhibit();record=self.state.read()
        require(record.get('schema')==1 and record.get('planHash')==self.plan_hash,'recovery plan differs')
        self.pins();require(self.verify_database(Path(self.plan['database'])) is True,'unknown/unmigrated database: leave held')
        # Migration-aware, owner-aware fallback is the only automated recovery.
        try:return self.select_start('fallback')
        except BaseException:
            self.inhibit();raise


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-test',action='store_true',required=True)
    parser.parse_args()
    return subprocess.call([sys.executable,'-m','unittest','-v','test_controller'],cwd=Path(__file__).parent)

if __name__=='__main__':raise SystemExit(main())
