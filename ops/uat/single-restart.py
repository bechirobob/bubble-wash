"""One coordinated UAT restart; no account, secret, deployment or configuration writes."""
import ast
import base64
import importlib.util
import json
import os
from pathlib import Path
import resource
import shlex
import subprocess
import sys
import time
import urllib.request

HERE=Path(__file__).resolve().parent
SELF='ops/uat/single-restart.py'

def load(name,file):
    if name in sys.modules:return sys.modules[name]
    spec=importlib.util.spec_from_file_location(name,HERE/file)
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
    return module

t=load('uat_restore_transport','restoration-transport.py')
c=load('uat_restore_collector','restoration-collector.py')
p=c.p
require=t.require
ARGV=['/usr/bin/node','node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3108']
EMPTY=('ExecStartPre','ExecStartPost','ExecReload','ExecStop','ExecStopPost','ConsistsOf','BoundBy',
       'PropagatesStopTo','OnFailure','OnSuccess','Requisite','BindsTo','PartOf','RequiredBy','Triggers','TriggeredBy','Upholds','UpheldBy')
FIXED={'Type':'simple','Restart':'on-failure','RestartUSec':'10s','TimeoutStopUSec':'30s',
       'KillMode':'control-group','KillSignal':'15','SendSIGKILL':'yes','SuccessAction':'none','FailureAction':'none'}


DEPENDENCIES={'sysinit.target':('sysinit_2etarget',None),
              'system.slice':('system_2eslice',None),
              '-.mount':('_2d_2emount','/'), 'tmp.mount':('tmp_2emount','/tmp')}


def dependency_state(name):
    """Fixed implicit dependencies only: active, or a non-loadable weak tmp.mount."""
    require(name in DEPENDENCIES)
    object_name,where=DEPENDENCIES[name]
    keys=('Id','LoadState','ActiveState','SubState','NeedDaemonReload','DropInPaths','FragmentPath','SourcePath')
    if where:keys+=('Where',)
    raw=c.command(['/usr/bin/systemctl','show',*[a for key in keys for a in ('-p',key)],'--',name])
    value={}
    for line in raw.splitlines():
        key,sep,item=line.partition('=');require(sep and key in keys and key not in value);value[key]=item
    require(set(value)==set(keys) and value['Id']==name and value['NeedDaemonReload']=='no' and value['DropInPaths']=='')
    job=c.command(['/usr/bin/busctl','--system','get-property','org.freedesktop.systemd1',
        '/org/freedesktop/systemd1/unit/'+object_name,'org.freedesktop.systemd1.Unit','Job'],limit=128)
    require(shlex.split(job)==['(uo)','0','/'])
    if name=='tmp.mount' and value['LoadState'] in ('masked','not-found'):
        require(value['ActiveState']=='inactive' and value['SubState']=='dead')
        require(value['SourcePath']=='' and value['FragmentPath']==('/dev/null' if value['LoadState']=='masked' else ''))
        require(value['Where'] in ('','/tmp'))
    else:
        require(value['LoadState']=='loaded' and value['ActiveState']=='active')
        require(value['SubState']==('mounted' if where else 'active'))
        if value['FragmentPath']:value['fragmentIdentity']=c.trusted(value['FragmentPath'])
        if value['SourcePath'] and not (where and value['SourcePath'] in ('/proc/self/mountinfo','/proc/1/mountinfo')):
            value['sourceIdentity']=c.trusted(value['SourcePath'])
        if where:
            require(value['Where']==where)
            mountinfo=c.read('/proc/1/mountinfo',1048576).decode()
            matches=[]
            for line in mountinfo.splitlines():
                left,sep,right=line.partition(' - ');fields=left.split()
                require(sep and len(fields)>=6 and right.split())
                if fields[4]==where:
                    require(right.split()[0]!='autofs');matches.append(line)
            require(len(matches)==1)
            value['mountIdentity']=matches[0]
    return value


def loaded_unit():
    names=(*EMPTY,*FIXED,'Requires','Wants','Conflicts')
    raw=c.command(['/usr/bin/systemctl','show',p.SERVICE,*[arg for key in names for arg in ('-p',key)]])
    rows={}
    for line in raw.splitlines():
        key,sep,value=line.partition('=');require(sep and key in names and key not in rows);rows[key]=value
    require(set(rows)==set(names) and all(rows[key]=='' for key in EMPTY))
    require(all(rows[key]==value for key,value in FIXED.items()))
    required=rows['Requires'].split();wanted=rows['Wants'].split()
    require(len(required)==len(set(required)) and len(wanted)==len(set(wanted)))
    require({'sysinit.target','system.slice'}<=set(required)<= {'sysinit.target','system.slice','-.mount'})
    require(set(wanted)<= {'tmp.mount'} and rows['Conflicts']=='shutdown.target')
    rows['dependencyEvidence']={name:dependency_state(name) for name in sorted(set(required+wanted))}
    # Typed D-Bus text avoids systemctl's human-facing ExecStart formatting.
    raw=c.command(['/usr/bin/busctl','--system','get-property','org.freedesktop.systemd1',
        '/org/freedesktop/systemd1/unit/bubblewash_2duat_2eservice','org.freedesktop.systemd1.Service','ExecStart'])
    fields=shlex.split(raw)
    prefix=['a(sasbttttuii)','1',ARGV[0],str(len(ARGV)),*ARGV,'false']
    require(fields[:len(prefix)]==prefix and len(fields)==len(prefix)+7)
    require(all(x.isdecimal() and int(x)<2**64 for x in fields[len(prefix):]))
    return rows


def quiet_sample():
    # Observation, not a firewall or proof against future requests. Coordination is mandatory.
    require(c.command(['/usr/bin/ss','-H','-tn','state','established','sport = :3108']).strip()=='')


def health():
    # Fixed loopback liveness endpoint has no database imports. Never follow a redirect.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    with opener.open('http://127.0.0.1:3108/api/health',timeout=5) as response:
        require(response.status==200)
        raw=response.read(2049);require(len(raw)<=2048)
    value=json.loads(raw)
    require(type(value) is dict and set(value)=={'ok','service','status','time'})
    require(value['ok'] is True and value['service']=='Bubble Wash' and value['status']=='alive')


def receipt(state):
    require(state in ('precheck-failed','restart-uncertain','postcheck-failed','verified'))
    return {'ok':state=='verified','readOnly':False,'automaticRetry':False,'state':state,
            'restartRequested':state!='precheck-failed','accountAction':False}


def validate_receipt(value):
    require(type(value) is dict and type(value.get('state')) is str)
    require(value==receipt(value['state']))
    require(all(type(value[k]) is bool for k in ('ok','readOnly','automaticRetry','restartRequested','accountAction')))
    return value


def execute(bundle,request):
    require(os.geteuid()==0 and type(request) is dict and set(request)=={'operationId','restartApproved','quietWindowCoordinated'})
    require(t.UUID.fullmatch(request['operationId']) and request['restartApproved'] is True and request['quietWindowCoordinated'] is True)
    pins=json.loads(bundle['ops/uat/restoration-runtime-pins.json'])
    stage='precheck-failed'
    try:
        first=c.collect_restart_isolation(pins,before_restart=True)
        loaded=loaded_unit();quiet_sample()
        require(c.collect_restart_isolation(pins,before_restart=True)==first)
        require(loaded_unit()==loaded);quiet_sample()
        stage='restart-uncertain'
        # Exactly one explicit request. Killing this client does not cancel a queued systemd job.
        t.exchange(['/usr/bin/systemctl','--job-mode=fail','restart',p.SERVICE],b'',timeout=45,limit=4096)
        stage='postcheck-failed'
        # Read-only bounded startup polling; never repeats the restart command.
        deadline=time.monotonic()+30
        while True:
            try:
                after=c.collect_restart_isolation(pins,before_restart=False)
                require((after['pid'],after['startTicks'])!=(first['pid'],first['startTicks']))
                require(all(after[k]==first[k] for k in ('database','configObjects','productionPaths')))
                require(loaded_unit()==loaded)
                health()
                require(c.collect_restart_isolation(pins,before_restart=False)==after)
                return receipt('verified')
            except Exception:
                if time.monotonic()>=deadline:raise
                time.sleep(1)
    except Exception:
        return receipt(stage)


DIAGNOSTIC_STAGES={'isolation','loaded-unit','quiescence','identity-confirmation','complete','unavailable'}
SOURCE_LABELS={SELF:'R','ops/uat/restoration-collector.py':'C',
               'ops/uat/restoration-preflight.py':'P','ops/uat/restoration-transport.py':'T'}
REMOTE_FILES=(*SOURCE_LABELS,'ops/uat/restoration-runtime-pins.json')


def diagnostic_sites(bundle):
    return {name:{node.lineno:label+'-L'+str(node.lineno) for node in ast.walk(ast.parse(bundle[name]))
            if isinstance(node,ast.stmt) and hasattr(node,'lineno')}
            for name,label in SOURCE_LABELS.items()}


def inspection_receipt(stage,sites=(),properties=()):
    require(stage in DIAGNOSTIC_STAGES)
    return {'ok':False,'readOnly':True,'automaticRetry':False,'state':'precheck-inspected',
            'precheckPassed':stage=='complete','failureStage':stage,'failureSites':list(sites),
            'failureProperties':list(properties)}


def validate_inspection(value,bundle):
    require(type(value) is dict and set(value)==set(inspection_receipt('unavailable')))
    require(type(value['failureStage']) is str and value['failureStage'] in DIAGNOSTIC_STAGES)
    require(type(value['failureSites']) is list and len(value['failureSites'])<=8)
    allowed={token for rows in diagnostic_sites(bundle).values() for token in rows.values()}
    require(all(type(token) is str and token in allowed for token in value['failureSites']))
    properties=value['failureProperties']
    require(type(properties) is list and len(properties)<=len(p.SERVICE_PROPERTY_NAMES))
    require(all(type(name) is str and name in p.SERVICE_PROPERTY_NAMES for name in properties))
    require(properties==sorted(set(properties)))
    if properties:require(value['failureStage'] in ('isolation','identity-confirmation'))
    require(value==inspection_receipt(value['failureStage'],value['failureSites'],properties))
    require(all(type(value[k]) is bool for k in ('ok','readOnly','automaticRetry','precheckPassed')))
    if value['precheckPassed']:require(not value['failureSites'])
    return value


def inspect_prechecks(bundle,request):
    require(os.geteuid()==0 and type(request) is dict and set(request)=={'mode','operationId'})
    require(request['mode']=='inspect' and t.UUID.fullmatch(request['operationId']))
    pins=json.loads(bundle['ops/uat/restoration-runtime-pins.json']);stage='isolation'
    try:
        first=c.collect_restart_isolation(pins,before_restart=True)
        stage='loaded-unit';loaded=loaded_unit()
        stage='quiescence';quiet_sample()
        stage='identity-confirmation'
        require(c.collect_restart_isolation(pins,before_restart=True)==first)
        require(loaded_unit()==loaded);quiet_sample()
        return inspection_receipt('complete')
    except Exception as error:
        allowed=diagnostic_sites(bundle);trace=error.__traceback__;sites=[]
        while trace is not None:
            token=allowed.get(trace.tb_frame.f_code.co_filename,{}).get(trace.tb_lineno)
            if token:sites.append(token)
            trace=trace.tb_next
        properties=error.names if type(error) is p.ServicePropertyGuardFailure else ()
        return validate_inspection(inspection_receipt(stage,sites[-8:],properties),bundle)


def host_main(bundle):
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    raw=sys.stdin.buffer.read(1025);require(len(raw)<=1024)
    request=json.loads(raw)
    if type(request) is dict and request.get('mode')=='inspect':
        result=validate_inspection(inspect_prechecks(bundle,request),bundle)
    else:
        result=validate_receipt(execute(bundle,request))
    print(json.dumps(result,sort_keys=True))
    # The runner interprets the closed receipt. No exception details leave the host.


def context(env):
    # Reuse exact-main/first-attempt/admin/debug/credential-absence validation.
    require(env.get('UAT_RESTORE_MODE')=='inspect')
    original=t.private_input(env)
    mode=env.get('UAT_RESTART_MODE','restart');require(mode in ('inspect','restart'))
    if mode=='inspect':return {'mode':'inspect','operationId':original['operationId']}
    require(env.get('UAT_RESTART_APPROVED')=='true' and env.get('UAT_QUIET_WINDOW_COORDINATED')=='true')
    return {'operationId':original['operationId'],'restartApproved':True,'quietWindowCoordinated':True}


def perform(root,env):
    request=context(env);bundle=t.source_bundle(root,env['SOURCE_SHA'])
    raw=(Path(root)/SELF).read_bytes();require(0<len(raw)<=16384 and not (Path(root)/SELF).is_symlink())
    require(subprocess.check_output(['git','show',env['SOURCE_SHA']+':'+SELF],cwd=root)==raw)
    bundle[SELF]=raw.decode()
    # Full source verification above; unused account code is never transmitted.
    bundle={name:bundle[name] for name in REMOTE_FILES}
    bootstrap="""import json,sys,types,signal
signal.alarm(150)
bundle=json.loads(BUNDLE)
for name,path in [('uat_restore_transport','ops/uat/restoration-transport.py'),('uat_restore_preflight','ops/uat/restoration-preflight.py'),('uat_restore_collector','ops/uat/restoration-collector.py'),('uat_single_restart','ops/uat/single-restart.py')]:
 module=types.ModuleType(name);module.__file__='/reviewed/'+path;sys.modules[name]=module
 exec(compile(bundle[path],path,'exec'),module.__dict__)
sys.modules['uat_single_restart'].host_main(bundle)
""".replace('BUNDLE',repr(json.dumps(bundle)))
    encoded=base64.b64encode(bootstrap.encode()).decode();require(len(encoded)<120000)
    code="import base64;exec(compile(base64.b64decode("+repr(encoded)+"),'reviewed-uat-single-restart','exec'))"
    command=['/usr/local/bin/tailscale','ssh','root@hermes','python3 -I -B -c '+shlex.quote(code)]
    value=json.loads(t.exchange(command,json.dumps(request).encode(),timeout=180))
    return validate_inspection(value,bundle) if request.get('mode')=='inspect' else validate_receipt(value)


if __name__=='__main__':
    try:result=perform(HERE.parents[1],os.environ)
    except BaseException:
        result=inspection_receipt('unavailable') if os.environ.get('UAT_RESTART_MODE')=='inspect' else receipt('restart-uncertain')
    print(json.dumps(result,sort_keys=True))
    raise SystemExit(0 if result['ok'] else 1)
