#!/usr/bin/env python3
"""Exact-main first-attempt source-only transport to the approved UAT host."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess

ROOT=Path(__file__).resolve().parents[2]
SOURCES=('ops/uat/activate-host.py','ops/uat/bubblewash-uat.service','scripts/uat-isolation-check.mjs','scripts/uat-prioritize-fixture.mjs','ops/add-uat-host.py','ops/uat/inspect-activation.py')
PIN='e7de6a5ea121b50b3ae691451fe9377466d7bba7ca5748009f6612a10194b735'

def context(env):
    if env.get('GITHUB_REPOSITORY')!='bechirobob/bubble-wash' or env.get('GITHUB_REF')!='refs/heads/main' or env.get('GITHUB_EVENT_NAME')!='workflow_dispatch' or env.get('GITHUB_RUN_ATTEMPT')!='1':raise ValueError('scope')
    source=env.get('SOURCE_SHA','');runtime=env.get('RUNTIME_SHA','');mode=env.get('UAT_ACTION','');run=env.get('GITHUB_RUN_ID','')
    if not re.fullmatch('[a-f0-9]{40}',source) or source!=env.get('GITHUB_SHA') or not re.fullmatch('[a-f0-9]{40}',runtime) or not re.fullmatch('[1-9][0-9]{0,19}',run):raise ValueError('pin')
    if mode not in ('check','start','route-check','route-activate','inspect','repair-app-traversal','resume-fixture-priority') or env.get('EXPECTED_CADDY_SHA')!=PIN:raise ValueError('mode/config pin')
    return {'source':source,'runtime':runtime,'runId':run,'mode':mode,'caddy':PIN}

def receipt(raw,ctx):
    if len(raw)>16384:raise ValueError('receipt bounds')
    expected={'ok':True,'mode':ctx['mode'],'source':ctx['source'],'runtime':ctx['runtime'],'accountsIssued':False,'automaticRetry':False}
    value=json.loads(raw)
    if ctx['mode']=='inspect':
        spec=importlib.util.spec_from_file_location('uat_diagnostics',ROOT/'ops/uat/inspect-activation.py')
        diagnostic=importlib.util.module_from_spec(spec);spec.loader.exec_module(diagnostic)
        expected['diagnostics']=diagnostic.validate_receipt(value.get('diagnostics'))
    if value!=expected:raise ValueError('receipt mismatch')
    return expected

def main():
    ctx=context(os.environ)
    if subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()!=ctx['source']:raise ValueError('checkout pin')
    for name in (*SOURCES,'ops/uat/receive-activate.py','ops/uat/transport-install.py','ops/uat/transport-activate.py'):
        if subprocess.check_output(['git','show',ctx['source']+':'+name],cwd=ROOT)!=(ROOT/name).read_bytes():raise ValueError('source drift')
    sources={name:(ROOT/name).read_text() for name in SOURCES}
    receiver=(ROOT/'ops/uat/receive-activate.py').read_text()
    payload=receiver+'\nmain('+repr(ctx)+','+repr(sources)+')\n'
    code="import base64;exec(compile(base64.b64decode("+repr(base64.b64encode(payload.encode()).decode())+"),'reviewed-uat-activation','exec'))"
    spec=importlib.util.spec_from_file_location('bounded_transport',ROOT/'ops/uat/transport-install.py')
    helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
    with open(os.devnull,'rb') as stream:
        raw=helper.bounded(['tailscale','ssh','root@hermes','python3 -I -B -c '+shlex.quote(code)],stream)
    print(json.dumps(receipt(raw,ctx),sort_keys=True))

if __name__=='__main__':
    try:main()
    except Exception:
        print('{"ok":false,"automaticRetry":false,"message":"UAT action refused or uncertain; inspect retained state."}')
        raise SystemExit(1)
