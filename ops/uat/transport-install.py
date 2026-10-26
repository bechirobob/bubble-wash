#!/usr/bin/env python3
"""Exact-main, first-attempt tailnet transport. No routing or activation."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shlex
import subprocess
import time
import types

ROOT=Path(__file__).resolve().parents[2]
SOURCES=('ops/uat/prepare-host.py','ops/uat/bubblewash-uat.service','ops/inspect-uat-capacity.py')


def context(env,artifact):
    if env.get('GITHUB_REPOSITORY')!='bechirobob/bubble-wash' or env.get('GITHUB_REF')!='refs/heads/main' or env.get('GITHUB_EVENT_NAME')!='workflow_dispatch' or env.get('GITHUB_RUN_ATTEMPT')!='1':raise ValueError('workflow scope')
    revision=env.get('SOURCE_SHA','')
    if not re.fullmatch('[a-f0-9]{40}',revision) or revision!=env.get('GITHUB_SHA') or not re.fullmatch('[1-9][0-9]{0,19}',env.get('GITHUB_RUN_ID','')):raise ValueError('source/run pin')
    if artifact.is_symlink() or not artifact.is_file() or not 0<artifact.stat().st_size<=1024**3:raise ValueError('artifact bounds')
    with artifact.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
    return {'revision':revision,'runId':env['GITHUB_RUN_ID'],'attempt':'1','size':artifact.stat().st_size,'digest':digest}


def bounded(command,stream):
    process=subprocess.Popen(command,stdin=stream,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    selector=selectors.DefaultSelector();selector.register(process.stdout,selectors.EVENT_READ);selector.register(process.stderr,selectors.EVENT_READ)
    output={process.stdout:bytearray(),process.stderr:bytearray()};deadline=time.monotonic()+660
    try:
        while selector.get_map():
            if time.monotonic()>deadline:raise TimeoutError('transport timeout')
            for key,_ in selector.select(.25):
                chunk=os.read(key.fileobj.fileno(),4096)
                if not chunk:selector.unregister(key.fileobj);continue
                output[key.fileobj].extend(chunk)
                if len(output[key.fileobj])>16384:raise ValueError('transport output limit')
        if process.wait(timeout=5):raise ValueError('remote installation refused')
        return bytes(output[process.stdout])
    finally:
        selector.close()
        if process.poll() is None:process.kill();process.wait()
        process.stdout.close();process.stderr.close()


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--artifact',type=Path,required=True);args=parser.parse_args()
    ctx=context(os.environ,args.artifact)
    if subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()!=ctx['revision']:raise ValueError('checkout pin')
    sources={name:(ROOT/name).read_text() for name in SOURCES}
    receiver=(ROOT/'ops/uat/receive-install.py').read_text()
    prepare=types.ModuleType('uat_prepare');exec(compile(sources['ops/uat/prepare-host.py'],'reviewed-prepare','exec'),prepare.__dict__)
    ctx['expanded']=prepare.inspect_archive(args.artifact,ctx['digest'],ctx['revision'])
    # Ensure installed/executed sources still match the immutable checkout, not a build side effect.
    for name in (*SOURCES,'ops/uat/receive-install.py'):
        if subprocess.check_output(['git','show',ctx['revision']+':'+name],cwd=ROOT)!=(ROOT/name).read_bytes():raise ValueError('source drift')
    payload=receiver+'\nmain('+repr(ctx)+','+repr(sources)+')\n'
    code="import base64;exec(compile(base64.b64decode("+repr(base64.b64encode(payload.encode()).decode())+"),'reviewed-uat-receiver','exec'))"
    command=['tailscale','ssh','root@hermes','python3 -I -B -c '+shlex.quote(code)]
    with args.artifact.open('rb') as stream:raw=bounded(command,stream)
    receipt=json.loads(raw)
    if receipt.get('ok') is not True or receipt.get('revision')!=ctx['revision'] or receipt.get('action')!='installed-not-started':raise ValueError('receipt mismatch')
    print(json.dumps(receipt,sort_keys=True))


if __name__=='__main__':
    try:main()
    except Exception:
        print(json.dumps({'ok':False,'error':'UAT install transport refused or incomplete. Do not retry; inspect retained state.'}))
        raise SystemExit(1)
