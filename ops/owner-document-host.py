"""Streamed app-UID check/one-shot sealed enrollment. Never installed on the host."""
import base64
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import resource
import selectors
import select
import signal
import sqlite3
import subprocess
import sys
import time

core = guards = scanner = preflight = facts = operator = pins = None
CAPSULE = ''
NODE = '/usr/bin/node'
NODE_SHA256 = '81925c0995b5c1427b5d538e6a90ca2fdc4daffb786b09af749beaf7369d4e90'
SCHEMA_SHA256 = '62b51a2805e8741807f8377759e221d3a7f72358793658c77ee7474223eed13c'
STAGE = 'request'
ATTEMPTED = False


def require(value):
    if not value: raise ValueError('owner operation refused')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def validate(request):
    require(type(request) is dict and set(request) == {'mode','approved','recipient','context','publicKey','backup'})
    require(request['mode'] in ('check','issue-document') and type(request['approved']) is bool)
    require(request['mode'] == 'check' or request['approved'])
    person = request['recipient']
    require(type(person) is dict and set(person) == {'email','name'})
    require(type(person['email']) is str and len(person['email']) <= 160 and person['email'] == person['email'].strip().lower() and
            re.fullmatch(r'[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+', person['email']))
    require(type(person['name']) is str and 0 < len(person['name']) <= 100 and person['name'] == person['name'].strip() and not any(c in person['name'] for c in '\r\n\0'))
    ctx = request['context']
    require(type(ctx) is dict and set(ctx) == {'controlSha','runtimeSha','runId','runAttempt','actor'})
    require(all(type(ctx[k]) is str and re.fullmatch('[a-f0-9]{40}',ctx[k]) for k in ('controlSha','runtimeSha')) and
            ctx['runtimeSha'] == pins['runtimeSha'] and ctx['runAttempt'] == '1' and re.fullmatch('[1-9][0-9]{0,19}',ctx['runId']) and
            re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?',ctx['actor']))
    require(type(request['publicKey']) is str and len(request['publicKey']) <= 4096)
    if request['mode'] == 'issue-document':
        public_der(request['publicKey'])
        backup=request['backup'];require(type(backup) is dict and set(backup)=={'sha256','runId','storeSha','storeId'})
        require(re.fullmatch('[a-f0-9]{64}',backup['sha256']) and re.fullmatch('[a-f0-9]{40}',backup['storeSha']) and
                re.fullmatch('[1-9][0-9]*',backup['runId']) and type(backup['storeId']) is int and backup['storeId']>0)
    else: require(request['publicKey']=='' and request['backup'] is None)
    return request


def public_der(pem):
    require(pem.startswith('-----BEGIN PUBLIC KEY-----\n') and pem.rstrip().endswith('\n-----END PUBLIC KEY-----'))
    body=''.join(pem.strip().splitlines()[1:-1]);raw=base64.b64decode(body,validate=True)
    require(300<len(raw)<1024 and base64.b64encode(raw).decode()==body)
    return raw


def context(request):
    return {k:request['context'][k] for k in ('controlSha','runAttempt','runId','runtimeSha')}


def envelope(raw, request):
    require(0<len(raw)<=16384);value=json.loads(raw)
    require(type(value) is dict and set(value)=={'schema','context','keySha256','wrappedKey','iv','tag','ciphertext'})
    require(value['schema']=='bubblewash-owner-document/v1' and value['context']==context(request) and
            value['keySha256']==hashlib.sha256(public_der(request['publicKey'])).hexdigest() and canonical(value)==raw)
    for name,length in (('wrappedKey',384),('iv',12),('tag',16),('ciphertext',None)):
        require(type(value[name]) is str);data=base64.b64decode(value[name],validate=True)
        require(base64.b64encode(data).decode()==value[name] and (len(data)==length if length else 0<len(data)<8192))
    return value


def inspect_database(database, email, values, sql, owner):
    guards.database_identity(database,owner)
    with database.open('rb') as handle: header=handle.read(100)
    require(len(header)==100 and header.startswith(b'SQLite format 3\0') and not Path(str(database)+'-journal').exists())
    if header[18:20]==b'\x02\x02' or Path(str(database)+'-wal').exists():
        require(all(Path(str(database)+suffix).is_file() and not Path(str(database)+suffix).is_symlink() for suffix in ('-wal','-shm')))
    _, expected=guards.approved_schema(sql,SCHEMA_SHA256)
    connection=sqlite3.connect(database.as_uri()+'?mode=ro',uri=True,timeout=5,isolation_level=None)
    try:
        connection.execute('PRAGMA trusted_schema=OFF');connection.execute('PRAGMA query_only=ON');connection.execute('BEGIN')
        schema=guards.schema(connection);tables=[name for kind,name,_,_ in schema if kind=='table' and not name.startswith('sqlite_')]
        require(not any(kind in ('view','trigger') for kind,_,_,_ in schema) and set(tables)<=preflight.TABLES|guards.TABLES)
        research=[row for row in schema if row[1] in guards.OBJECTS or row[2] in guards.TABLES or row[1].startswith('research_')]
        require(research==expected and 'staff_owner_capabilities' in tables)
        require(connection.execute('PRAGMA quick_check').fetchall()==[('ok',)] and not connection.execute('PRAGMA foreign_key_check').fetchall())
        collision=preflight.owner_collision_report(connection,tables,email,values)
        require(collision.get('inspected') is True)
        return collision,hashlib.sha256(canonical(schema)).hexdigest()
    finally: connection.close()


def invoke_capsule(node, release, request, before_commit, child_env, timeout=45):
    wire=canonical(request)+b'\n';require(len(wire)<=16384)
    process=subprocess.Popen([node,'--conditions=react-server','--experimental-strip-types','--input-type=module','-e',CAPSULE+'\nawait main();'],
                             cwd=release,env=child_env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,bufsize=0)
    out,err=bytearray(),bytearray();approved=False;started=time.monotonic()
    def write_input(data):
        os.set_blocking(process.stdin.fileno(),False)
        pending=memoryview(data)
        while pending:
            require(time.monotonic()-started<timeout)
            if select.select([], [process.stdin], [], 0.1)[1]:
                count=os.write(process.stdin.fileno(),pending[:4096]);require(count>0);pending=pending[count:]
    try:
        write_input(wire)
        with selectors.DefaultSelector() as poll:
            for pipe in (process.stdout,process.stderr):os.set_blocking(pipe.fileno(),False);poll.register(pipe,selectors.EVENT_READ)
            while poll.get_map():
                require(time.monotonic()-started<timeout)
                for event,_ in poll.select(0.1):
                    pipe=event.fileobj;chunk=os.read(pipe.fileno(),65536)
                    if not chunk:poll.unregister(pipe);continue
                    target=out if pipe is process.stdout else err;target.extend(chunk);require(len(target)<=16384)
                    if pipe is process.stdout and not approved and b'\n' in out:
                        require(bytes(out)==b'READY\n');before_commit()
                        write_input(b'COMMIT\n');process.stdin.close();approved=True;out.clear()
        require(process.wait(timeout=1)==0 and approved)
        return bytes(out)
    finally:
        if process.poll() is None:
            os.killpg(process.pid,signal.SIGKILL);process.wait()
        for pipe in (process.stdin,process.stdout,process.stderr):
            if pipe is not None and not pipe.closed:pipe.close()


def operation(request, owner, lock_unchanged):
    global STAGE,ATTEMPTED
    STAGE='source';release=core.CURRENT.resolve(strict=True)
    require(release.parent==core.HOME/'bubblewash-releases')
    marker_path=core.RUNTIME/'current-release';marker_raw=guards.inspect_read(marker_path,owner,'current');marker=core.parse(marker_raw)
    require(marker.get('sha')==request['context']['runtimeSha'] and marker.get('path')==str(release) and
            guards.inspect_read(release/'.release-sha',owner,'current',128).decode().strip()==request['context']['runtimeSha'])
    files,source_identity=scanner.source_snapshot(release,owner);require(scanner.content_commitment(files)==pins['runtimeContent'])
    STAGE='configuration';raw,env_identity=guards.environment_snapshot(core.ENV,owner,None);config_hash=hashlib.sha256(raw).hexdigest();values=core.parse(raw)
    scanner.open_configuration(values)
    require(preflight.owner_delivery_configuration(values)['personalMfaKeyReady'] and not (release/'data/submissions.jsonl').exists())
    database=Path(values.get('BUBBLEWASH_DATABASE_PATH',''));require(database.is_absolute() and not database.is_relative_to(release))
    db_identity=guards.database_identity(database,owner);sql=(release/'db/proposed/research-v1.sql').read_bytes()
    STAGE='runtime';node=facts.trusted_executable(NODE);require(node==NODE and facts.source(node,0,128*1024*1024)['sha256']==NODE_SHA256)
    require(re.fullmatch(rb'v22\.\d+\.\d+\n',facts.bounded([node,'--version'],limit=128)))
    operator.verify_source(facts,release,{},owner.pw_uid);operator.verify_runtime(facts,preflight,release,node,owner.pw_uid,database)
    guards.runtime_flags(release,values,True)
    def bound():
        lock_unchanged();require(core.CURRENT.resolve(strict=True)==release and guards.inspect_read(marker_path,owner,'current')==marker_raw)
        actual,identity=scanner.source_snapshot(release,owner);require(scanner.content_commitment(actual)==pins['runtimeContent'] and identity==source_identity)
        require(guards.environment_snapshot(core.ENV,owner,config_hash)==(raw,env_identity) and guards.database_identity(database,owner)==db_identity)
    STAGE='collision';collision,schema_hash=inspect_database(database,request['recipient']['email'],values,sql,owner);bound()
    if collision['duplicatePresent']:
        return canonical({'ok':False,'state':'collision','duplicateTypes':collision['duplicateTypes'],'managedRole':collision['managedRole'],'managedStatus':collision['managedStatus'],'accountCreated':False,'retryPermitted':False})
    if request['mode']=='check':
        return canonical({'ok':True,'state':'clear','accountCreated':False,'retryPermitted':False})
    STAGE='backup';receipt_raw=guards.inspect_read(core.RECEIPT,owner,'backup');receipt=json.loads(receipt_raw);expected=request['backup']
    archive=Path(values.get('BUBBLEWASH_BACKUP_OFFSITE_DIR',''))/receipt['filename'];status=Path(values.get('BUBBLEWASH_BACKUP_STATUS_PATH',''))
    require(archive.is_absolute() and status.is_absolute())
    def backup():
        require(guards.inspect_read(core.RECEIPT,owner,'backup')==receipt_raw and receipt.get('sha256')==expected['sha256'] and
                not archive.is_symlink() and archive.is_file() and archive.stat().st_size==receipt['size'] and core.digest(archive)==expected['sha256'])
        core.verify_receipt(receipt,json.loads(status.read_bytes()),time.time(),expected['runId'],expected['storeSha'],expected['storeId'])
    backup();bound()
    env={key:values[key] for key in ('NODE_ENV','BUBBLEWASH_STAFF_AUTH_DISABLED','BUBBLEWASH_DISABLE_DEMO_LOGIN',
         'BUBBLEWASH_ADMIN_EMAIL','BUBBLEWASH_VENDOR_EMAIL','BUBBLEWASH_DRIVER_EMAIL','BUBBLEWASH_SUPPORT_EMAIL') if key in values}
    env['NODE_ENV']='production';env['BUBBLEWASH_DATABASE_PATH']=str(database)
    capsule_request={**request['recipient'],'actor':'github-actions:'+request['context']['actor'],'release':str(release),'dbPath':str(database),
                     'env':env,'context':context(request),'publicKey':request['publicKey'],'schemaSha256':schema_hash}
    def before_commit():
        bound();backup();operator.verify_runtime(facts,preflight,release,node,owner.pw_uid,database)
    STAGE='issuance';ATTEMPTED=True
    encrypted=invoke_capsule(node,release,capsule_request,before_commit,{'PATH':'/usr/bin:/bin','HOME':str(core.HOME),**env})
    envelope(encrypted,request);bound()
    return encrypted


def main(request):
    global STAGE
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    def timeout(*_):raise TimeoutError()
    signal.signal(signal.SIGALRM,timeout);signal.alarm(150)
    try:
        validate(request);require(os.geteuid()==0);owner=pwd.getpwnam('ubuntu');require(owner.pw_uid>0)
        with core.deployment_lock(core.RUNTIME,owner.pw_uid) as unchanged:
            def run():
                result=operation(request,owner,unchanged);unchanged();sys.stdout.buffer.write(result);sys.stdout.buffer.flush()
            guards.app_operation(owner,run)
    except BaseException:
        sys.stdout.write(json.dumps({'ok':False,'state':'outcome-uncertain-stop' if ATTEMPTED else 'blocked','stage':STAGE,'retryPermitted':False}))
        raise SystemExit(1)
    finally:signal.alarm(0)
