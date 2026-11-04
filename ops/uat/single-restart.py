"""One coordinated UAT restart; no account, secret, deployment or configuration writes."""
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
       'PropagatesStopTo','OnFailure','OnSuccess','Requisite','Wants','BindsTo','PartOf','RequiredBy','Triggers','TriggeredBy')
FIXED={'Type':'simple','Restart':'on-failure','RestartUSec':'10s','TimeoutStopUSec':'30s',
       'KillMode':'control-group','KillSignal':'15','SendSIGKILL':'yes','SuccessAction':'none','FailureAction':'none'}


def loaded_unit():
    names=(*EMPTY,*FIXED,'Requires','Conflicts')
    raw=c.command(['/usr/bin/systemctl','show',p.SERVICE,*[arg for key in names for arg in ('-p',key)]])
    rows={}
    for line in raw.splitlines():
        key,sep,value=line.partition('=');require(sep and key in names and key not in rows);rows[key]=value
    require(set(rows)==set(names) and all(rows[key]=='' for key in EMPTY))
    require(all(rows[key]==value for key,value in FIXED.items()))
    require(set(rows['Requires'].split())=={'sysinit.target','system.slice'})
    require(rows['Conflicts']=='shutdown.target')
    for dependency in ('sysinit.target','system.slice'):
        require(c.command(['/usr/bin/systemctl','is-active',dependency]).strip()=='active')
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


def host_main(bundle):
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    raw=sys.stdin.buffer.read(1025);require(len(raw)<=1024)
    result=execute(bundle,json.loads(raw))
    print(json.dumps(validate_receipt(result),sort_keys=True))
    # The runner interprets the closed receipt. No exception details leave the host.


def context(env):
    # Reuse exact-main/first-attempt/admin/debug/credential-absence validation.
    require(env.get('UAT_RESTORE_MODE')=='inspect')
    original=t.private_input(env)
    require(env.get('UAT_RESTART_APPROVED')=='true' and env.get('UAT_QUIET_WINDOW_COORDINATED')=='true')
    return {'operationId':original['operationId'],'restartApproved':True,'quietWindowCoordinated':True}


def perform(root,env):
    request=context(env);bundle=t.source_bundle(root,env['SOURCE_SHA'])
    raw=(Path(root)/SELF).read_bytes();require(0<len(raw)<=16384 and not (Path(root)/SELF).is_symlink())
    require(subprocess.check_output(['git','show',env['SOURCE_SHA']+':'+SELF],cwd=root)==raw)
    bundle[SELF]=raw.decode()
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
    return validate_receipt(json.loads(t.exchange(command,json.dumps(request).encode(),timeout=180)))


if __name__=='__main__':
    try:result=perform(HERE.parents[1],os.environ)
    except BaseException:result=receipt('restart-uncertain')
    print(json.dumps(result,sort_keys=True))
    raise SystemExit(0 if result['ok'] else 1)
