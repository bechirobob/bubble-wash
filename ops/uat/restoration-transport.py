"""Local prepared transport primitives. No configured secret or enabled CLI entrypoint.

Only invoke after the coordinator establishes exact-source/access/storage approval.
This module creates no secrets, downloads no credentials and performs no HTTP.
"""
import ast
import base64
import contextlib
import json
import os
from pathlib import Path
import re
import resource
import selectors
import shlex
import subprocess
import sys
import tempfile
import time

REPOSITORY='bechirobob/bubble-wash'
UUID=re.compile('[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')
SOURCE_FILES=('ops/uat/restoration-transport.py','ops/uat/restoration-preflight.py','ops/uat/restoration-collector.py','ops/uat/restoration-receiver.py','scripts/uat-restore-original.mjs','ops/uat/restoration-runtime-pins.json')
INSPECTION_STAGES={'source-verification','transport','receipt-validation','host-inspection'}
TRANSPORT_FAILURES={'config-directory','startup-missing','startup-denied','startup-unavailable',
    'timeout','output-limit','stdin-closed','io-error','exit-no-receipt','exit-invalid-receipt',
    'exit-signal','exit-nonzero','cleanup'}
INSPECTION_STAGES|={'transport-'+category for category in TRANSPORT_FAILURES}


class TransportFailure(ValueError):
    def __init__(self,category):
        if category not in TRANSPORT_FAILURES:raise ValueError('Unknown transport category')
        super().__init__('UAT confidential transport refused')
        self.category=category


def diagnostic_sites(bundle):
    """Static tokens derived only from the exact reviewed Python source bundle."""
    sites={}
    for index,name in enumerate(SOURCE_FILES):
        if name.endswith('.py') and name in bundle:
            tree=ast.parse(bundle[name])
            sites[name]={node.lineno:'F'+str(index)+'-L'+str(node.lineno)
                for node in ast.walk(tree) if isinstance(node,ast.stmt) and hasattr(node,'lineno')}
    return sites


def inspection_failure(error,bundle,stage):
    """Never stringify exceptions, tracebacks, locals, paths or remote output."""
    require(stage in INSPECTION_STAGES)
    if stage=='transport' and isinstance(error,TransportFailure):stage='transport-'+error.category
    result={'ok':False,'readOnly':True,'automaticRetry':False,
        'state':'inspection-failed','failureStage':stage,'failureSites':[]}
    try:
        sites=diagnostic_sites(bundle);trace=error.__traceback__;found=[]
        while trace is not None:
            filename=trace.tb_frame.f_code.co_filename
            # Bootstrap compiles with these exact fixed relative names. Local
            # imports use absolute names, which deliberately produce no token.
            token=sites.get(filename,{}).get(trace.tb_lineno)
            if token:found.append(token)
            trace=trace.tb_next
        result['failureSites']=found[-8:]
        preflight=sys.modules.get('uat_restore_preflight')
        failure_type=getattr(preflight,'TimestampGuardFailure',None)
        if stage=='host-inspection' and isinstance(failure_type,type) and isinstance(error,failure_type):
            details=[{'category':category,'comparison':comparison} for category,comparison in error.failures]
            validate_timestamp_failures(details)
            result['timestampFailures']=details
    except BaseException:
        pass
    return result


def validate_timestamp_failures(value):
    categories={'runtime-revision','runtime-source','service-unit','environment'}
    comparisons={'mtime-after-process-start','ctime-after-process-start'}
    require(type(value) is list and 1<=len(value)<=8)
    pairs=[]
    for row in value:
        require(type(row) is dict and set(row)=={'category','comparison'})
        require(type(row['category']) is str and row['category'] in categories)
        require(type(row['comparison']) is str and row['comparison'] in comparisons)
        pairs.append((row['category'],row['comparison']))
    require(pairs==sorted(set(pairs)))


def validate_inspection_failure(value,bundle,host_only=False):
    fields={'ok','readOnly','automaticRetry','state','failureStage','failureSites'}
    require(type(value) is dict and set(value) in (fields,fields|{'timestampFailures'}))
    require(value['ok'] is False and value['readOnly'] is True and value['automaticRetry'] is False)
    require(value['state']=='inspection-failed' and type(value['failureStage']) is str)
    require(value['failureStage'] in ({'host-inspection'} if host_only else INSPECTION_STAGES))
    allowed={token for sites in diagnostic_sites(bundle).values() for token in sites.values()}
    require(type(value['failureSites']) is list and len(value['failureSites'])<=8)
    require(all(type(token) is str and token in allowed for token in value['failureSites']))
    if 'timestampFailures' in value:
        require(value['failureStage']=='host-inspection')
        validate_timestamp_failures(value['timestampFailures'])
    return value


def require(value):
    if not value:raise ValueError('UAT confidential transport refused')


def private_input(env):
    mode=env.get('UAT_RESTORE_MODE');operation=env.get('UAT_OPERATION_ID','')
    require(mode in ('inspect','restore','receipt') and UUID.fullmatch(operation))
    require(env.get('GITHUB_REPOSITORY')==REPOSITORY and env.get('GITHUB_REF')=='refs/heads/main' and env.get('GITHUB_EVENT_NAME')=='workflow_dispatch' and env.get('GITHUB_RUN_ATTEMPT')=='1')
    require(re.fullmatch('[a-f0-9]{40}',env.get('SOURCE_SHA','')) and env['SOURCE_SHA']==env.get('GITHUB_SHA'))
    require(env.get('ADMIN_ROUTE_APPROVED')=='true' and env.get('RUNNER_DEBUG')!='1' and env.get('ACTIONS_STEP_DEBUG')!='true')
    request={'mode':mode,'operationId':operation}
    if mode!='restore':
        require('BUBBLEWASH_UAT_RESTORE_ONCE' not in env)
        return request
    # Flags attest separately established approvals; they do not obtain them.
    for key in ('RESTORATION_APPROVED','GITHUB_CREDENTIAL_STORAGE_APPROVED','SECRET_CLEANUP_APPROVED','PUBLIC_VERIFICATION_READY'):
        require(env.get(key)=='true')
    raw=env.pop('BUBBLEWASH_UAT_RESTORE_ONCE','')
    require(isinstance(raw,str) and 0<len(raw.encode())<=8192)
    value=json.loads(raw);raw=''
    require(type(value) is dict and set(value)=={'operationId','accounts'} and value['operationId']==operation)
    accounts=value['accounts'];require(type(accounts) is list and len(accounts)==4)
    require(all(type(a) is dict and set(a)=={'username','password','role'} and
        type(a['username']) is str and re.fullmatch('[a-z][a-z0-9._-]{2,63}',a['username']) and
        type(a['password']) is str and 14<=len(a['password'])<=200 and a['role'] in ('admin','vendor','driver','support') for a in accounts))
    require(len({a['username'] for a in accounts})==4 and {a['role'] for a in accounts}=={'admin','vendor','driver','support'})
    return dict(request,accounts=accounts)


@contextlib.contextmanager
def child_environment(command):
    """Only public SSH host keys get a fresh private directory; inherit nothing."""
    env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'}
    stack=contextlib.ExitStack()
    try:
        if command[:3]==['/usr/local/bin/tailscale','ssh','root@hermes']:
            try:
                directory=stack.enter_context(tempfile.TemporaryDirectory(prefix='bubblewash-uat-ssh-',dir='/tmp'))
            except OSError:
                raise TransportFailure('config-directory') from None
            # Tailscale v1.94.2 writeKnownHosts uses os.UserConfigDir(). Without
            # XDG_CONFIG_HOME or HOME it refuses before invoking system ssh.
            # Do not inherit HOME, runner config, auth sockets or credentials.
            env['XDG_CONFIG_HOME']=directory
        yield env
    finally:
        try:stack.close()
        except OSError:raise TransportFailure('cleanup') from None


def exchange(command,payload,timeout=180,limit=16384,inspection_bundle=None):
    with child_environment(command) as env:
        return _exchange(command,payload,timeout,limit,inspection_bundle,env)


def _exchange(command,payload,timeout,limit,inspection_bundle,env):
    """Concurrent bounded stdin/stdout/stderr; returns no stderr, even on failure."""
    require(type(payload) is bytes and len(payload)<=16384)
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    try:
        child=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
    except FileNotFoundError:raise TransportFailure('startup-missing') from None
    except PermissionError:raise TransportFailure('startup-denied') from None
    except OSError:raise TransportFailure('startup-unavailable') from None
    selector=None
    try:
        selector=selectors.DefaultSelector();outputs={child.stdout:bytearray(),child.stderr:bytearray()}
        for stream in (child.stdin,child.stdout,child.stderr):os.set_blocking(stream.fileno(),False)
        selector.register(child.stdin,selectors.EVENT_WRITE)
        for stream in outputs:selector.register(stream,selectors.EVENT_READ)
        offset=0;deadline=time.monotonic()+timeout;stdin_closed=False
        while selector.get_map():
            if time.monotonic()>=deadline:raise TransportFailure('timeout')
            for key,_ in selector.select(.1):
                stream=key.fileobj
                if stream is child.stdin:
                    try:
                        if offset<len(payload):offset+=os.write(stream.fileno(),payload[offset:offset+4096])
                    except BlockingIOError:continue
                    except BrokenPipeError:
                        # Drain bounded output to distinguish remote exit from
                        # a pipe symptom. Never return unvalidated stderr/stdout.
                        stdin_closed=True;selector.unregister(stream);stream.close();continue
                    if offset==len(payload):selector.unregister(stream);stream.close()
                else:
                    try:chunk=os.read(stream.fileno(),4096)
                    except BlockingIOError:continue
                    if not chunk:selector.unregister(stream);continue
                    outputs[stream].extend(chunk)
                    if len(outputs[stream])>limit:raise TransportFailure('output-limit')
        try:code=child.wait(timeout=2)
        except subprocess.TimeoutExpired:raise TransportFailure('timeout') from None
        raw=bytes(outputs[child.stdout])
        if code!=0:
            # Only the inspect caller opts in. Never relay arbitrary nonzero
            # output or change the write/receipt transport's rejection rules.
            if code<0:raise TransportFailure('exit-signal')
            if inspection_bundle is None:raise TransportFailure('exit-nonzero')
            if not raw:raise TransportFailure('exit-no-receipt')
            try:value=validate_inspection_failure(json.loads(raw),inspection_bundle,host_only=True)
            except (ValueError,TypeError,KeyError):raise TransportFailure('exit-invalid-receipt') from None
            return json.dumps(value).encode()
        if stdin_closed:raise TransportFailure('stdin-closed')
        return raw
    except OSError:
        raise TransportFailure('io-error') from None
    finally:
        cleanup_failed=False
        try:
            if selector is not None:selector.close()
        except BaseException:cleanup_failed=True
        try:
            if child.poll() is None:child.kill()
        except ProcessLookupError:pass
        except BaseException:cleanup_failed=True
        try:child.wait(timeout=2)
        except BaseException:cleanup_failed=True
        # Do not let a selector/termination/reap error skip pipe closure.
        try:
            for stream in (child.stdin,child.stdout,child.stderr):
                try:stream.close()
                except BaseException:cleanup_failed=True
        finally:payload=b''
        if cleanup_failed:raise TransportFailure('cleanup') from None


def source_bundle(root,revision):
    root=Path(root)
    require(subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==revision)
    result={}
    for name in SOURCE_FILES:
        path=root/name;require(path.is_file() and not path.is_symlink())
        raw=path.read_bytes();require(0<len(raw)<=65536)
        require(subprocess.check_output(['git','show',revision+':'+name],cwd=root)==raw)
        result[name]=raw.decode('utf-8')
    return result


def remote_command(bundle):
    require(set(bundle)==set(SOURCE_FILES) and sum(len(v.encode()) for v in bundle.values())<=90000)
    # Only reviewed NONSECRET code is in argv. Request/credentials remain on stdin.
    bootstrap="""import json,sys,types
bundle=json.loads(BUNDLE)
for name,path in [('uat_restore_transport','ops/uat/restoration-transport.py'),('uat_restore_preflight','ops/uat/restoration-preflight.py'),('uat_restore_collector','ops/uat/restoration-collector.py'),('uat_restore_receiver','ops/uat/restoration-receiver.py')]:
 module=types.ModuleType(name);module.__file__='/reviewed/'+path;sys.modules[name]=module
 exec(compile(bundle[path],path,'exec'),module.__dict__)
sys.modules['uat_restore_receiver'].main(bundle)
""".replace('BUNDLE',repr(json.dumps(bundle)))
    encoded=base64.b64encode(bootstrap.encode()).decode()
    require(len(encoded)<120000)
    code="import base64;exec(compile(base64.b64decode("+repr(encoded)+"),'reviewed-uat-restore','exec'))"
    # The pinned Tailscale action installs here; keep exchange's restricted PATH.
    return ['/usr/local/bin/tailscale','ssh','root@hermes','python3 -I -B -c '+shlex.quote(code)]


def validate_receipt(raw,mode,inspection_bundle=None):
    require(0<len(raw)<=16384);value=json.loads(raw)
    require(type(value) is dict)
    if mode=='inspect':
        if value.get('ok') is False:
            require(inspection_bundle is not None)
            return validate_inspection_failure(value,inspection_bundle,host_only=True)
        allowed={'ok','readOnly','automaticRetry','runtimeRevision','filesystemObjectsVerified','installedRuntimeVerified','runtimeSourcesVerified','unitSourceVerified','configuredEnvironmentVerified','runningEnvironmentVerified','providerCredentialsAbsent','runningServiceIdentityVerified','effectiveSandboxVerified','loopbackListenerVerified','mountBackingsIndependent','runningNamespaceStorageVerified','originalCohortEligible','originalRoleCount','totalAccountCount','revokedAccountCount'}
        require(set(value)==allowed and value['ok'] is True and value['readOnly'] is True and value['automaticRetry'] is False)
        for k,v in value.items():
            require(re.fullmatch('[a-f0-9]{40}',v) if k=='runtimeRevision' else type(v) is int and 0<=v<=1000 if k.endswith('Count') else type(v) is bool)
        require(value['originalRoleCount']==4 and all(v is True for k,v in value.items() if k not in {'automaticRetry','runtimeRevision','originalRoleCount','totalAccountCount','revokedAccountCount'}))
    else:
        base={'ok','readOnly','automaticRetry','state'}
        require(value.get('state') in ('committed','committed-state-changed','not-observed','different-operation','uncertain-stop'))
        committed=value['state'].startswith('committed')
        require(set(value)==base|({'restored','startsAt','expiresAt','oldSessionsInvalidated'} if committed else set()))
        require(value['ok'] is True and value['automaticRetry'] is False and value['readOnly'] is (mode=='receipt'))
        if mode=='restore':require(value['state']=='committed')
        if committed:
            require(value['restored']==4 and value['oldSessionsInvalidated'] is True)
            require(type(value['startsAt']) is int and type(value['expiresAt']) is int and value['startsAt']>=1793661573802 and value['expiresAt']-value['startsAt']==604800000)
    return value


def perform(root,env):
    request=private_input(env)
    if request['mode']=='inspect':
        bundle={};stage='source-verification'
        try:
            bundle=source_bundle(root,env['SOURCE_SHA'])
            stage='transport'
            raw=exchange(remote_command(bundle),json.dumps(request).encode(),inspection_bundle=bundle)
            stage='receipt-validation'
            return validate_receipt(raw,'inspect',inspection_bundle=bundle)
        except BaseException as error:
            return inspection_failure(error,bundle,stage)
    bundle=source_bundle(root,env['SOURCE_SHA'])
    raw=exchange(remote_command(bundle),json.dumps(request).encode())
    return validate_receipt(raw,request['mode'])


if __name__=='__main__':
    # Deliberately cannot dispatch from an accidentally configured environment.
    print('{"ok":false,"automaticRetry":false,"entrypointEnabled":false}')
    raise SystemExit(1)
