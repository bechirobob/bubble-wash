"""Fixed original-service recovery. Never invokes migration/controller recovery."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys
import time
import types

STATE=Path('/var/lib/bubblewash-release')
PLAN_ID='1f28e00f3ba8fd417d5d309718fd23337efad44e0fab604e1d287c246cf8a965'
PLAN_SHA='eb9ef6e246eac1db04c75c6ea3f4f02905cf6129c90f6c930575f703ca232e66'
BACKUP={'archiveSha256':'498d4ca330db048fed33a640324eaaf58e6c56d6d58cd892c39d865b67cd7433',
        'receiptRun':'40168180719','storeSha':'2fe787ae243bb8eb82827e224be87ed00796fccc','storeId':1403152795}

def require(value):
    if not value:raise ValueError('recovery guard refused')

def digest(raw):return hashlib.sha256(raw).hexdigest()

def read(path, owner=0, limit=16*1024**2):
    path=Path(path);require(path.is_absolute() and path.resolve(strict=True)==path)
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as stream:
        before=os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_uid==owner and not before.st_mode&0o022 and before.st_size<=limit)
        raw=stream.read(limit+1)
        fields=lambda s:(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
        require(len(raw)==before.st_size and fields(before)==fields(os.fstat(stream.fileno()))==fields(path.lstat()))
        return raw

def unique(raw):
    def pairs(rows):
        value=dict(rows);require(len(value)==len(rows));return value
    return json.loads(raw,object_pairs_hook=pairs)

def validate_request(request,plan):
    require(type(request) is dict and set(request)=={'action','runId','operatorReviewReference','riskApprovalSha256','backup'})
    require(request['action'] in ('inspect','restore-original') and type(request['runId']) is str and re.fullmatch('[1-9][0-9]{0,19}',request['runId']))
    require(all(type(request[k]) is str and re.fullmatch('[a-f0-9]{64}',request[k]) for k in ('operatorReviewReference','riskApprovalSha256')))
    require(request['riskApprovalSha256']==plan['hostAcceptance']['riskApprovalSha256'] and request['backup']==BACKUP)

def load_original(preparation_source):
    raw=read(STATE/'plans'/(PLAN_ID+'.json'));require(digest(raw)==PLAN_SHA);plan=unique(raw)
    package=STATE/'packages'/PLAN_ID
    for parent in (package,*package.parents):
        info=parent.lstat();require(stat.S_ISDIR(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022)
    files=plan['adapterFiles'];require(type(files) is dict)
    actual=set()
    for path in package.rglob('*'):
        require(not path.is_symlink() and '__pycache__' not in path.parts and path.suffix not in ('.pyc','.pyo'))
        if path.is_file():actual.add(path.relative_to(package).as_posix())
    require(actual==set(files)|{'source-contracts.json'})
    for name,pin in files.items():
        require(not Path(name).is_absolute() and '..' not in Path(name).parts and digest(read(package/name))==pin)
    require(digest(read(package/'source-contracts.json'))==plan['sourceContractSha256'])
    require('contracts' not in sys.modules and 'host_adapter' not in sys.modules)
    sys.dont_write_bytecode=True;sys.path.insert(0,str(package))
    import contracts
    import host_adapter as adapter
    require(Path(contracts.__file__).resolve()==package/'contracts.py' and Path(adapter.__file__).resolve()==package/'host_adapter.py')
    require(type(preparation_source) is bytes and digest(preparation_source)==contracts.PREPARATION_HELPER_SHA256)
    prepare=types.ModuleType('integration_preparation');prepare.__file__='<authenticated-original-preparation>'
    exec(compile(preparation_source,prepare.__file__,'exec'),prepare.__dict__)
    prepare.__source_sha256__=digest(preparation_source)
    return plan,adapter,adapter.load_controller(),prepare

def verify_units(host,state):
    mapping={}
    for manager,unit in host.c.core.UNITS:
        entry=host.plan['units'][manager+'/'+unit]
        props=host.c.core.parse_properties(host.show(manager,unit))
        require(props.get('LoadState')=='loaded')
        require(all(props.get(k,'')==v for k,v in entry['properties'].items()))
        if unit!=host.c.core.TIMER:require(host.exec_start(manager,unit)==entry['execStart'])
        require(set(entry['files'])=={entry['properties']['FragmentPath'],*entry['dropins']})
        for name,pin in entry['files'].items():
            owner=0 if name in entry['dropins'] or manager=='system' else entry['fragmentUid']
            require(digest(read(name,owner))==pin)
        mapping[(manager,unit)]=entry['dropins']
    require(host.c.LoadedGates(state,host.c.SystemdReader(host.uid,host.run),mapping)() is True)

def quiet(host,adapter):
    for manager,unit in host.c.core.UNITS:
        props=host.c.core.parse_properties(host.show(manager,unit))
        require(props.get('LoadState')=='loaded' and not props.get('Job',''))
        if unit==host.c.core.APP:require(props.get('ActiveState') in ('inactive','failed'))
        else:require(props.get('ActiveState')=='inactive' and props.get('SubState')=='dead')
        if unit!=host.c.core.TIMER:
            require(props.get('MainPID')=='0' and props.get('ControlPID')=='0')
            name=props.get('ControlGroup','')
            if name:
                require(name.startswith('/') and '..' not in Path(name).parts)
                group=host.cgroup/name.lstrip('/')
                require(group.resolve()==group and group.is_relative_to(host.cgroup))
                if group.exists():
                    for path in (group,*group.rglob('*')):
                        require(not path.is_symlink())
                        if path.is_dir():require(not (path/'cgroup.procs').read_text().strip())
    require(not adapter.release_processes(host.scan_roots,host.proc,host.uid))
    require(host.run(['ss','-H','-ltnp','sport = :3000'])=='')

def database_pin(database,uid):
    result={}
    for suffix in ('','-wal','-shm'):
        path=Path(str(database)+suffix);info=path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid==uid and info.st_gid==uid and stat.S_IMODE(info.st_mode)==0o600 and info.st_nlink==1)
        result[suffix]={'identity':(info.st_dev,info.st_ino),'mode':stat.S_IMODE(info.st_mode),'uid':info.st_uid}
        if suffix!='-shm':result[suffix]['sha256']=digest(read(path,uid,2*1024**3))
    return result

def recover(request,plan,adapter,c,prepare):
    validate_request(request,plan)
    stage='VALIDATE_ORIGINAL';released=False;host=None;state=None
    try:
        adapter.validate_plan(plan)
        host=adapter.Host(plan,c);state=c.DurableState(STATE)
        raw=read(adapter.ENV,host.uid);receipt_raw=read(adapter.RECEIPT,host.uid)
        require(digest(raw)==plan['guards']['envSha256'])
        expected={**plan['guards'],**request['backup'],'receiptSha256':digest(receipt_raw)}
        guard=c.HostGuards(adapter.RUNTIME,adapter.ENV,adapter.RECEIPT,expected,host.uid)
        with guard.locked() as verify_guard:
            stage='CURRENT_BINDINGS'
            issued=int(time.time());expires=issued+1800
            boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
            machine=digest(read('/etc/machine-id'))
            inventory=host.inventory()
            old=Path(plan['old']);database=Path(plan['database'])
            marker=read(adapter.RUNTIME/'current-release',host.uid)
            expected_marker=f"sha={plan['oldSha']}\nrelease={old.name}\npath={old}\n".encode()
            require(marker==expected_marker)
            old_files=prepare.source_files(old,host.uid)
            require(prepare.git_tree(old_files)==__import__('contracts').LIVE_TREE)
            require(read(old/'.release-sha',host.uid,128).decode().strip()==plan['oldSha'])
            original_db=database_pin(database,host.uid)
            require(tuple(original_db['']['identity'])==tuple(plan['databaseIdentity']))
            def bound(stopped=True):
                require(time.time()<expires and Path('/proc/sys/kernel/random/boot_id').read_text().strip()==boot and digest(read('/etc/machine-id'))==machine)
                verify_guard();adapter.validate_plan(plan);state.check()
                require(not os.path.lexists(state.journal) and not any(os.path.lexists(str(plan['snapshot'])+s) for s in ('','-wal','-shm')))
                require(adapter.CURRENT.is_symlink() and adapter.CURRENT.resolve(strict=True)==old and read(adapter.RUNTIME/'current-release',host.uid)==marker)
                require(prepare.source_files(old,host.uid)==old_files and host.inventory()==inventory)
                require(read(state.maintenance_hold)==b'held\n')
                verify_units(host,state)
                if stopped:
                    require(read(state.app_hold)==b'held\n');quiet(host,adapter)
                    require(database_pin(database,host.uid)==original_db)
            bound()
            stage='READONLY_PREMIGRATION'
            host.acknowledgement(host.feature(database,'--preflight'),{'ok':True,'status':'exact-pre-migration-ready','databaseChanged':False})
            bound()
            if request['action']=='inspect':return {'ok':True,'stage':'ORIGINAL_RESTART_ELIGIBLE','serviceStarted':False,'databaseChanged':False}
            stage='RECOVERY_RECEIPT'
            audit_root=STATE/'original-recovery'
            if not os.path.lexists(audit_root):audit_root.mkdir(mode=0o700)
            require(audit_root.resolve()==audit_root and audit_root.stat().st_uid==0 and stat.S_IMODE(audit_root.stat().st_mode)==0o700)
            audit=audit_root/request['runId'];audit.mkdir(mode=0o700)
            proof={'schema':'bubblewash-original-recovery/v1','originalPlanSha256':PLAN_SHA,'issuedAt':issued,'expiresAt':expires,
                   'hostMachineIdSha256':machine,'bootId':boot,'knownInvokersSha256':adapter.object_digest(inventory),
                   'request':request,'preMigrationVerified':True,'liveBytesUnchanged':True,
                   'residualAccessAcknowledged':True,'residualAssumptionSha256':__import__('contracts').RESIDUAL_ASSUMPTION_SHA256}
            with (audit/'approval.json').open('xb') as stream:
                os.fchmod(stream.fileno(),0o600);stream.write(json.dumps(proof,sort_keys=True).encode());stream.flush();os.fsync(stream.fileno())
            c.fsync_dir(audit);c.fsync_dir(audit_root)
            bound();stage='START_ORIGINAL'
            try:
                state.app_hold.unlink();released=True;c.fsync_dir(STATE)
                host.service('user','start',c.core.APP)
                stage='VERIFY_ORIGINAL'
                require(host.readiness(old) is True)
                bound(stopped=False)
                require(not state.app_hold.exists())
                return {'ok':True,'stage':'ORIGINAL_READY','serviceStarted':True,'maintenanceHeld':True,'databaseRestored':False}
            except BaseException:
                stage='REHOLD_ORIGINAL'
                restored=False;stopped=False
                try:c.atomic_write(state.app_hold,b'held\n');restored=True
                finally:
                    try:host.service('user','stop',c.core.APP);stopped=True
                    except BaseException:pass
                return {'ok':False,'stage':stage,'appHoldRestored':restored,'stopCompleted':stopped,'automaticRetry':False}
    except BaseException:
        return {'ok':False,'stage':stage,'appHoldReleased':released,'automaticRetry':False,'inspectBeforeRetry':True}

def main(request,preparation_source):
    require(os.geteuid()==0)
    def interrupted(*_):raise KeyboardInterrupt()
    previous={sig:signal.signal(sig,interrupted) for sig in (signal.SIGTERM,signal.SIGHUP)}
    try:
        plan,adapter,c,prepare=load_original(preparation_source)
        result=recover(request,plan,adapter,c,prepare)
        print(json.dumps(result,sort_keys=True),flush=True)
        return result
    finally:
        for sig,handler in previous.items():signal.signal(sig,handler)


PREPARATION_SHA='c9d8329ec106562ad900b0326774a2ea8c7e7808013d087421fb8b3e8694f7e7'

def emit(action,request,source,preparation):
    import base64
    require(action in ('inspect','restore-original') and request.get('action')==action)
    require(len(json.dumps(request))<=8192 and digest(preparation)==PREPARATION_SHA)
    encoded=lambda raw:repr(base64.b64encode(raw).decode())
    return "import base64,json,sys\nsys.dont_write_bytecode=True\ntry:\n namespace={'__name__':'bubblewash_original_recovery'}\n exec(compile(base64.b64decode("+encoded(source)+"),'<reviewed-original-recovery>','exec'),namespace)\n result=namespace['main'](json.loads(base64.b64decode("+encoded(json.dumps(request).encode())+")),base64.b64decode("+encoded(preparation)+"))\nexcept BaseException:\n print(json.dumps({'ok':False,'stage':'RECOVERY_LOADER_REFUSED','automaticRetry':False}),flush=True)\n raise SystemExit(1)\nraise SystemExit(0 if result.get('ok') is True else 1)\n"


def cli():
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--emit',action='store_true',required=True)
    parser.add_argument('--action',choices=('inspect','restore-original'),required=True)
    parser.add_argument('--request-json',type=Path,required=True);parser.add_argument('--preparation-source',type=Path,required=True)
    args=parser.parse_args();raw=args.request_json.read_bytes();require(len(raw)<=8192)
    print(emit(args.action,unique(raw),Path(__file__).read_bytes(),args.preparation_source.read_bytes()))

if __name__=='__main__':cli()
