"""REVIEW DRAFT: pure validation/source-bundle preparation; no dispatch or CLI."""
import hashlib
import json
import re
import subprocess
from pathlib import Path
from uat_update_engine import Refused
from live_host_adapter import PIN_NAMES,pins
from update_receiver_draft import validate_request

# Proposed repository destinations. Not installed by this draft.
MODULES=(('uat_restore_transport','ops/uat/restoration-transport.py'),('uat_restore_preflight','ops/uat/restoration-preflight.py'),('uat_restore_collector','ops/uat/restoration-collector.py'),('uat_restart_diagnostic','ops/uat/restart-diagnostic.py'),('uat_single_restart','ops/uat/single-restart.py'),('uat_update_engine','ops/uat/update/uat_update_engine.py'),('host_files','ops/uat/update/host_files.py'),('live_host_adapter','ops/uat/update/live_host_adapter.py'),('update_receiver_draft','ops/uat/update/update_receiver_draft.py'))

def validate_context(env,source):
    if not re.fullmatch('[a-f0-9]{40}',source):raise Refused('source')
    expected={'GITHUB_REPOSITORY':'bechirobob/bubble-wash','GITHUB_REF':'refs/heads/main','GITHUB_SHA':source,'GITHUB_RUN_ATTEMPT':'1','GITHUB_EVENT_NAME':'workflow_dispatch'}
    if any(env.get(k)!=v for k,v in expected.items()):raise Refused('workflow context')
    if any(env.get(k) for k in ('ACTIONS_STEP_DEBUG','ACTIONS_RUNNER_DEBUG','RUNNER_DEBUG')):raise Refused('debug refused')

def git_bytes(root,sha,path):
    return subprocess.check_output(['git','show',sha+':'+path],cwd=root,stderr=subprocess.DEVNULL)

def prepare_bundle(root,source,candidate,env,request):
    validate_context(env,source);validate_request(request)
    if candidate!=source or candidate!=request['candidateRevision'] or not re.fullmatch('[a-f0-9]{40}',candidate):raise Refused('candidate mismatch')
    bundle={}
    for name,path in MODULES:
        raw=git_bytes(root,source,path)
        if not 0<len(raw)<=131072 or (Path(root)/path).read_bytes()!=raw:raise Refused('control source mismatch')
        bundle[name]={'path':path,'source':raw.decode()}
    original=json.loads(git_bytes(root,source,'ops/uat/restoration-runtime-pins.json'))
    candidate_pins={'runtimeRevision':candidate,'runtimeFiles':{p:hashlib.sha256(git_bytes(root,candidate,p)).hexdigest() for p in sorted(PIN_NAMES)},'unitSha256':original['unitSha256']}
    pins(candidate_pins,candidate)
    return bundle,original,candidate_pins

def header_bytes(bundle,original,candidate,request):
    import struct
    if set(bundle)!={name for name,_ in MODULES}:raise Refused('module set')
    for name,path in MODULES:
        if bundle[name]['path']!=path:raise Refused('module path')
    raw=json.dumps({'bundle':bundle,'original':original,'candidate':candidate,'request':request},separators=(',',':')).encode()
    if not 0<len(raw)<=1048576:raise Refused('source header bound')
    return struct.pack('!I',len(raw))+raw

def bootstrap():
    # Constant small command; source/header arrives on bounded stdin, not argv.
    # No networking or process launch in this draft function.
    return """import json,sys,types,signal,resource,struct,time
resource.setrlimit(resource.RLIMIT_CORE,(0,0))
execution_deadline=time.monotonic()+600
signal.alarm(600)
length=sys.stdin.buffer.read(4)
if len(length)!=4:raise SystemExit(1)
n=struct.unpack('!I',length)[0]
if not 0<n<=1048576:raise SystemExit(1)
raw=sys.stdin.buffer.read(n)
if len(raw)!=n:raise SystemExit(1)
payload=json.loads(raw)
if set(payload)!={'bundle','original','candidate','request'}:raise SystemExit(1)
modules=MODULES
if set(payload['bundle'])!={name for name,path in modules}:raise SystemExit(1)
for name,path in modules:
 item=payload['bundle'][name]
 if set(item)!={'path','source'} or item['path']!=path or not isinstance(item['source'],str) or not 0<len(item['source'].encode())<=131072:raise SystemExit(1)
 module=types.ModuleType(name);module.__file__='/reviewed/'+path;sys.modules[name]=module
 exec(compile(item['source'],path,'exec'),module.__dict__)
result=sys.modules['update_receiver_draft'].receive(sys.stdin.buffer,payload['request'],sys.modules['uat_single_restart'],payload['original'],payload['candidate'],execution_deadline)
print(json.dumps(result,sort_keys=True))
""".replace('MODULES',repr(MODULES))

def write_stream(destination,header,artifact,expected_size,expected_hash):
    """Prepare/send chunks to caller-owned stream; never launches a connection.
    Caller supplies a protected regular artifact, reviewed timeout/cancellation,
    capped output and first-attempt orchestration. No whole-artifact buffering.
    """
    import os,stat
    fd=os.open(artifact,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size!=expected_size or not 0<expected_size<=1024**3:raise Refused('artifact size')
        h=hashlib.sha256()
        while chunk:=os.read(fd,1024*1024):h.update(chunk)
        if h.hexdigest()!=expected_hash:raise Refused('artifact hash')
        os.lseek(fd,0,0)
        def write(raw):
            while raw:
                n=destination.write(raw)
                if type(n) is not int or n<=0:raise Refused('stream write failed')
                raw=raw[n:]
        write(header)
        h=hashlib.sha256()
        while chunk:=os.read(fd,1024*1024):h.update(chunk);write(chunk)
        after=os.fstat(fd)
        if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or h.hexdigest()!=expected_hash:raise Refused('artifact changed')
    finally:os.close(fd)


def validate_receipt(raw):
    if type(raw) is not bytes or len(raw)>16384:raise Refused('receipt bound')
    r=json.loads(raw)
    stages={'admission','artifact','inspection','transaction','inspect','stage','stop','stopped','snapshot','switch','start','postverify'}
    if type(r) is not dict or set(r)!={'state','stage','automaticRetry'} or r['automaticRetry'] is not False:raise Refused('receipt fields')
    if r['stage'] not in stages or r['state'] not in ('verified','inspection-required'):raise Refused('receipt state')
    if r['state']=='verified' and r['stage']!='postverify':raise Refused('premature success')
    return r


def bounded_transport(stream,transport,*,popen=subprocess.Popen,selector_factory=None,clock=None,timeout=660):
    """Fixed command, file-backed stdin, concurrent bounded outputs. No retries.
    Injection points support synthetic tests only, never workflow inputs.
    """
    import os,selectors,shlex,time
    selector_factory=selector_factory or selectors.DefaultSelector
    clock=clock or time.monotonic
    command=['/usr/local/bin/tailscale','ssh','root@hermes','python3 -I -B -c '+shlex.quote(bootstrap())]
    process=None;selector=None
    with transport.child_environment(command) as env:
        try:
            process=popen(command,stdin=stream,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
            selector=selector_factory()
            outputs={process.stdout:bytearray(),process.stderr:bytearray()}
            for channel in outputs:selector.register(channel,selectors.EVENT_READ)
            deadline=clock()+timeout
            while selector.get_map():
                if clock()>=deadline:raise Refused('transport timeout')
                for key,_ in selector.select(.1):
                    chunk=os.read(key.fileobj.fileno(),4096)
                    if not chunk:selector.unregister(key.fileobj);continue
                    outputs[key.fileobj].extend(chunk)
                    if len(outputs[key.fileobj])>16384:raise Refused('transport output limit')
            if process.wait(timeout=max(.01,min(5,deadline-clock())))!=0:raise Refused('remote nonzero')
            return validate_receipt(bytes(outputs[process.stdout]))
        finally:
            if selector is not None:selector.close()
            if process is not None:
                if process.poll() is None:
                    process.kill()
                    try:process.wait(timeout=5)
                    except subprocess.TimeoutExpired:pass
                process.stdout.close();process.stderr.close()


def apply(root,artifact,env):
    """Explicit CLI operation. All context validated before any network process."""
    import os,stat,tempfile,types
    source=env.get('SOURCE_SHA','');candidate=env.get('CANDIDATE_SHA','')
    validate_context(env,source)
    for key in ('ADMIN_ROUTE_APPROVED','INTERRUPTION_APPROVED','QUIET_WINDOW_COORDINATED'):
        if env.get(key)!='true':raise Refused('missing attestation')
    if not re.fullmatch('[1-9][0-9]{0,15}',env.get('EXPECTED_EXPIRY_MS','')):raise Refused('expected expiry required')
    if subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()!=source:raise Refused('checkout differs')
    # Runner is itself exact-source bound, not merely the transmitted modules.
    own='ops/uat/update/update_runner_draft.py'
    if git_bytes(root,source,own)!=(Path(root)/own).read_bytes():raise Refused('runner source differs')
    fd=os.open(artifact,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or not 0<info.st_size<=1024**3:raise Refused('artifact size')
        with os.fdopen(os.dup(fd),'rb') as f:sha=hashlib.file_digest(f,'sha256').hexdigest()
    finally:os.close(fd)
    request={'operationId':env.get('UAT_OPERATION_ID',''),'candidateRevision':candidate,'artifactSha256':sha,'artifactSize':info.st_size,'interruptionApproved':True,'quietWindowCoordinated':True,'adminRouteApproved':True,'expectedExpiryMs':int(env['EXPECTED_EXPIRY_MS'])}
    bundle,original,candidate_pins=prepare_bundle(root,source,candidate,env,request)
    transport=types.ModuleType('reviewed_update_transport');transport.__file__='/reviewed/ops/uat/restoration-transport.py'
    exec(compile(bundle['uat_restore_transport']['source'],transport.__file__,'exec'),transport.__dict__)
    # TemporaryFile is unlinked and mode0600. Never place payload in argv/artifact
    # uploads or logs. Original artifact retained; no host retry on uncertainty.
    with tempfile.TemporaryFile(mode='w+b') as payload:
        write_stream(payload,header_bytes(bundle,original,candidate_pins,request),artifact,info.st_size,sha)
        payload.flush();payload.seek(0)
        return bounded_transport(payload,transport)


def main():
    import argparse,os
    parser=argparse.ArgumentParser();parser.add_argument('--apply',action='store_true',required=True);parser.add_argument('--artifact',type=Path,required=True)
    args=parser.parse_args()
    root=Path(__file__).resolve().parents[3]
    try:result=apply(root,args.artifact,dict(os.environ))
    except Exception:result={'state':'inspection-required','stage':'transaction','automaticRetry':False}
    print(json.dumps(result,sort_keys=True))
    return 0 if result['state']=='verified' else 1

if __name__=='__main__':raise SystemExit(main())
