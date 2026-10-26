#!/usr/bin/env python3
"""New isolated UAT only; never changes routing, issues logins or touches other services.
Default is verification only. Failed activation retains its marker and requires review.
"""
import argparse
import base64
import sqlite3
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

def eval_capsule(source):
    # systemd expands dollar expressions in ExecStart arguments even without a shell.
    # Transport code as base64 so JS template strings and regex anchors are opaque.
    if len(source.encode())>131072:raise ValueError('Capsule size limit')
    return "await import('data:text/javascript;base64,"+base64.b64encode(source.encode()).decode()+"')"

def pristine_seed():
    database=DATA/'uat.sqlite'
    if set(p.name for p in DATA.iterdir())!={'cache','uat.sqlite'} or database.is_symlink() or not database.is_file() or database.resolve()!=database:
        raise ValueError('Expected closed pristine seeded database')
    db=sqlite3.connect(database.as_uri()+'?mode=ro&immutable=1',uri=True,timeout=2)
    try:
        db.execute('PRAGMA query_only=ON');db.execute('PRAGMA trusted_schema=OFF')
        if db.execute('SELECT 1 FROM submissions LIMIT 1').fetchone():raise ValueError('Existing submissions')
        for table in ('staff_uat_accounts','uat_sealed_handover'):
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone() and db.execute('SELECT 1 FROM '+table+' LIMIT 1').fetchone():raise ValueError('Existing issuance')
        vendors=db.execute('SELECT vendor_id,vendor_name,capacity_remaining,availability_status,service_zones,service_types FROM vendor_availability ORDER BY vendor_id').fetchall()
        drivers=db.execute('SELECT driver_id,driver_name,capacity_remaining,availability_status,service_zones FROM driver_availability ORDER BY driver_id').fetchall()
        expected_v=[('uat-vendor-'+suffix,'UAT Laundry '+suffix,20,'available','["Osu"]','["Wash + fold"]') for suffix in ('one','two')]
        expected_d=[('uat-driver-'+suffix,'UAT Driver '+suffix,20,'active','["Osu"]') for suffix in ('one','two')]
        if vendors!=expected_v or drivers!=expected_d:raise ValueError('Seed differs from pristine fixture')
    finally:db.close()

def transient(unit, suffix, command):
    run(['/usr/bin/systemd-run','--unit=bubblewash-uat-'+suffix,'--wait','--pipe','--quiet','--collect',
         *sandbox_properties(unit),*command],timeout=120)

def verify(revision, allow_legacy_marker=False, allow_priority_resume=False):
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
    if allow_priority_resume:pristine_seed()
    elif set(p.name for p in DATA.iterdir())!={'cache'}: raise ValueError('Existing data requires recovery review')
    marker=CONFIG/'activation-started.json'
    if marker.exists():
        if not (allow_legacy_marker or allow_priority_resume): raise ValueError('Activation already attempted')
        trusted(marker,0o600)
        expected={'revision':revision,'accountsIssued':False}
        if allow_priority_resume:expected['stage']='synthetic-priority'
        if json.loads(marker.read_text())!=expected:raise ValueError('Unexpected recovery marker')
    elif allow_legacy_marker or allow_priority_resume:raise ValueError('Expected original failed attempt')
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

def activate(revision, resume_priority=False):
    unit,newenv=verify(revision,allow_priority_resume=True) if resume_priority else verify(revision)
    if resume_priority:
        trusted(APP,0o755);trusted(APP/'.next/cache',0o755)
        loaded_unit()
        if run(['/usr/bin/ss','-H','-ltnp','sport = :3108'],capture=True).stdout.strip():raise ValueError('Port occupied')
        old=CONFIG/'activation-started.json';saved=CONFIG/'activation-before-priority-resume.json'
        fd=os.open(saved,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as stream:stream.write(old.read_bytes());stream.flush();os.fsync(stream.fileno())
        directory=os.open(CONFIG,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(directory)
        finally:os.close(directory)
        old.unlink() # Durable original evidence retained; this resume cannot repeat.
    marker=CONFIG/'activation-started.json'
    fd=os.open(marker,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as stream: stream.write(json.dumps({'revision':revision,'accountsIssued':False})+'\n')
    def stage(name):
        temp=CONFIG/'activation-stage-new.json'
        descriptor=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(descriptor,'w') as out:
            out.write(json.dumps({'revision':revision,'accountsIssued':False,'stage':name})+'\n');out.flush();os.fsync(out.fileno())
        os.replace(temp,marker)
    started=False
    try:
        stage('unit-verification')
        run(['/usr/bin/systemd-analyze','verify',str(UNIT)])
        stage('daemon-reload')
        run(['/usr/bin/systemctl','daemon-reload'])
        loaded_unit()
        probe=Path(__file__).parents[2]/'scripts/uat-isolation-check.mjs'
        stage('isolation-probe')
        transient(unit,'isolation-check',['/usr/bin/node','--input-type=module','--eval',eval_capsule(probe.read_text())])
        if not resume_priority:
            stage('synthetic-seed')
            transient(unit,'seed',['/usr/bin/node','--conditions=react-server','--experimental-strip-types','scripts/uat-seed.mjs','--approved-synthetic-only'])
        stage('synthetic-priority')
        priority=Path(__file__).parents[2]/'scripts/uat-prioritize-fixture.mjs'
        transient(unit,'fixture-priority',['/usr/bin/node','--conditions=react-server','--experimental-strip-types','--input-type=module','--eval',eval_capsule(priority.read_text())])
        stage('environment-enable')
        # Atomic config replacement, preserving the session secret without logging it.
        temp=CONFIG/'environment.activation-new'
        fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'w') as stream: stream.write(newenv); stream.flush(); os.fsync(stream.fileno())
        os.replace(temp,CONFIG/'environment')
        stage('service-start')
        started=True
        run(['/usr/bin/systemctl','start',SERVICE])
        stage('http-checks')
        checks()
        stage('listener-check')
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
    stage('complete')
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
