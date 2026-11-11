"""Source-bound one-time archive of a proven preflight-only update."""
import json,os,subprocess,tempfile,types
from pathlib import Path
from update_runner_draft import MODULES,git_bytes,validate_context
from uat_update_engine import Refused

EXTRA=('archive_preflight','ops/uat/update/archive_preflight.py')

def validate_receipt(raw):
    value=json.loads(raw)
    expected={'archived':True,'automaticRetry':False,'serviceChanged':False}
    if value!=expected:raise Refused('archive receipt')
    return value


def bootstrap():
    return """import sys,json,types,signal,resource
resource.setrlimit(resource.RLIMIT_CORE,(0,0));signal.alarm(120)
raw=sys.stdin.buffer.read(1048577)
if not 0<len(raw)<=1048576:raise SystemExit(1)
p=json.loads(raw)
for name,path in MODULE_LIST:
 m=types.ModuleType(name);m.__file__='/reviewed/'+path;sys.modules[name]=m
 exec(compile(p['modules'][name],path,'exec'),m.__dict__)
r=sys.modules['archive_preflight'].archive(sys.modules['uat_single_restart'],p['pins'])
print(json.dumps(r,sort_keys=True))
""".replace('MODULE_LIST',repr((*MODULES,EXTRA)))

def bounded_transport(stream,transport,*,popen=subprocess.Popen,selector_factory=None,clock=None,timeout=150):
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


def main():
    root=Path(__file__).resolve().parents[3];source=os.environ.get('SOURCE_SHA','')
    validate_context(dict(os.environ),source)
    if subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()!=source:raise Refused('checkout')
    paths=(*MODULES,EXTRA,('runner','ops/uat/update/archive_preflight_runner.py'),('helper','ops/uat/update/update_runner_draft.py'))
    bundle={}
    for name,path in paths:
        raw=git_bytes(root,source,path)
        if (root/path).read_bytes()!=raw or not 0<len(raw)<=131072:raise Refused('source')
        if name not in ('runner','helper'):bundle[name]=raw.decode()
    payload=json.dumps({'modules':bundle,'pins':json.loads(git_bytes(root,source,'ops/uat/restoration-runtime-pins.json'))}).encode()
    if len(payload)>1048576:raise Refused('payload')
    transport=types.ModuleType('transport');exec(compile(bundle['uat_restore_transport'],'reviewed-transport','exec'),transport.__dict__)
    with tempfile.TemporaryFile('w+b') as stream:
        stream.write(payload);stream.seek(0)
        result=bounded_transport(stream,transport)
    print(json.dumps(result,sort_keys=True))
if __name__=='__main__':
    try:main()
    except Exception:
        print(json.dumps({'automaticRetry':False,'state':'archive-unverified'}))
        raise SystemExit(1)
