"""Local prepared transport primitives. No configured secret or enabled CLI entrypoint.

Only invoke after the coordinator establishes exact-source/access/storage approval.
This module creates no secrets, downloads no credentials and performs no HTTP.
"""
import base64
import json
import os
from pathlib import Path
import re
import resource
import selectors
import shlex
import subprocess
import time

REPOSITORY='bechirobob/bubble-wash'
UUID=re.compile('[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')
SOURCE_FILES=('ops/uat/restoration-transport.py','ops/uat/restoration-preflight.py','ops/uat/restoration-collector.py','ops/uat/restoration-receiver.py','scripts/uat-restore-original.mjs','ops/uat/restoration-runtime-pins.json')


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


def exchange(command,payload,timeout=180,limit=16384):
    """Concurrent bounded stdin/stdout/stderr; returns no stderr, even on failure."""
    require(type(payload) is bytes and len(payload)<=16384)
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    child=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
        env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'})
    selector=selectors.DefaultSelector();outputs={child.stdout:bytearray(),child.stderr:bytearray()}
    for stream in (child.stdin,child.stdout,child.stderr):os.set_blocking(stream.fileno(),False)
    selector.register(child.stdin,selectors.EVENT_WRITE)
    for stream in outputs:selector.register(stream,selectors.EVENT_READ)
    offset=0;deadline=time.monotonic()+timeout
    try:
        while selector.get_map():
            require(time.monotonic()<deadline)
            for key,_ in selector.select(.1):
                stream=key.fileobj
                if stream is child.stdin:
                    if offset<len(payload):offset+=os.write(stream.fileno(),payload[offset:offset+4096])
                    if offset==len(payload):selector.unregister(stream);stream.close()
                else:
                    chunk=os.read(stream.fileno(),4096)
                    if not chunk:selector.unregister(stream);continue
                    outputs[stream].extend(chunk);require(len(outputs[stream])<=limit)
        require(child.wait(timeout=2)==0)
        return bytes(outputs[child.stdout])
    finally:
        selector.close()
        if child.poll() is None:child.kill();child.wait()
        for stream in (child.stdin,child.stdout,child.stderr):stream.close()
        payload=b''


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
    return ['tailscale','ssh','root@hermes','python3 -I -B -c '+shlex.quote(code)]


def validate_receipt(raw,mode):
    require(0<len(raw)<=16384);value=json.loads(raw)
    require(type(value) is dict)
    if mode=='inspect':
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
    bundle=source_bundle(root,env['SOURCE_SHA'])
    raw=exchange(remote_command(bundle),json.dumps(request).encode())
    return validate_receipt(raw,request['mode'])


if __name__=='__main__':
    # Deliberately cannot dispatch from an accidentally configured environment.
    print('{"ok":false,"automaticRetry":false,"entrypointEnabled":false}')
    raise SystemExit(1)
