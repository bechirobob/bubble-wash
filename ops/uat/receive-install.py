"""Fixed receiver loaded from reviewed runner source; stdin contains artifact only."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile
import types

FILES = {'ops/uat/prepare-host.py','ops/uat/bubblewash-uat.service','ops/inspect-uat-capacity.py'}


def receive(context, sources, input_stream):
    if os.geteuid()!=0 or set(sources)!=FILES:raise ValueError('receiver context')
    if not re.fullmatch('[a-f0-9]{40}',context['revision']) or not re.fullmatch('[a-f0-9]{64}',context['digest']) or not re.fullmatch('[1-9][0-9]{0,19}',context['runId']) or context['attempt']!='1' or not 0<context['size']<=1024**3 or not 0<context['expanded']<=4*1024**3:raise ValueError('receiver bounds')
    if any(not isinstance(v,str) or len(v.encode())>131072 for v in sources.values()):raise ValueError('source bounds')
    capacity=types.ModuleType('uat_capacity');exec(compile(sources['ops/inspect-uat-capacity.py'],'reviewed-capacity','exec'),capacity.__dict__)
    prepare=types.ModuleType('uat_prepare');exec(compile(sources['ops/uat/prepare-host.py'],'reviewed-prepare','exec'),prepare.__dict__)
    # Reserve reviewed expansion plus this transfer before staging remote bytes.
    prepare.admit(capacity.inspect(),context['expanded'] + context['size']);prepare.trusted_parents()
    base=Path('/var/lib');info=base.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise ValueError('staging ancestry')
    os.umask(0o077)
    stage=Path(tempfile.mkdtemp(prefix='bubblewash-uat-install-'+context['runId']+'-',dir=base))
    artifact=stage/'release.tar.gz'
    digest=hashlib.sha256();remaining=context['size']
    fd=os.open(artifact,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as stream:
        while remaining:
            chunk=input_stream.read(min(1024*1024,remaining))
            if not chunk:raise ValueError('truncated artifact')
            stream.write(chunk);digest.update(chunk);remaining-=len(chunk)
        stream.flush();os.fsync(stream.fileno())
    if input_stream.read(1) or digest.hexdigest()!=context['digest']:raise ValueError('artifact framing/hash')
    for name,raw in sources.items():
        target=stage/name;target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        prepare.new_file(target,raw,0o600)
    command=['/usr/bin/python3','-I','-B',str(stage/'ops/uat/prepare-host.py'),'--artifact',str(artifact),'--sha256',context['digest'],'--revision',context['revision'],'--apply','--isolation-approved']
    # Operator emits only bounded sanitized JSON, never a session secret.
    result=subprocess.run(command,stdin=subprocess.DEVNULL,capture_output=True,timeout=300,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C','PYTHONDONTWRITEBYTECODE':'1'})
    if result.returncode or len(result.stdout)>8192 or len(result.stderr)>8192:raise ValueError('installation incomplete; retained for inspection')
    receipt=json.loads(result.stdout)
    if receipt!={'ok':True,'action':'installed-not-started','port':3108,'revision':context['revision'],'accountsIssued':False,'productionChanged':False,'routingChanged':False}:raise ValueError('receipt mismatch')
    return receipt


def main(context,sources):
    def timeout(*_):raise TimeoutError('receiver deadline')
    signal.signal(signal.SIGALRM,timeout);signal.alarm(600)
    try:
        result=receive(context,sources,sys.stdin.buffer);print(json.dumps(result,sort_keys=True))
    except BaseException:
        print(json.dumps({'ok':False,'error':'UAT installation refused or incomplete; retain partial resources for review.'}))
        raise SystemExit(1)
