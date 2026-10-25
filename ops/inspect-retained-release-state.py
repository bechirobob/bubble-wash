"""Fixed incident observation only. No controller invocation or database open."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess

STATE=Path('/var/lib/bubblewash-release')
RUNTIME=Path('/home/ubuntu/bubblewash-runtime')
CURRENT=Path('/home/ubuntu/bubblewash-pilot')
PLAN_ID='6a060a0b9950f874e2fb46db0739521b4b8be847903598928d03ff0094f81d7c'
PLAN_SHA='9c745a619732c53f3fe61a55de59cd4c10a24c714c4f1595d09642db099cb60b'
PHASES={'HELD','STOPPED','BACKED_UP','MIGRATING','MIGRATED','TARGET_SELECTED','FALLBACK_SELECTED','STARTED','ACCEPTED','FALLBACK_ACCEPTED','CANDIDATE_READY','FALLBACK_READY'}

def require(value):
    if not value:raise ValueError('inspection refused')

def identity(info):
    return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)

def read(path,limit=65536):
    path=Path(path);require(path.is_absolute() and path.resolve(strict=True)==path)
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as stream:
        before=os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_size<=limit and not before.st_mode&0o022)
        raw=stream.read(limit+1);require(len(raw)==before.st_size)
        require(identity(before)==identity(os.fstat(stream.fileno()))==identity(path.lstat()))
        return raw

def json_unique(raw):
    def pairs(rows):
        result=dict(rows);require(len(rows)==len(result));return result
    return json.loads(raw,object_pairs_hook=pairs)

def snapshot(path):
    require(path.parent==RUNTIME and path.name=='integration-snapshot-'+PLAN_ID[:16]+'.sqlite')
    if not os.path.lexists(path):return {'exists':False}
    require(path.resolve(strict=True)==path)
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as stream:
        before=os.fstat(stream.fileno());require(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_size<=2*1024**3 and not before.st_mode&0o077)
        digest=hashlib.sha256()
        for chunk in iter(lambda:stream.read(1024**2),b''):digest.update(chunk)
        require(identity(before)==identity(os.fstat(stream.fileno()))==identity(path.lstat()))
    return {'exists':True,'size':before.st_size,'sha256':digest.hexdigest(),'ownerUid':before.st_uid,'mode':stat.S_IMODE(before.st_mode)}

def unit(manager,name):
    args=['systemctl','show',name,'--property=LoadState,ActiveState,SubState,MainPID,ControlPID,Job']
    if manager=='user':
        args=['/usr/sbin/runuser','-u','ubuntu','--','/usr/bin/env','XDG_RUNTIME_DIR=/run/user/1000','DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',*args[:1],'--user',*args[1:]]
    result=subprocess.run(args,capture_output=True,timeout=15,check=False)
    require(result.returncode in (0,1) and len(result.stdout)<=8192)
    props=dict(line.split('=',1) for line in result.stdout.decode().splitlines() if '=' in line)
    require(props.get('LoadState') in ('loaded','not-found','error','masked') and props.get('ActiveState') in ('active','inactive','failed','activating','deactivating','reloading'))
    if name.endswith('.timer'):
        props.setdefault('MainPID','0');props.setdefault('ControlPID','0')
    require(all(re.fullmatch('[0-9]+',props.get(key,'')) for key in ('MainPID','ControlPID')))
    return {'loaded':props['LoadState']=='loaded','activeState':props['ActiveState'],'dead':props.get('SubState')=='dead',
            'mainPidPresent':props['MainPID']!='0','controlPidPresent':props['ControlPID']!='0',
            'jobPresent':bool(props.get('Job',''))}

def file_metadata(path):
    if not os.path.lexists(path):return {'exists':False}
    info=path.lstat()
    return {'exists':True,'ownerUid':info.st_uid,'groupGid':info.st_gid,
            'mode':stat.S_IMODE(info.st_mode),'size':info.st_size,
            'type':'regular' if stat.S_ISREG(info.st_mode) else 'symlink' if stat.S_ISLNK(info.st_mode) else 'other'}


def database_metadata(plan):
    result={}
    for key in ('database','snapshot'):
        path=Path(plan[key]);require(path.is_absolute() and '..' not in path.parts)
        result[key]={suffix or 'main':file_metadata(Path(str(path)+suffix)) for suffix in ('','-wal','-shm')}
    return result


def durable_hash(plan):
    # Exact read-only projection used by the already-pinned C10 durable_plan.
    names=('schema','oldSha','old','candidate','fallback','current','marker','state','database',
           'databaseIdentity','snapshot','releaseShas','manifests','dependencies','gitBindings',
           'sourceContractSha256','adapterFiles','ownerContract','ownerEvidenceSha256','ownerEvidencePath','node','units')
    value={name:plan[name] for name in names}
    value['guardIdentity']={name:plan['guards'][name] for name in ('envSha256','database')}
    acceptance=plan['hostAcceptance']
    value['invokerIdentity']={name:acceptance[name] for name in ('launcherAliases','knownInvokersSha256','riskApprovalSha256')}
    residual='Deployment coordinates the three known Bubble Wash units under the exclusive deployment lock and persistent holds. Privileged root, ubuntu and other operators or unknown invokers are not technically excluded; they must not write the database or launch Bubble Wash during the approved window.'
    value['coordinatedWriterHold']={'schema':'bubblewash-coordinated-writer-hold/v1',
        'knownUnits':['system/bubblewash-maintenance.timer','system/bubblewash-maintenance.service','user/bubblewash-local.service'],
        'knownInvokersSha256':acceptance['knownInvokersSha256'],'riskApprovalSha256':acceptance['riskApprovalSha256'],
        'residualAccessAcknowledged':True,'residualAssumptionSha256':hashlib.sha256(residual.encode()).hexdigest()}
    require(all(name in plan['adapterFiles'] for name in ('contracts.py','vendor/bubblewash-durable-controller/controller.py','vendor/bubblewash-migration-transition/transition.py')))
    package=STATE/'packages'/PLAN_ID
    value['controllerPins']={str(package/name):pin for name,pin in plan['adapterFiles'].items()}
    return hashlib.sha256(json.dumps(value,sort_keys=True).encode()).hexdigest()


def inspect():
    result={'schema':'bubblewash-execution-incident/v1','observationalOnly':True,'databaseOpened':False,'planVerified':False}
    plan=None
    def observe(key,fn):
        try:result[key]=fn()
        except BaseException:result[key]={'inspectionFailed':True}
    def plan_read():
        nonlocal plan
        raw=read(STATE/'plans'/(PLAN_ID+'.json'),8*1024**2)
        require(hashlib.sha256(raw).hexdigest()==PLAN_SHA)
        plan=json_unique(raw);require(type(plan) is dict)
        result['planVerified']=True
        return {'verified':True}
    observe('plan',plan_read)
    def holds():
        out={}
        for name in ('app-hold','maintenance-hold'):
            path=STATE/name
            out[name]={'exists':os.path.lexists(path)}
            if os.path.lexists(path):out[name]['valid']=read(path,128)==b'held\n'
        return out
    observe('holds',holds)
    def journal():
        path=STATE/'transition.json'
        if not os.path.lexists(path):return {'exists':False}
        value=json_unique(read(path));require(value.get('schema')==1 and value.get('phase') in PHASES)
        require(re.fullmatch('[a-f0-9]{64}',value.get('planHash','')))
        role=next((key for key in ('old','candidate','fallback') if plan and value.get('target')==plan.get(key)),None)
        expected=durable_hash(plan) if plan else None
        return {'exists':True,'phase':value['phase'],'planHash':value['planHash'],'derivedPlanHash':expected,'selectedRole':role,'matchesReviewedPlan':bool(expected and value['planHash']==expected)}
    observe('journal',journal)
    def pointer():
        require(CURRENT.is_symlink());target=str(CURRENT.resolve(strict=True))
        role=next((key for key in ('old','candidate','fallback') if plan and target==plan.get(key)),None)
        return {'knownRole':role,'knownTarget':role is not None}
    observe('pointer',pointer)
    def marker():
        raw=read(RUNTIME/'current-release',8192).decode();values=dict(line.split('=',1) for line in raw.splitlines() if '=' in line)
        sha=values.get('sha','');require(re.fullmatch('[a-f0-9]{40}',sha))
        return {'sha':sha,'matchesPointerRole':bool(plan and CURRENT.is_symlink() and values.get('path')==str(CURRENT.resolve(strict=True)) and any(values.get('path')==plan.get(key) and values.get('release')==Path(plan[key]).name and sha==(plan.get('oldSha') if key=='old' else plan.get('releaseShas',{}).get(key)) for key in ('old','candidate','fallback')))}
    observe('marker',marker)
    observe('databaseFileMetadata',lambda:database_metadata(plan) if plan else {'unavailableWithoutVerifiedPlan':True})
    observe('snapshot',lambda:snapshot(Path(plan['snapshot'])) if plan else {'unavailableWithoutVerifiedPlan':True})
    for manager,name in (('system','bubblewash-maintenance.timer'),('system','bubblewash-maintenance.service'),('user','bubblewash-local.service')):
        observe(manager+'/'+name,lambda manager=manager,name=name:unit(manager,name))
    return result

if __name__=='__main__':
    require(os.geteuid()==0)
    print(json.dumps(inspect(),sort_keys=True))
