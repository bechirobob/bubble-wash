"""Fixed UAT-only sealed issuance. Invoked over captured SSH, never directly logged."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import pwd
import re
import resource
import stat
import sqlite3
import subprocess

APP=Path('/opt/bubblewash-uat/app'); CONFIG=Path('/etc/bubblewash-uat')
SERVICE='bubblewash-uat.service'
UNIT=Path('/etc/systemd/system/bubblewash-uat.service')
DATABASE=Path('/var/lib/bubblewash-uat/uat.sqlite')

def require(value):
    if not value: raise ValueError('UAT handoff refused')

def protected(path):
    for p in (path,*path.parents):
        info=p.lstat();require(not stat.S_ISLNK(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022)

def environment(raw):
    rows={}
    for line in raw.splitlines():
        if not line:continue
        key,sep,value=line.partition('=');require(sep and key not in rows);rows[key]=value
    allowed={'BUBBLEWASH_UAT_ENABLED','BUBBLEWASH_UAT_ISOLATION_CONFIRMED','BUBBLEWASH_PUBLIC_URL','BUBBLEWASH_UAT_DATA_ROOT','BUBBLEWASH_DATABASE_PATH','BUBBLEWASH_DATABASE_DRIVER','BUBBLEWASH_SESSION_SECRET','BUBBLEWASH_DISABLE_DEMO_LOGIN','BUBBLEWASH_STAFF_AUTH_DISABLED','BUBBLEWASH_BOOKINGS_DISABLED','NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED','NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED','BUBBLEWASH_RESEARCH_EMAIL_ENABLED','BUBBLEWASH_TRUST_PROXY_HEADERS','BUBBLEWASH_TRUST_EDGE_HEADERS','NEXT_TELEMETRY_DISABLED'}
    require(set(rows)==allowed)
    expected={'BUBBLEWASH_UAT_ENABLED':'true','BUBBLEWASH_UAT_ISOLATION_CONFIRMED':'true','BUBBLEWASH_PUBLIC_URL':'https://uat.bubblewash.co','BUBBLEWASH_UAT_DATA_ROOT':'/var/lib/bubblewash-uat','BUBBLEWASH_DATABASE_PATH':'/var/lib/bubblewash-uat/uat.sqlite','BUBBLEWASH_DATABASE_DRIVER':'sqlite','BUBBLEWASH_DISABLE_DEMO_LOGIN':'true','BUBBLEWASH_STAFF_AUTH_DISABLED':'false','BUBBLEWASH_BOOKINGS_DISABLED':'false','NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED':'false','NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED':'false','BUBBLEWASH_RESEARCH_EMAIL_ENABLED':'false','BUBBLEWASH_TRUST_PROXY_HEADERS':'false','BUBBLEWASH_TRUST_EDGE_HEADERS':'false','NEXT_TELEMETRY_DISABLED':'1'}
    require(all(rows[k]==v for k,v in expected.items()) and re.fullmatch('[A-Za-z0-9_-]{64}',rows['BUBBLEWASH_SESSION_SECRET']))
    return dict(rows,PATH='/usr/bin:/bin',HOME='/var/lib/bubblewash-uat',NODE_ENV='production')

def readiness():
    conn=http.client.HTTPConnection('127.0.0.1',3108,timeout=5)
    try:
        conn.request('GET','/api/uat/ready',headers={'Host':'uat.bubblewash.co'})
        response=conn.getresponse();raw=response.read(4097);require(len(raw)<=4096)
        body=json.loads(raw);require(body.get('environment')=='isolated-uat' and body.get('externalProviders')=='disabled' and body.get('productionReady') is False)
        return response.status,body.get('ok')
    finally:conn.close()

def sandbox_properties(unit):
    section=None;values=[]
    for raw in unit.splitlines():
        row=raw.strip()
        if not row or row.startswith('#'):continue
        if row.startswith('['):section=row;continue
        if section=='[Service]':
            key,_,value=row.partition('=')
            if key not in ('ExecStart','Restart','RestartSec','Type'):values.extend(['--property',key+'='+value])
    require(values)
    return values+['--property','LimitCORE=0','--property','SupplementaryGroups=']


def service_identity():
    result=subprocess.run(['/usr/bin/systemctl','show',SERVICE,'-p','ActiveState','-p','FragmentPath','-p','DropInPaths','-p','MainPID'],capture_output=True,timeout=10)
    require(result.returncode==0)
    values=dict(line.split('=',1) for line in result.stdout.decode().splitlines())
    require(values.get('ActiveState')=='active' and values.get('FragmentPath')==str(UNIT) and values.get('DropInPaths')=='' and re.fullmatch('[1-9][0-9]*',values.get('MainPID','')))
    result=subprocess.run(['/usr/bin/ss','-H','-ltnp','sport = :3108'],capture_output=True,timeout=10)
    lines=result.stdout.decode().splitlines();require(result.returncode==0 and len(lines)==1 and '127.0.0.1:3108' in lines[0] and ('pid='+values['MainPID']+',') in lines[0])


def issuance_counts():
    # SQLite read-only mode includes any committed WAL, unlike immutable=1.
    # Query only fixed COUNTs, never identities, hashes, envelopes or customer data.
    path=DATABASE
    require(path.is_file() and not path.is_symlink() and path.resolve()==path)
    for suffix in ('-wal','-shm'):
        sibling=Path(str(path)+suffix)
        require(not sibling.is_symlink())
    database=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=2)
    try:
        database.execute('PRAGMA query_only=ON');database.execute('PRAGMA trusted_schema=OFF')
        database.execute('BEGIN')
        counts=[]
        for table in ('staff_uat_accounts','uat_sealed_handover'):
            exists=database.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone()
            counts.append(database.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] if exists else 0)
        require(all(type(value) is int and 0<=value<=1000 for value in counts))
        return tuple(counts)
    finally:database.close()

def main(request):
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    require(os.geteuid()==0 and request['mode'] in ('issue','retrieve','check') and request['approved'] is True and request['ready'] is True)
    require(re.fullmatch('[a-f0-9]{40}',request['runtimeSha']) and re.fullmatch('[a-f0-9]{64}',request['capsuleSha256']) and re.fullmatch('[a-f0-9]{64}',request['unitSha256']))
    for p in (APP/'SOURCE_REVISION',APP/'scripts/uat-sealed-handover.mjs',CONFIG/'environment',CONFIG/'activation-started.json',UNIT):protected(p)
    require((APP/'SOURCE_REVISION').read_text()==request['runtimeSha']+'\n')
    require(hashlib.sha256((APP/'scripts/uat-sealed-handover.mjs').read_bytes()).hexdigest()==request['capsuleSha256'])
    require(stat.S_IMODE((CONFIG/'environment').stat().st_mode)==0o600)
    environment((CONFIG/'environment').read_text())
    unit=UNIT.read_text();require(hashlib.sha256(unit.encode()).hexdigest()==request['unitSha256'])
    account=pwd.getpwnam('bubblewash-uat');require(account.pw_uid>0 and account.pw_shell=='/usr/sbin/nologin')
    service_identity()
    status,ready=readiness();require((status,ready)==(503,False) if request['mode']=='issue' else status in (200,503))
    if request['mode'] in ('check','issue'):
        require(issuance_counts()==(0,0))
    if request['mode']=='check':
        require((status,ready)==(503,False))
        print(json.dumps({'ok':True,'mode':'check','hostVerified':True,'localReadinessStatus':status,'localReady':ready,'uatAccountCount':0,'sealedPackageCount':0}));return
    payload={'action':request['mode'],'approved':True,'ready':True,'publicKey':request['publicKey']}
    command=['/usr/bin/systemd-run','--unit=bubblewash-uat-handoff','--wait','--pipe','--quiet','--collect',*sandbox_properties(unit),'/usr/bin/node','--conditions=react-server','--experimental-strip-types','scripts/uat-sealed-handover.mjs']
    result=subprocess.run(command,input=json.dumps(payload).encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'},timeout=90)
    require(result.returncode==0 and len(result.stdout)<=16384)
    if request['mode']=='issue':require(readiness()==(200,True))
    # Ciphertext only. The caller must capture this pipe and validate the envelope.
    print(result.stdout.decode().strip())
