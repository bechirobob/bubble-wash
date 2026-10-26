"""Bounded owner-invitation renewal; no service stop, configuration write or schema change."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import signal
import subprocess
import types

LIVE='f7305933b15a285bbd393a2057bf5d27e4b9985c'
STAGE='binding'
ATTEMPTED=False
base=old=modules=pins=None
CAPSULE=''

def require(value):
    if not value: raise ValueError('owner renewal refused')

def validate(request):
    require(type(request) is dict and set(request)=={'mode','approved','recipient','context','publicKey','backup','expectedFingerprint'})
    require(request['mode'] in ('check','renew-document'))
    mapped={k:v for k,v in request.items() if k!='expectedFingerprint'}
    mapped['mode']='issue-document' if request['mode']=='renew-document' else 'check'
    old.pins={'runtimeSha':LIVE};old.validate(mapped)
    require(request['expectedFingerprint']=='' if request['mode']=='check' else bool(re.fullmatch('[a-f0-9]{64}',request['expectedFingerprint'])))
    return request

def configuration(raw):
    values=modules['preserving'].parse(raw)
    require(values.get('NODE_ENV') in (None,'production') and values.get('BUBBLEWASH_BOOKINGS_DISABLED')=='true' and values.get('BUBBLEWASH_STAFF_AUTH_DISABLED')=='false' and values.get('BUBBLEWASH_DISABLE_DEMO_LOGIN')=='true')
    require(values.get('NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED')=='false')
    return values,raw

def make_host(request):
    base.LIVE=LIVE
    policy=types.SimpleNamespace(config=configuration,REMOVE_KEYS=frozenset(),CHECKPOINT='initial',CHECKPOINTS=())
    hostpins={'runtimeSha':LIVE,'runtimePins':pins['runtimePins']}
    if request['backup']:
        b=request['backup'];hostpins.update(backupSha256=b['sha256'],receiptRun=b['runId'],storeSha=b['storeSha'],storeId=str(b['storeId']))
    class RenewalHost(base.Host):
        def backup(self,values):
            if request['mode']=='renew-document':super().backup(values)
        def no_alternate_login_sources(self):pass # No environment alteration; effective runtime remains fully checked.
    return RenewalHost(hostpins,modules,policy)

def invoke(host,request,before_commit):
    """Private app-UID child, bounded captured pipes; parent retains root verification."""
    import selectors,select,time
    wire=old.canonical(request)+b'\n';require(len(wire)<=16384)
    env={'PATH':'/usr/bin:/bin','HOME':str(host.core.HOME),'NODE_ENV':'production','BUBBLEWASH_DATABASE_PATH':str(host.dbpath),'BUBBLEWASH_DISABLE_DEMO_LOGIN':'true','BUBBLEWASH_STAFF_AUTH_DISABLED':'false'}
    for k in ('BUBBLEWASH_ADMIN_EMAIL','BUBBLEWASH_VENDOR_EMAIL','BUBBLEWASH_DRIVER_EMAIL','BUBBLEWASH_SUPPORT_EMAIL'):
        if k in host.values:env[k]=host.values[k]
    process=subprocess.Popen(['/usr/bin/node','--conditions=react-server','--experimental-strip-types','--input-type=module','-e',CAPSULE+'\nawait main();'],cwd=host.current,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,bufsize=0,user=host.owner.pw_uid,group=host.owner.pw_gid,extra_groups=[])
    out,err=bytearray(),bytearray();approved=False;started=time.monotonic()
    def write(data):
        os.set_blocking(process.stdin.fileno(),False);pending=memoryview(data)
        while pending:
            require(time.monotonic()-started<45)
            if select.select([],[process.stdin],[],.1)[1]:
                count=os.write(process.stdin.fileno(),pending[:4096]);require(count>0);pending=pending[count:]
    try:
        write(wire)
        if request['mode']=='check':process.stdin.close()
        with selectors.DefaultSelector() as poll:
            for pipe in (process.stdout,process.stderr):os.set_blocking(pipe.fileno(),False);poll.register(pipe,selectors.EVENT_READ)
            while poll.get_map():
                require(time.monotonic()-started<45)
                for event,_ in poll.select(.1):
                    pipe=event.fileobj;chunk=os.read(pipe.fileno(),65536)
                    if not chunk:poll.unregister(pipe);continue
                    target=out if pipe is process.stdout else err;target.extend(chunk);require(len(target)<=16384)
                    if request['mode']=='renew-document' and pipe is process.stdout and not approved and b'\n' in out:
                        require(bytes(out)==b'READY\n');before_commit();write(b'COMMIT\n');process.stdin.close();approved=True;out.clear()
        require(process.wait(timeout=1)==0 and (approved if request['mode']=='renew-document' else not approved))
        return bytes(out)
    finally:
        if process.poll() is None:os.killpg(process.pid,signal.SIGKILL);process.wait()
        for pipe in (process.stdin,process.stdout,process.stderr):
            if not pipe.closed:pipe.close()

def result_valid(result):
    require(type(result) is dict and set(result)=={'eligible','fingerprint','state','role','allStaffAccess'})
    require(type(result['eligible']) is bool and type(result['allStaffAccess']) is bool)
    require(result['role'] in (None,'admin','vendor','driver','support','unknown'))
    require(result['state'] in ('missing','active','invited','suspended','archived','unknown'))
    require(type(result['fingerprint']) is str and re.fullmatch('[a-f0-9]{64}',result['fingerprint']))
    return result

def operation(request):
    global STAGE,ATTEMPTED
    validate(request);require(os.geteuid()==0 and pins['runtimePins']['runtimeSha']==LIVE)
    host=make_host(request)
    with host.locked():
        STAGE='preflight';raw=host.preflight()
        # Bind trusted Node binary/version independently before invoking reviewed code.
        require(Path('/usr/bin/node').resolve()==Path('/usr/bin/node'))
        info=Path('/usr/bin/node').stat();require(info.st_uid==0 and not info.st_mode&0o022)
        require(host.core.digest(Path('/usr/bin/node'))==old.NODE_SHA256)
        require(re.fullmatch(r'v22\.\d+\.\d+\n',host.core.command(['/usr/bin/node','--version'])))
        def bound():host.unchanged(raw);host.effective(host.values)
        bound()
        def inspect_schema():
            with host.database(readonly=True) as db:
                schema=db.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall()
                require(not any(row[0] in ('trigger','view') for row in schema))
                require(db.execute('PRAGMA quick_check').fetchall()==[('ok',)] and not db.execute('PRAGMA foreign_key_check').fetchall())
                return hashlib.sha256(old.canonical(schema)).hexdigest()
        schema_hash=host.as_app(inspect_schema)
        req={**request['recipient'],'mode':request['mode'],'statusFingerprint':request['expectedFingerprint'],'schemaSha256':schema_hash,'actor':'github-actions:'+request['context']['actor'],'release':str(host.current),'dbPath':str(host.dbpath),'context':old.context(request),'publicKey':request['publicKey'],'env':{**host.values,'NODE_ENV':'production'}}
        # Only required environment flags, never transport credentials, enter child stdin.
        req['env']={k:req['env'][k] for k in ('NODE_ENV','BUBBLEWASH_DISABLE_DEMO_LOGIN','BUBBLEWASH_STAFF_AUTH_DISABLED','BUBBLEWASH_ADMIN_EMAIL','BUBBLEWASH_VENDOR_EMAIL','BUBBLEWASH_DRIVER_EMAIL','BUBBLEWASH_SUPPORT_EMAIL') if k in req['env']}
        STAGE='status' if request['mode']=='check' else 'renewal';ATTEMPTED=request['mode']=='renew-document'
        result=invoke(host,req,bound);bound()
        if request['mode']=='check':return old.canonical(result_valid(json.loads(result)))
        old.envelope(result,request);return result

def main(request):
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    signal.signal(signal.SIGALRM,lambda *_: (_ for _ in ()).throw(TimeoutError()));signal.alarm(150)
    try:
        result=operation(request);os.write(1,result)
    except BaseException:
        print(json.dumps({'ok':False,'state':'outcome-uncertain-stop' if ATTEMPTED else 'blocked','stage':STAGE,'check':base.CHECKPOINT if base is not None and base.CHECKPOINT in base.CHECKPOINTS else 'initial','retryPermitted':False}));raise SystemExit(1)
    finally:signal.alarm(0)
