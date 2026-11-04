"""Fixed UAT receiver prepared for a separately approved, pinned transport.
No network requests. Source is loaded in memory by the reviewed bootstrap.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import sys


def dependencies():
    return sys.modules['uat_restore_preflight'],sys.modules['uat_restore_collector'],sys.modules['uat_restore_transport']


def node_request(bundle,request,operation):
    p,c,t=dependencies()
    source=bundle['scripts/uat-restore-original.mjs']
    # Exact static module specifiers only; no paths or code supplied in the private request.
    for name in ('uat-environment.ts','passwords.ts'):
        before="'../src/lib/"+name+"'"
        t.require(source.count(before)==1)
        source=source.replace(before,"'file:///opt/bubblewash-uat/app/src/lib/"+name+"'")
    t.require(source.count("import('better-sqlite3')")==1)
    source=source.replace("import('better-sqlite3')","import('file:///opt/bubblewash-uat/app/node_modules/better-sqlite3/lib/index.js')")
    source+='\nawait runOperator();\n'
    encoded=base64.b64encode(source.encode()).decode()
    script="await import('data:text/javascript;base64,"+encoded+"')"
    unit=c.read(p.UNIT,16384).decode();properties=[];section=None
    for raw in unit.splitlines():
        row=raw.strip()
        if not row or row.startswith('#'):continue
        if row.startswith('['):section=row;continue
        if section=='[Service]':
            key,sep,value=row.partition('=');t.require(sep)
            if key not in ('ExecStart','Restart','RestartSec','Type'):properties+=['--property',key+'='+value]
    properties+=['--property','LimitCORE=0','--property','SupplementaryGroups=','--property','RuntimeMaxSec=120s']
    command=['/usr/bin/systemd-run','--unit=bubblewash-uat-restore-'+operation+'-'+request['action'],
        '--wait','--pipe','--quiet','--collect',*properties,'/usr/bin/node','--conditions=react-server',
        '--experimental-strip-types','--input-type=module','--eval',script]
    raw=t.exchange(command,json.dumps(request).encode(),timeout=120)
    t.require(len(raw)<=16384)
    return json.loads(raw)


def execute(bundle,request):
    p,c,t=dependencies()
    t.require(os.geteuid()==0 and type(request) is dict)
    mode=request.get('mode');operation=request.get('operationId','')
    t.require(mode in ('inspect','restore','receipt') and t.UUID.fullmatch(operation))
    t.require(set(request)==({'mode','operationId','accounts'} if mode=='restore' else {'mode','operationId'}))
    pins=json.loads(bundle['ops/uat/restoration-runtime-pins.json'])
    if mode=='inspect':
        try:
            return c.collect(pins,eligible=True,private=True,timestamp_diagnostic=True)['public']
        except BaseException as error:
            return t.inspection_failure(error,bundle,'host-inspection')
    first=c.collect(pins,eligible=mode!='receipt',private=True)
    if mode=='receipt':return t.validate_receipt(json.dumps(node_request(bundle,{'action':'receipt','operationId':operation,'expectedDatabaseIdentity':first['private']['database']},operation)).encode(),'receipt')
    # Private snapshot output never reaches the runner's public receipt/log stream.
    snapshot=node_request(bundle,{'action':'inspect','expectedDatabaseIdentity':first['private']['database']},operation)
    t.require(type(snapshot) is dict and set(snapshot)=={'ok','eligible','fingerprint','inspectedAt','originalStartsAt','originalExpiresAt'})
    t.require(snapshot['ok'] is True and snapshot['eligible']==4 and re.fullmatch('[a-f0-9]{64}',snapshot['fingerprint']))
    t.require(snapshot['originalStartsAt']==p.ORIGINAL_START and snapshot['originalExpiresAt']==p.ORIGINAL_START+p.WINDOW)
    # Revalidate host/source/environment evidence, without refreshing private CAS.
    t.require(c.collect(pins,eligible=True,private=True)==first)
    payload={'action':'restore','operationId':operation,'inspectedAt':snapshot['inspectedAt'],
        'fingerprint':snapshot['fingerprint'],'accounts':request['accounts'],'expectedDatabaseIdentity':first['private']['database']}
    result=node_request(bundle,payload,operation)
    after=c.collect(pins,eligible=False,private=True)
    t.require(after['private']==first['private'])
    return t.validate_receipt(json.dumps(result).encode(),'restore')


def main(bundle):
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    try:
        raw=sys.stdin.buffer.read(16385)
        if len(raw)>16384:raise ValueError()
        request=json.loads(raw);raw=b''
        result=execute(bundle,request)
        for account in request.get('accounts',[]):account['password']=''
        # Only a validated fixed-schema receipt leaves the host.
        print(json.dumps(result,sort_keys=True))
    except BaseException:
        # A failed command may already have committed. Never infer safe retry.
        print('{"ok":false,"automaticRetry":false,"state":"uncertain-stop"}')
        raise SystemExit(1)
    # Diagnostics are observable failures, never successful preflight receipts.
    if result.get('ok') is False:raise SystemExit(1)
