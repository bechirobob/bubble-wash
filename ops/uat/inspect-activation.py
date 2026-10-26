#!/usr/bin/env python3
"""Read-only, bounded, fixed-schema UAT diagnostics; no env, journal or DB contents."""
import json
import os
from pathlib import Path
import re
import stat
import subprocess

SERVICE='bubblewash-uat.service'
UNIT=Path('/etc/systemd/system/'+SERVICE)
DATA=Path('/var/lib/bubblewash-uat')
CONFIG=Path('/etc/bubblewash-uat')
PROPERTIES=('LoadState','ActiveState','SubState','Result','ExecMainCode','ExecMainStatus','MainPID')
STAGES={'verification','unit-verification','daemon-reload','isolation-probe','synthetic-seed','synthetic-priority','environment-enable','service-start','http-checks','listener-check','complete'}

def command(args):
    try:
        result=subprocess.run(args,stdin=subprocess.DEVNULL,capture_output=True,timeout=15,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'})
        if len(result.stdout)>65536 or len(result.stderr)>65536:return {'code':None,'out':'','err':'','failure':'output-limit'}
        return {'code':result.returncode,'out':result.stdout.decode(errors='replace'),'err':result.stderr.decode(errors='replace'),'failure':None}
    except subprocess.TimeoutExpired:return {'code':None,'out':'','err':'','failure':'timeout'}
    except OSError:return {'code':None,'out':'','err':'','failure':'unavailable'}

def unit_state(name):
    raw=command(['/usr/bin/systemctl','show',name,*[item for key in PROPERTIES for item in ('-p',key)]])
    parsed=dict(line.split('=',1) for line in raw['out'].splitlines() if '=' in line)
    values={key:(parsed.get(key) if re.fullmatch(r'[A-Za-z0-9_-]{1,48}',parsed.get(key,'')) else None) for key in PROPERTIES}
    return {'commandExit':raw['code'],'inspectionFailure':raw['failure'],**values}

def marker():
    path=CONFIG/'activation-started.json'
    if not os.path.lexists(path):return {'present':False,'safe':True,'stage':None}
    info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o077 or info.st_size>4096:return {'present':True,'safe':False,'stage':None}
    try:
        value=json.loads(path.read_bytes())
        return {'present':True,'safe':True,'stage':value.get('stage') if value.get('stage') in STAGES else 'legacy-unrecorded'}
    except (ValueError,OSError):return {'present':True,'safe':False,'stage':None}

def data_summary():
    if DATA.is_symlink() or not DATA.is_dir():return {'safe':False}
    entries=list(DATA.iterdir())
    expected={'cache','uat.sqlite','uat.sqlite-shm','uat.sqlite-wal','.isolation-write-probe'}
    return {'safe':not any(p.is_symlink() for p in entries),'entryCount':len(entries),
            'knownEntries':{name:any(p.name==name for p in entries) for name in sorted(expected)},
            'otherEntryCount':sum(p.name not in expected for p in entries)}

def verification():
    raw=command(['/usr/bin/systemd-analyze','verify',str(UNIT)])
    text=raw['err']+raw['out']
    # Only fixed classifications leave the host; never print arbitrary diagnostic text.
    return {'exit':raw['code'],'inspectionFailure':raw['failure'],
        'unknownDirective':bool(re.search(r'Unknown (?:key|lvalue|section)',text,re.I)),
        'invalidSetting':bool(re.search(r'(?:Failed to parse|Invalid argument|Invalid setting)',text,re.I)),
        'missingExecutable':bool(re.search(r'(?:not executable|No such file|not found)',text,re.I)),
        'dependencyFailure':bool(re.search(r'(?:Dependency|Failed to create)',text,re.I))}

def path_permissions():
    result={}
    for name in ('/opt/bubblewash-uat','/opt/bubblewash-uat/app','/opt/bubblewash-uat/app/.next','/opt/bubblewash-uat/app/.next/cache','/var/lib/bubblewash-uat','/var/lib/bubblewash-uat/cache','/etc/bubblewash-uat','/etc/bubblewash-uat/environment'):
        try:
            info=Path(name).lstat()
            result[name]={'exists':True,'mode':stat.S_IMODE(info.st_mode),'uid':info.st_uid,'gid':info.st_gid,'symlink':stat.S_ISLNK(info.st_mode)}
        except FileNotFoundError:result[name]={'exists':False}
    return result

def inspect():
    state=unit_state(SERVICE)
    listeners=command(['/usr/bin/ss','-H','-ltnp','sport = :3108'])
    lines=listeners['out'].splitlines()
    version=command(['/usr/bin/systemd','--version']);match=re.match(r'systemd (\d+)\b',version['out'])
    return {'schema':'bubblewash-uat-activation-inspection/v1','readOnly':True,'systemdVersion':int(match[1]) if match else None,
        'service':state,'probe':unit_state('bubblewash-uat-isolation-check.service'),'seed':unit_state('bubblewash-uat-seed.service'),
        'listener':{'inspectionFailure':listeners['failure'],'commandExit':listeners['code'],'count':len(lines),
            'loopbackOnly':len(lines)==1 and '127.0.0.1:3108' in lines[0],
            'matchesMainPid':len(lines)==1 and bool(state['MainPID'] and state['MainPID']!='0' and ('pid='+state['MainPID']+',') in lines[0])},
        'activationMarker':marker(),'permissions':path_permissions(),'data':data_summary(),'unitVerification':verification()}

def validate_receipt(value):
    allowed_keys={'schema','readOnly','systemdVersion','service','probe','seed','listener','activationMarker','permissions','data','unitVerification','commandExit','inspectionFailure','LoadState','ActiveState','SubState','Result','ExecMainCode','ExecMainStatus','MainPID','count','loopbackOnly','matchesMainPid','present','safe','stage','entryCount','knownEntries','otherEntryCount','cache','uat.sqlite','uat.sqlite-shm','uat.sqlite-wal','.isolation-write-probe','exit','unknownDirective','invalidSetting','missingExecutable','dependencyFailure','exists','mode','uid','gid','symlink'}
    allowed_values={'bubblewash-uat-activation-inspection/v1','output-limit','timeout','unavailable','legacy-unrecorded','loaded','not-found','error','masked','stub','merged','inactive','active','failed','activating','deactivating','reloading','dead','running','exited','auto-restart','start','start-pre','start-post','stop','stop-sigterm','stop-sigkill','final-sigterm','final-sigkill','failed','success','exit-code','signal','core-dump','watchdog','resources','protocol','start-limit-hit','oom-kill','condition'}|STAGES
    paths={'/opt/bubblewash-uat','/opt/bubblewash-uat/app','/opt/bubblewash-uat/app/.next','/opt/bubblewash-uat/app/.next/cache','/var/lib/bubblewash-uat','/var/lib/bubblewash-uat/cache','/etc/bubblewash-uat','/etc/bubblewash-uat/environment'}
    def walk(item):
        if item is None or type(item) is bool:return
        if type(item) is int and 0<=item<=2**32:return
        if isinstance(item,str) and (item in allowed_values or re.fullmatch('[0-9]{1,10}',item)):return
        if isinstance(item,dict) and all(key in allowed_keys|paths for key in item):
            for child in item.values():walk(child)
            return
        raise ValueError('Unrecognized diagnostic receipt')
    if not isinstance(value,dict) or value.get('schema')!='bubblewash-uat-activation-inspection/v1' or value.get('readOnly') is not True:raise ValueError('Wrong diagnostic schema')
    if len(json.dumps(value))>16384:raise ValueError('Diagnostic bounds')
    walk(value)
    return value

if __name__=='__main__':
    try:
        if os.geteuid()!=0:raise ValueError()
        print(json.dumps(inspect(),sort_keys=True))
    except Exception:
        print('{"schema":"bubblewash-uat-activation-inspection/v1","readOnly":true,"ok":false,"reason":"inspection-unavailable"}')
        raise SystemExit(1)
