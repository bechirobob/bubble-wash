"""Bounded read-only host evidence collector. No HTTP, SSH, service changes or DB writes."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import selectors
import time

HERE=Path(__file__).resolve().parent
if 'uat_restore_preflight' in sys.modules:
    p=sys.modules['uat_restore_preflight']
else:
    spec=importlib.util.spec_from_file_location('uat_restore_preflight',HERE/'restoration-preflight.py')
    p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
require=p.require
PROPERTIES=('ActiveState SubState FragmentPath DropInPaths User Group WorkingDirectory NoNewPrivileges ProtectSystem ProtectHome PrivateTmp PrivateDevices ProtectKernelTunables ProtectKernelModules ProtectKernelLogs ProtectControlGroups ProtectClock RestrictSUIDSGID RestrictRealtime LockPersonality RestrictNamespaces CapabilityBoundingSet AmbientCapabilities ReadWritePaths BindPaths InaccessiblePaths RestrictAddressFamilies IPAddressDeny IPAddressAllow SystemCallFilter SystemCallErrorNumber SocketBindDeny SocketBindAllow EnvironmentFiles UMask MainPID ControlGroup NeedDaemonReload').split()
BOOLS=set('NoNewPrivileges ProtectHome PrivateTmp PrivateDevices ProtectKernelTunables ProtectKernelModules ProtectKernelLogs ProtectControlGroups ProtectClock RestrictSUIDSGID RestrictRealtime LockPersonality RestrictNamespaces NeedDaemonReload'.split())
LISTS=set('CapabilityBoundingSet AmbientCapabilities ReadWritePaths InaccessiblePaths RestrictAddressFamilies IPAddressDeny IPAddressAllow SocketBindDeny SocketBindAllow'.split())
PRODUCTION_ENV=Path('/home/ubuntu/.config/bubblewash/env')
PRODUCTION_CURRENT=Path('/home/ubuntu/bubblewash-pilot')


def read(path,limit=65536):
    # proc pseudo-files report size 0; bound the actual read as well.
    with open(path,'rb') as stream: raw=stream.read(limit+1)
    require(len(raw)<=limit)
    return raw


def command(args,limit=65536):
    # All callers use fixed executable/flags; never accept a shell or command in input.
    process=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
        env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'})
    selector=selectors.DefaultSelector();output={process.stdout:bytearray(),process.stderr:bytearray()}
    for stream in output:selector.register(stream,selectors.EVENT_READ)
    deadline=time.monotonic()+15
    try:
        while selector.get_map():
            require(time.monotonic()<deadline)
            for key,_ in selector.select(.1):
                chunk=os.read(key.fileobj.fileno(),4096)
                if not chunk:selector.unregister(key.fileobj);continue
                output[key.fileobj].extend(chunk);require(len(output[key.fileobj])<=limit)
        require(process.wait(timeout=1)==0)
        return bytes(output[process.stdout]).decode('utf-8')
    finally:
        selector.close()
        if process.poll() is None:process.kill();process.wait()
        process.stdout.close();process.stderr.close()



def normalize(raw):
    require(len(raw)<=65536)
    values={}
    for line in raw.splitlines():
        key,sep,value=line.partition('=');require(sep and key in PROPERTIES and key not in values);values[key]=value
    require(set(values)==set(PROPERTIES))
    result={}
    for key,value in values.items():
        if key in BOOLS:
            require(value in ('yes','no'));result[key]=value=='yes'
        elif key in LISTS:
            tokens=value.split()
            if key=='InaccessiblePaths': tokens=[x.removeprefix('-') for x in tokens]
            require(len(set(tokens))==len(tokens));result[key]=sorted(tokens)
        elif key=='MainPID':require(re.fullmatch('[1-9][0-9]*',value));result[key]=int(value)
        elif key=='BindPaths':
            require(value in (p.DATA+'/cache:'+p.APP+'/.next/cache',p.DATA+'/cache:'+p.APP+'/.next/cache:rbind'))
            result[key]=[[p.DATA+'/cache',p.APP+'/.next/cache']]
        elif key=='EnvironmentFiles':
            require(value==p.ENVIRONMENT+' (ignore_errors=no)');result[key]=[p.ENVIRONMENT]
        elif key=='SystemCallFilter':
            require(value=='~connect');result['SystemCallFilterDeny']=['connect']
        elif key=='SystemCallErrorNumber':
            require(value in ('1','EPERM'));result[key]='EPERM'
        else:result[key]=value
    require(result['NeedDaemonReload'] is False)
    return result


def show():
    return normalize(command(['/usr/bin/systemctl','show',p.SERVICE,*[v for name in PROPERTIES for v in ('-p',name)]]))


def trusted(path,owner=0,directory=False,mode=None):
    path=Path(path);require(path.is_absolute() and path.resolve(strict=True)==path)
    for parent in path.parents:
        info=parent.lstat();require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0,owner) and not info.st_mode&0o022)
    info=path.lstat()
    require(info.st_uid==owner and not info.st_mode&0o022)
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink==1)
    if mode is not None:require(stat.S_IMODE(info.st_mode)==mode)
    return (info.st_dev,info.st_ino,info.st_mtime_ns,info.st_ctime_ns)


def start(pid):
    raw=read('/proc/'+str(pid)+'/stat',8192).decode()
    close=raw.rfind(')');require(close>0)
    fields=raw[close+2:].split();require(len(fields)>=20 and fields[19].isdigit())
    return int(fields[19])


def process_evidence(properties):
    pid=properties['MainPID'];base=Path('/proc')/str(pid)
    initial=start(pid)
    status={}
    for line in read(base/'status').decode().splitlines():
        key,sep,value=line.partition(':');require(sep and key not in status);status[key]=value.strip()
    cgroup=read(base/'cgroup',8192).decode().splitlines();require(len(cgroup)==1 and cgroup[0].startswith('0::'))
    lines=command(['/usr/bin/ss','-H','-ltnp','sport = :3108']).splitlines()
    require(len(lines)==1 and '127.0.0.1:3108' in lines[0] and ('pid='+str(pid)+',') in lines[0])
    # Unknown or additional socket owners fail, including SO_REUSEPORT listeners.
    require(re.findall(r'pid=(\d+),',lines[0])==[str(pid)])
    executable=os.readlink(base/'exe');require(executable=='/usr/bin/node')
    require(os.stat(base/'exe').st_ino==os.stat('/usr/bin/node').st_ino and os.stat(base/'exe').st_dev==os.stat('/usr/bin/node').st_dev)
    result={'pid':pid,'uids':[int(x) for x in status['Uid'].split()], 'gids':[int(x) for x in status['Gid'].split()],
        'groups':sorted(int(x) for x in status['Groups'].split()),'cwd':os.readlink(base/'cwd'),'executable':executable,
        'NoNewPrivs':int(status['NoNewPrivs']),'Seccomp':int(status['Seccomp']),'effectiveCapabilities':int(status['CapEff'],16),
        'cgroup':cgroup[0][3:],'listeners':[{'address':'127.0.0.1','port':3108,'pid':pid}]}
    require(start(pid)==initial)
    return result,initial


def production_inventory():
    owner=pwd.getpwnam('ubuntu')
    trusted(PRODUCTION_ENV,owner.pw_uid,mode=0o600)
    values=p.parse_environment(read(PRODUCTION_ENV,16384))
    # Only this value is used privately. No production data is opened or logged.
    db=Path(values.get('BUBBLEWASH_DATABASE_PATH',''))
    require(db.is_absolute() and '..' not in db.parts)
    database=db.resolve(strict=True);require(database.is_file())
    current=PRODUCTION_CURRENT.resolve(strict=True);require(current.is_dir())
    require(not (current==Path(p.APP) or database==Path(p.DATABASE)))
    prefix=['/usr/sbin/runuser','-u','ubuntu','--','/usr/bin/env',
        'XDG_RUNTIME_DIR=/run/user/'+str(owner.pw_uid),
        'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/'+str(owner.pw_uid)+'/bus',
        '/usr/bin/systemctl','--user']
    raw=command(prefix+['show','bubblewash-local.service','-p','MainPID','-p','ActiveState'])
    values=dict(line.split('=',1) for line in raw.splitlines())
    require(values.get('ActiveState')=='active' and re.fullmatch('[1-9][0-9]*',values.get('MainPID','')))
    pid=int(values['MainPID']);ticks=start(pid)
    require(Path(os.readlink('/proc/'+str(pid)+'/cwd')).resolve()==current)
    actual={}
    for entry in read('/proc/'+str(pid)+'/environ').rstrip(b'\0').split(b'\0'):
        key,sep,value=entry.partition(b'=');require(sep and key not in actual);actual[key]=value
    require(actual.get(b'BUBBLEWASH_DATABASE_PATH',b'').decode()==str(db))
    require(start(pid)==ticks)
    # Whole known protected roots also cover retained/inactive staging directories.
    return sorted(set([str(current),str(database.parent),str(database),str(PRODUCTION_ENV.resolve()),
        '/home/ubuntu','/var/lib/bubblewash','/opt/bubblewash','/etc/bubblewash','/var/lib/bubblewash-release']))



def collect(pins,eligible=True,private=False):
    require(os.geteuid()==0)
    require(set(pins)=={'runtimeRevision','runtimeFiles','unitSha256'})
    account=pwd.getpwnam('bubblewash-uat')
    require(account.pw_uid>0 and account.pw_gid>0 and account.pw_shell=='/usr/sbin/nologin' and account.pw_dir==p.DATA)
    props=show();process,ticks=process_evidence(props);pid=process['pid']
    config_objects={}
    for name in ('SOURCE_REVISION',*p.PIN_FILES): config_objects[str(Path(p.APP)/name)]=trusted(Path(p.APP)/name)
    config_objects[p.UNIT]=trusted(p.UNIT)
    config_objects[p.ENVIRONMENT]=trusted(p.ENVIRONMENT,mode=0o600)
    trusted(p.APP,directory=True);trusted(p.DATA,account.pw_uid,directory=True)
    trusted(Path(p.DATA)/'cache',account.pw_uid,directory=True)
    db_identity=trusted(p.DATABASE,account.pw_uid,mode=0o600)
    for suffix in ('-wal','-shm'):
        sibling=Path(p.DATABASE+suffix)
        if os.path.lexists(sibling):trusted(sibling,account.pw_uid,mode=0o600)
    boot=re.search(r'^btime ([0-9]+)$',read('/proc/stat').decode(),re.M);require(boot)
    started_ns=(int(boot[1])*1000000000)+(ticks*1000000000//os.sysconf('SC_CLK_TCK'))
    # Reject file replacement/reload after the process started. Not an outbound probe.
    require(all(max(info[2:])<=started_ns for info in config_objects.values()))
    parts=[p.verify_runtime(p.APP,p.UNIT,pins['runtimeRevision'],pins['runtimeFiles'],pins['unitSha256']),
        p.verify_environment(read(p.ENVIRONMENT,16384),read('/proc/'+str(pid)+'/environ')),
        p.verify_service(props,process,account.pw_uid,account.pw_gid)]
    production=production_inventory()
    for item in production:
        if os.path.exists(item):
            other=os.stat(item);require((other.st_dev,other.st_ino)!=db_identity[:2])
    parts.append(p.verify_storage_isolation([p.APP,p.DATA,p.DATABASE,p.ENVIRONMENT],production,
        read('/proc/self/mountinfo',1048576).decode(),read('/proc/'+str(pid)+'/mountinfo',1048576).decode()))
    parts.append(p.inspect_accounts(p.DATABASE,require_eligible=eligible))
    require(show()==props and start(pid)==ticks and production_inventory()==production)
    require(trusted(p.DATABASE,account.pw_uid,mode=0o600)[:2]==db_identity[:2])
    require(all(trusted(path,mode=0o600 if path==p.ENVIRONMENT else None)==identity for path,identity in config_objects.items()))
    merged={'ok':True,'readOnly':True,'automaticRetry':False,'filesystemObjectsVerified':True}
    for part in parts:merged.update(part)
    # Explicitly reject any accidental private field in the outward receipt.
    boolean={'ok','readOnly','automaticRetry','filesystemObjectsVerified','installedRuntimeVerified','runtimeSourcesVerified','unitSourceVerified','configuredEnvironmentVerified','runningEnvironmentVerified','providerCredentialsAbsent','runningServiceIdentityVerified','effectiveSandboxVerified','loopbackListenerVerified','mountBackingsIndependent','runningNamespaceStorageVerified','originalCohortEligible'}
    counts={'originalRoleCount','totalAccountCount','revokedAccountCount'}
    require(set(merged)<=boolean|counts|{'runtimeRevision'})
    for key,value in merged.items():
        require(type(value) is bool if key in boolean else type(value) is int and 0<=value<=1000 if key in counts else re.fullmatch('[a-f0-9]{40}',value))
    if private:
        evidence={'database':{'device':str(db_identity[0]),'inode':str(db_identity[1])},
            'pid':pid,'startTicks':ticks,'configObjects':config_objects,'productionPaths':production,
            'serviceProperties':props}
        return {'public':merged,'private':evidence}
    return merged


if __name__=='__main__':
    # Source verification and transport are separate; no default host invocation.
    print('{"ok":false,"readOnly":true,"automaticRetry":false,"entrypointEnabled":false}')
    raise SystemExit(1)
