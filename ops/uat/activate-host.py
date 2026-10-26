#!/usr/bin/env python3
"""New isolated UAT only; never changes routing, issues logins or touches other services.
Default is verification only. Failed activation retains its marker and requires review.
"""
import argparse
import http.client
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import time

APP=Path('/opt/bubblewash-uat/app')
DATA=Path('/var/lib/bubblewash-uat')
CONFIG=Path('/etc/bubblewash-uat')
UNIT=Path('/etc/systemd/system/bubblewash-uat.service')
SERVICE='bubblewash-uat.service'
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'}

def run(args, timeout=45, capture=False):
    return subprocess.run(args, check=True, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, env=ENV, timeout=timeout)

def trusted(path, mode=None):
    for item in (path,*path.parents):
        info=item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Untrusted installed path')
    if mode is not None and stat.S_IMODE(path.stat().st_mode)!=mode: raise ValueError('Wrong installed mode')

def environment(text):
    if not text.endswith('\n'): raise ValueError('Malformed environment termination')
    rows=text.splitlines(); values={}
    for row in rows:
        if not row: continue
        key,sep,value=row.partition('=')
        if not sep or key in values: raise ValueError('Malformed environment')
        values[key]=value
    expected={
        'BUBBLEWASH_UAT_ENABLED':'true','BUBBLEWASH_UAT_ISOLATION_CONFIRMED':'true',
        'BUBBLEWASH_PUBLIC_URL':'https://uat.bubblewash.co','BUBBLEWASH_UAT_DATA_ROOT':str(DATA),
        'BUBBLEWASH_DATABASE_PATH':str(DATA/'uat.sqlite'),'BUBBLEWASH_DATABASE_DRIVER':'sqlite',
        'BUBBLEWASH_DISABLE_DEMO_LOGIN':'true','BUBBLEWASH_STAFF_AUTH_DISABLED':'false',
        'BUBBLEWASH_BOOKINGS_DISABLED':'true','NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED':'false',
        'NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED':'false','BUBBLEWASH_RESEARCH_EMAIL_ENABLED':'false',
        'BUBBLEWASH_TRUST_PROXY_HEADERS':'false','BUBBLEWASH_TRUST_EDGE_HEADERS':'false','NEXT_TELEMETRY_DISABLED':'1'}
    secret=values.pop('BUBBLEWASH_SESSION_SECRET','')
    if values!=expected or not re.fullmatch(r'[A-Za-z0-9_-]{64}',secret): raise ValueError('Unsafe environment')
    return text.replace('BUBBLEWASH_BOOKINGS_DISABLED=true\n','BUBBLEWASH_BOOKINGS_DISABLED=false\n')

def sandbox_properties(unit):
    section=None; values=[]
    for raw in unit.splitlines():
        row=raw.strip()
        if not row or row.startswith('#'): continue
        if row.startswith('['): section=row; continue
        if section=='[Service]':
            key,_,value=row.partition('=')
            if key not in ('ExecStart','Restart','RestartSec','Type'): values.extend(['--property',key+'='+value])
    if '--property' not in values: raise ValueError('Missing sandbox')
    return values

def transient(unit, suffix, command):
    run(['/usr/bin/systemd-run','--unit=bubblewash-uat-'+suffix,'--wait','--pipe','--quiet','--collect',
         *sandbox_properties(unit),*command],timeout=120)

def verify(revision):
    if not re.fullmatch('[0-9a-f]{40}',revision): raise ValueError('Exact revision required')
    for path in (APP/'SOURCE_REVISION',APP/'scripts/uat-seed.mjs',APP/'.next/BUILD_ID',CONFIG/'release.json',CONFIG/'environment',UNIT): trusted(path)
    trusted(CONFIG/'environment',0o600)
    if (APP/'SOURCE_REVISION').read_text()!=revision+'\n': raise ValueError('Revision mismatch')
    if json.loads((CONFIG/'release.json').read_text())!={'revision':revision,'state':'installed-not-started','accountsIssued':False}: raise ValueError('Receipt mismatch')
    reviewed=Path(__file__).with_name('bubblewash-uat.service').read_bytes()
    if UNIT.read_bytes()!=reviewed: raise ValueError('Unit differs from reviewed restrictions')
    if Path(str(UNIT)+'.d').exists() or Path('/run/systemd/system/'+SERVICE).exists() or Path('/run/systemd/system/'+SERVICE+'.d').exists(): raise ValueError('Unit override present')
    account=pwd.getpwnam('bubblewash-uat')
    if account.pw_shell!='/usr/sbin/nologin' or account.pw_dir!=str(DATA) or account.pw_uid==0: raise ValueError('Wrong account')
    if DATA.is_symlink() or DATA.stat().st_uid!=account.pw_uid: raise ValueError('Wrong isolated data owner')
    if set(p.name for p in DATA.iterdir())!={'cache'}: raise ValueError('Existing data requires recovery review')
    if (CONFIG/'activation-started.json').exists(): raise ValueError('Activation already attempted')
    state=run(['/usr/bin/systemctl','show',SERVICE,'-p','ActiveState','-p','DropInPaths'],capture=True).stdout.decode()
    if set(state.strip().splitlines())!={'ActiveState=inactive','DropInPaths='}: raise ValueError('Existing activity or overrides')
    return reviewed.decode(), environment((CONFIG/'environment').read_text())

def loaded_unit():
    state=run(['/usr/bin/systemctl','show',SERVICE,'-p','FragmentPath','-p','DropInPaths'],capture=True).stdout.decode()
    if set(state.strip().splitlines())!={'FragmentPath='+str(UNIT),'DropInPaths='}:
        raise ValueError('Loaded unit differs or has inherited overrides')

def request(path):
    connection=http.client.HTTPConnection('127.0.0.1',3108,timeout=3)
    try:
        connection.request('GET',path,headers={'Host':'uat.bubblewash.co'})
        response=connection.getresponse(); body=response.read(131073)
        if len(body)>131072: raise ValueError('Oversized response')
        return response.status,body
    finally: connection.close()

def checks():
    until=time.monotonic()+45
    while True:
        try:
            status,body=request('/api/health')
            if status==200: break
        except (OSError,http.client.HTTPException): pass
        if time.monotonic()>=until: raise ValueError('Health timeout')
        time.sleep(1)
    status,body=request('/login')
    if status!=200 or b'UAT' not in body or b'username' not in body.lower(): raise ValueError('Wrong login')
    if request('/api/staff/accounts')[0]!=403: raise ValueError('Anonymous staff access')
    status,body=request('/api/uat/ready')
    if status!=503 or json.loads(body).get('environment')!='isolated-uat': raise ValueError('Unexpected account readiness')

def activate(revision):
    unit,newenv=verify(revision)
    marker=CONFIG/'activation-started.json'
    fd=os.open(marker,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as stream: stream.write(json.dumps({'revision':revision,'accountsIssued':False})+'\n')
    started=False
    try:
        run(['/usr/bin/systemd-analyze','verify',str(UNIT)])
        run(['/usr/bin/systemctl','daemon-reload'])
        loaded_unit()
        probe=Path(__file__).parents[2]/'scripts/uat-isolation-check.mjs'
        transient(unit,'isolation-check',['/usr/bin/node','--input-type=module','--eval',probe.read_text()])
        transient(unit,'seed',['/usr/bin/node','--conditions=react-server','--experimental-strip-types','scripts/uat-seed.mjs','--approved-synthetic-only'])
        # Atomic config replacement, preserving the session secret without logging it.
        temp=CONFIG/'environment.activation-new'
        fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'w') as stream: stream.write(newenv); stream.flush(); os.fsync(stream.fileno())
        os.replace(temp,CONFIG/'environment')
        started=True
        run(['/usr/bin/systemctl','start',SERVICE])
        checks()
        run(['/usr/bin/systemctl','is-active','--quiet',SERVICE])
        pid=run(['/usr/bin/systemctl','show',SERVICE,'-p','MainPID','--value'],capture=True).stdout.decode().strip()
        if not pid.isdigit() or int(pid)<=1: raise ValueError('No UAT main process')
        listeners=run(['/usr/bin/ss','-H','-ltnp','sport = :3108'],capture=True).stdout.decode().splitlines()
        if len(listeners)!=1 or '127.0.0.1:3108' not in listeners[0] or ('pid='+pid+',') not in listeners[0]: raise ValueError('Wrong UAT listener owner')
    except Exception:
        if started:
            try: run(['/usr/bin/systemctl','stop',SERVICE])
            except Exception: pass
        raise
    return {'ok':True,'revision':revision,'state':'started-isolated-awaiting-accounts','accountsIssued':False,'routingChanged':False}

def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--revision',required=True); parser.add_argument('--apply',action='store_true')
    args=parser.parse_args()
    if os.geteuid()!=0: raise ValueError('Root operator required')
    if args.apply: result=activate(args.revision)
    else: verify(args.revision); result={'ok':True,'readOnly':True,'activationPlanned':True}
    print(json.dumps(result))

if __name__=='__main__':
    try: main()
    except Exception:
        print('{"ok":false,"message":"UAT activation blocked; retain partial state for review, do not retry blindly."}')
        raise SystemExit(1)
