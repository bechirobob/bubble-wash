"""Synthetic local fixtures only. Never creates a production credential or sends mail."""
import ast
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import types
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
RUNTIME=Path(os.environ.get('OWNER_TEST_RUNTIME',str(ROOT.parent/'bubblewash-results-live-v1'))).resolve()

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

host=load('document_host','ops/owner-document-host.py')
transport=load('document_transport','ops/owner-document-transport.py')
core=load('preserving','ops/deploy-preserving.py')
guards=load('survey_guards','ops/deploy-survey-only.py');guards.core=core
preflight=load('preflight','scripts/release-preflight.py')
pins=json.loads((ROOT/'ops/survey-update-source-pins.json').read_bytes())
host.pins=pins;host.guards=guards;host.preflight=preflight
CONTEXT={'controlSha':'a'*40,'runtimeSha':pins['runtimeSha'],'runId':'123456','runAttempt':'1','actor':'fixture'}
REQUEST={'mode':'check','approved':False,'recipient':{'email':'new-owner@example.invalid','name':'Test Owner'},'context':CONTEXT,'publicKey':'','backup':None}

# This script creates ephemeral SYNTHETIC fixture key pairs only, never a handoff key.
NODE_TESTS=r'''
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,writeFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {spawnSync,spawn} from 'node:child_process';
const [capsulePath,release]=process.argv.slice(2);
const c=await import(pathToFileURL(capsulePath));
const dir=mkdtempSync(path.join(tmpdir(),'synthetic-owner-capsule-'));
Object.assign(process.env,{NODE_ENV:'production',BUBBLEWASH_DATABASE_PATH:path.join(dir,'fixture.sqlite'),BUBBLEWASH_ADMIN_EMAIL:'master@example.invalid',BUBBLEWASH_VENDOR_EMAIL:'vendor@example.invalid',BUBBLEWASH_DRIVER_EMAIL:'driver@example.invalid',BUBBLEWASH_SUPPORT_EMAIL:'support@example.invalid',BUBBLEWASH_DISABLE_DEMO_LOGIN:'true',BUBBLEWASH_STAFF_AUTH_DISABLED:'false',BUBBLEWASH_SESSION_SECRET:'synthetic-fixture-session-only',BUBBLEWASH_MFA_ENCRYPTION_KEY:Buffer.alloc(32,19).toString('base64')});
const deps=await c.runtime(release),staff=await import(pathToFileURL(path.join(release,'src/lib/staff-accounts.ts'))),data=await import(pathToFileURL(path.join(release,'src/lib/data-store.ts')));
// Initializers are allowed ONLY to create this isolated synthetic test fixture.
const db=data.getDatabase();deps.initializeStaffAccountsSchema(db);db.exec(c.CAPABILITY_DDL);db.exec(readFileSync(path.join(release,'db/proposed/research-v1.sql'),'utf8'));
const schema=()=>db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').raw().all();
const hash=x=>createHash('sha256').update(x).digest('hex');
const dump=()=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').raw().all()]));
const key=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const context={controlSha:'a'.repeat(40),runtimeSha:'b'.repeat(40),runId:'123456',runAttempt:'1'};
const request={email:'new-owner@example.invalid',name:'Test Owner',actor:'github-actions:fixture',release,dbPath:process.env.BUBBLEWASH_DATABASE_PATH,env:{...process.env},context,publicKey:key.publicKey,schemaSha256:hash(JSON.stringify(schema()))};
const expected={context,email:request.email,name:request.name,keySha256:hash((await import('node:crypto')).createPublicKey(key.publicKey).export({type:'spki',format:'der'}))};
let checks=[];const test=(name,fn)=>{fn();checks.push(name);};
try {
 db.prepare("INSERT INTO staff_accounts VALUES ('preserved@example.invalid','Existing Owner','admin','','preserved-password','preserved-version','active','','','2026-01-01')").run();
 db.prepare("INSERT INTO staff_owner_capabilities VALUES ('preserved@example.invalid',1)").run();
 db.prepare("INSERT INTO research_responses VALUES ('existing-response','existing-key','existing-hash','consumer','1','2026-01-01','{}')").run();
 db.prepare("INSERT INTO research_notification_outbox(response_id,state) VALUES ('existing-response','sent')").run();
 const before=dump(),beforeSchema=schema();
 test('single-line public SPKI round-trips through unchanged crypto',()=>{
   const input=key.publicKey.split('\n').filter(x=>x&&!x.startsWith('-----')).join('');
   const code="import importlib.util,sys;spec=importlib.util.spec_from_file_location('public_key_fixture',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);sys.stdout.write(m.public_key_from_input(sys.stdin.read()))";
   const normalized=spawnSync('python3',['-B','-c',code,path.join(path.dirname(capsulePath),'owner-document-transport.py')],{input,encoding:'utf8'});
   assert.equal(normalized.status,0,normalized.stderr);assert.equal(normalized.stdout,key.publicKey);
   const plain={email:request.email,name:request.name,role:'admin',allStaffAccess:true,ttlHours:24,context,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),activationUrl:'https://bubblewash.co/staff/activate#'+'A'.repeat(43)};
   plain.expiresAt=new Date(Date.parse(plain.createdAt)+86400000).toISOString();
   assert.deepEqual(c.unseal(c.seal(plain,normalized.stdout,context),key.privateKey,expected),plain);
 });
 test('Python schema digest matches actual pinned runtime schema',()=>{
   const code="import sqlite3,json,hashlib,sys;db=sqlite3.connect(sys.argv[1]);schema=db.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall();print(hashlib.sha256(json.dumps(schema,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest())";
   const result=spawnSync('python3',['-c',code,request.dbPath],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),request.schemaSha256);
 });
 test('actual READY protocol refusal rolls back without token output',()=>{
   const result=spawnSync(process.execPath,['--conditions=react-server','--experimental-strip-types',capsulePath],{input:JSON.stringify(request)+'\nABORT\n',encoding:'utf8',env:{...process.env}});
   assert.equal(result.status,1);assert.equal(result.stdout,'READY\n');assert(!result.stderr.includes(request.email));assert.deepEqual(dump(),before);
 });

 test('crypto failure rolls back all three inserts',()=>{assert.throws(()=>c.createInvitation(request,deps,()=>{},()=>{throw Error('synthetic confidential failure');}));assert.deepEqual(dump(),before);});
 test('precommit refusal rolls back all three inserts',()=>{assert.throws(()=>c.createInvitation(request,deps,()=>{throw Error('changed binding');}));assert.deepEqual(dump(),before);});
 test('missing file refuses without initializer',()=>{assert.throws(()=>c.createInvitation({...request,dbPath:path.join(dir,'missing.sqlite')},deps,()=>{}));});
 test('schema drift refuses before inserts',()=>{assert.throws(()=>c.createInvitation({...request,schemaSha256:'0'.repeat(64)},deps,()=>{}));assert.deepEqual(dump(),before);});
 test('bad public key refuses before inserts',()=>{assert.throws(()=>c.createInvitation({...request,publicKey:'bad-key'},deps,()=>{}));assert.deepEqual(dump(),before);});
 test('every configured role collision refuses',()=>{for(const email of ['master','vendor','driver','support'].map(x=>x+'@example.invalid'))assert.throws(()=>c.createInvitation({...request,email},deps,()=>{}));assert.deepEqual(dump(),before);});
 test('existing owner collision never resets',()=>{assert.throws(()=>c.createInvitation({...request,email:'preserved@example.invalid'},deps,()=>{}));assert.deepEqual(dump(),before);});
 db.prepare("INSERT INTO staff_credential_overrides VALUES ('admin','override@example.invalid','preserved','preserved','2026-01-01')").run();
 test('master override collision refuses',()=>assert.throws(()=>c.createInvitation({...request,email:'override@example.invalid'},deps,()=>{})));
 db.prepare("INSERT INTO submissions VALUES ('roster','2026-01-01','fixture',?)").run(JSON.stringify({submissionType:'staff-onboarding',staffEmail:' ROSTER@example.invalid '}));
 test('normalized roster collision refuses',()=>assert.throws(()=>c.createInvitation({...request,email:'roster@example.invalid'},deps,()=>{})));
 const preserved=dump();let commitChecks=0,encrypted;
 test('exact three inserts preserve existing data and schema',()=>{
   encrypted=c.createInvitation(request,deps,()=>{commitChecks++;assert.equal(db.prepare('SELECT 1 FROM staff_accounts WHERE email=?').get(request.email),undefined);});
   assert.equal(commitChecks,1);assert.deepEqual(schema(),beforeSchema);
   const after=dump();for(const name of Object.keys(preserved)) {
     if(!['staff_accounts','staff_owner_capabilities','submissions'].includes(name))assert.deepEqual(after[name],preserved[name]);
     else {assert.equal(after[name].length,preserved[name].length+1);for(const row of preserved[name])assert(after[name].some(x=>JSON.stringify(x)===JSON.stringify(row)));}
   }
 });
 const plain=c.unseal(encrypted,key.privateKey,expected),token=plain.activationUrl.split('#')[1];
 test('24h initial stored expiry and no plaintext persistence',()=>{
   const row=db.prepare('SELECT * FROM staff_accounts WHERE email=?').get(request.email);
   assert.equal(row.status,'invited');assert.equal(row.role,'admin');assert.equal(row.password_hash,'');assert.equal(row.token_hash,hash(token));
   assert.equal(Date.parse(row.token_expires_at)-Date.parse(row.updated_at),86400000);assert.equal(plain.expiresAt,row.token_expires_at);
   assert(!JSON.stringify(dump()).includes(token));assert(!encrypted.includes(Buffer.from(token)));assert(!encrypted.includes(Buffer.from(request.email)));
 });
 test('duplicate issue never retries or resets',()=>{const snapshot=dump();assert.throws(()=>c.createInvitation(request,deps,()=>{}));assert.deepEqual(dump(),snapshot);});
 test('ciphertext binds recipient and operation',()=>{
   assert.throws(()=>c.unseal(encrypted,key.privateKey,{...expected,email:'wrong@example.invalid'}));assert.throws(()=>c.unseal(encrypted,key.privateKey,{...expected,name:'Wrong Name'}));
   assert.throws(()=>c.unseal(encrypted,key.privateKey,{...expected,context:{...context,runId:'987654'}}));
   assert.throws(()=>c.unseal(encrypted,key.privateKey,{...expected,keySha256:'0'.repeat(64)}));
   const changed=JSON.parse(encrypted);changed.ciphertext=Buffer.alloc(Buffer.from(changed.ciphertext,'base64').length).toString('base64');assert.throws(()=>c.unseal(Buffer.from(JSON.stringify(changed)),key.privateKey,expected));
 });
 test('invalid expiry and purpose refuse',()=>{
   for(const changes of [{ttlHours:1},{expiresAt:new Date(Date.parse(plain.createdAt)+3600000).toISOString()},{createdAt:'2000-01-01T00:00:00.000Z',expiresAt:'2000-01-02T00:00:00.000Z'},{role:'support'},{allStaffAccess:false}])assert.throws(()=>c.unseal(c.seal({...plain,...changes},key.publicKey,context),key.privateKey,expected));
 });
 test('private finalizer outputs only 0600 link file and never overwrites',()=>{
   const privateFile=path.join(dir,'test-only-private.pem'),encFile=path.join(dir,'envelope.enc'),linkFile=path.join(dir,'setup-link.txt');
   writeFileSync(privateFile,key.privateKey,{mode:0o600});writeFileSync(encFile,encrypted,{mode:0o600});
   const args=[capsulePath,'decrypt',privateFile,encFile,'--setup-link-file',linkFile],stdin=JSON.stringify(expected)+'\n';
   const result=spawnSync(process.execPath,args,{input:stdin,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.equal(readFileSync(linkFile,'utf8'),plain.activationUrl+'\n');assert.equal(statSync(linkFile).mode&0o777,0o600);
   const again=spawnSync(process.execPath,args,{input:stdin,encoding:'utf8'});assert.equal(again.status,1);assert.equal(again.stdout,'');assert(!again.stderr.includes(token));
 });
 test('live activation accepts after2h and is single use',()=>{const NativeDate=Date;globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[NativeDate.now()+2*3600000]));}static now(){return NativeDate.now()+2*3600000;}};try{assert.equal(staff.activateStaffAccount(token,'test-user-chosen-password-very-long'),true);assert.equal(staff.activateStaffAccount(token,'test-user-chosen-password-very-long'),false);}finally{globalThis.Date=NativeDate;}});
 test('live activation rejects after24h without rewriting stored expiry',()=>{
   const expiredRequest={...request,email:'expired-fixture@example.invalid'};const encrypted=c.createInvitation(expiredRequest,deps,()=>{});const expired=c.unseal(encrypted,key.privateKey,{...expected,email:expiredRequest.email});const stored=db.prepare('SELECT * FROM staff_accounts WHERE email=?').get(expiredRequest.email);
   const NativeDate=Date;globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[NativeDate.now()+25*3600000]));}static now(){return NativeDate.now()+25*3600000;}};
   try{assert.equal(staff.activateStaffAccount(expired.activationUrl.split('#')[1],'test-user-chosen-password-very-long'),false);}finally{globalThis.Date=NativeDate;}
   assert.deepEqual(db.prepare('SELECT * FROM staff_accounts WHERE email=?').get(expiredRequest.email),stored);
 });
 const concurrentRequest={...request,email:'concurrent@example.invalid'};
 const concurrent=await Promise.all([1,2].map(()=>new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,['--conditions=react-server','--experimental-strip-types',capsulePath],{env:{...process.env},stdio:['pipe','pipe','pipe']});let out='',err='';
   child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('close',status=>resolve({status,out,err}));child.stdin.end(JSON.stringify(concurrentRequest)+'\nCOMMIT\n');
 })));
 test('concurrent same-recipient issuance creates exactly one invitation',()=>{assert.deepEqual(concurrent.map(x=>x.status).sort(),[0,1]);assert.equal(db.prepare('SELECT count(*) AS n FROM staff_accounts WHERE email=?').get(concurrentRequest.email).n,1);assert(concurrent.every(x=>!x.out.includes(concurrentRequest.email)&&!x.err.includes(concurrentRequest.email)));});
 test('unknown trigger refuses with matching digest',()=>{db.exec("CREATE TRIGGER unexpected AFTER INSERT ON staff_accounts BEGIN SELECT 1; END");assert.throws(()=>c.createInvitation({...request,email:'trigger@example.invalid',schemaSha256:hash(JSON.stringify(schema()))},deps,()=>{}));db.exec('DROP TRIGGER unexpected');});
 test('missing capability refuses without creating it',()=>{db.exec('DROP TABLE staff_owner_capabilities');assert.throws(()=>c.createInvitation({...request,email:'missing-cap@example.invalid',schemaSha256:hash(JSON.stringify(schema()))},deps,()=>{}));assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='staff_owner_capabilities'").get(),undefined);});
 process.stdout.write(JSON.stringify({ok:true,checks}));
} finally {db.close();rmSync(dir,{recursive:true,force:true});}
'''

class CapsuleTests(unittest.TestCase):
    def test_synthetic_capsule_transaction_crypto_and_live_activation(self):
        self.assertTrue((RUNTIME/'node_modules/better-sqlite3').exists(),'Exact reviewed runtime dependency installation required')
        reference=ROOT.parent/'bubblewash-results-pwa-preview-v3-clean-source'
        if reference.exists():
            for path in ('src/lib/staff-accounts.ts','src/lib/data-store.ts','src/lib/passwords.ts','db/proposed/research-v1.sql'):
                self.assertEqual((RUNTIME/path).read_bytes(),(reference/path).read_bytes())
        result=subprocess.run(['node','--conditions=react-server','--experimental-strip-types','--input-type=module','-e',NODE_TESTS,'synthetic-fixture',str(ROOT/'ops/owner-document-capsule.mjs'),str(RUNTIME)],capture_output=True,text=True,timeout=90)
        self.assertEqual(result.returncode,0,result.stderr)
        result=json.loads(result.stdout);self.assertTrue(result['ok']);self.assertEqual(len(result['checks']),23)

class RequestTests(unittest.TestCase):
    def test_key_free_check_accepts_no_storage_or_public_key(self):
        self.assertEqual(host.validate(copy.deepcopy(REQUEST))['mode'],'check')
    def test_private_request_is_bounded_and_exact(self):
        for mutation in (lambda x:x.update(extra='x'),lambda x:x['recipient'].update(email='Upper@example.invalid'),lambda x:x['recipient'].update(name='x\nsecret'),lambda x:x['context'].update(runtimeSha='c'*40),lambda x:x['context'].update(runAttempt='2'),lambda x:x.update(publicKey='not-allowed')):
            request=copy.deepcopy(REQUEST);mutation(request)
            with self.assertRaises(Exception):host.validate(request)
    def environment(self):
        return {'GITHUB_REPOSITORY':'bechirobob/bubble-wash','GITHUB_REF':'refs/heads/main','GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'123456','GITHUB_ACTOR':'fixture','RUNTIME_SHA':pins['runtimeSha'],'BUBBLEWASH_ADDITIONAL_OWNER_INPUT':json.dumps(REQUEST['recipient'])}
    def test_transport_consumes_separate_input_without_primary_owner(self):
        env=self.environment();env['BUBBLEWASH_OWNER_EMAIL']='existing-owner@example.invalid'
        request,_=transport.input_request(env,pins);self.assertEqual(request['recipient'],REQUEST['recipient']);self.assertNotIn('BUBBLEWASH_ADDITIONAL_OWNER_INPUT',env);self.assertEqual(env['BUBBLEWASH_OWNER_EMAIL'],'existing-owner@example.invalid')
    def test_transport_rejects_nonmain_debug_repeat_and_missing_approval(self):
        for key,value in [('GITHUB_REF','refs/heads/other'),('GITHUB_RUN_ATTEMPT','2'),('ACTIONS_STEP_DEBUG','true'),('RUNNER_DEBUG','1'),('GITHUB_REPOSITORY','other/repo'),('OWNER_MODE','issue-document')]:
            env=self.environment();env[key]=value
            with self.assertRaises(Exception):transport.input_request(env,pins)
    def test_single_line_spki_roundtrip_and_identical_der_hash(self):
        # Public encoding fixture only; the unchanged capsule tests enforce RSA.
        raw=b'public-encoding-fixture-only' * 16
        value=base64.b64encode(raw).decode('ascii');pem=transport.public_key_from_input(value)
        self.assertEqual(host.public_der(pem),raw)
        self.assertEqual(hashlib.sha256(host.public_der(pem)).digest(),hashlib.sha256(raw).digest())
        self.assertTrue(all(len(line)<=64 for line in pem.splitlines()[1:-1]))
    def test_public_key_input_rejects_noncanonical_or_multiline_values(self):
        valid=base64.b64encode(b'public-fixture' * 31).decode('ascii')
        invalid=[None,1,'',valid+'\n',' '+valid,valid[:64]+'\n'+valid[64:],valid.replace('A','-',1) if 'A' in valid else valid+'-',valid.rstrip('='),valid+'=',base64.b64encode(b'x'*300).decode(),base64.b64encode(b'x'*1024).decode(),'-----BEGIN PUBLIC KEY-----\n'+valid+'\n-----END PUBLIC KEY-----','-----BEGIN PRIVATE KEY-----']
        for value in invalid:
            with self.subTest(value_type=type(value).__name__):
                with self.assertRaises(Exception):transport.public_key_from_input(value)
    def test_issue_request_normalizes_public_input_before_existing_validation(self):
        env=self.environment();raw=b'public-fixture' * 31
        env.update(OWNER_MODE='issue-document',ISSUANCE_APPROVED='true',HANDOVER_READY='true',HANDOFF_PUBLIC_KEY=base64.b64encode(raw).decode(),BACKUP_SHA='b'*64,RECEIPT_RUN='123',BACKUP_STORE_SHA='d'*40,BACKUP_STORE_ID='123')
        request,validator=transport.input_request(env,pins)
        self.assertEqual(validator.public_der(request['publicKey']),raw);self.assertEqual(request['recipient'],REQUEST['recipient'])
        self.assertNotIn('BUBBLEWASH_ADDITIONAL_OWNER_INPUT',env)
    def issue_environment(self):
        env=self.environment();env.update(OWNER_MODE='issue-document',ISSUANCE_APPROVED='true',HANDOVER_READY='true',HANDOFF_PUBLIC_KEY=base64.b64encode(b'public-fixture' * 31).decode(),BACKUP_SHA='b'*64,RECEIPT_RUN='123',BACKUP_STORE_SHA='d'*40,BACKUP_STORE_ID='123');return env
    def test_all_seven_dispatch_fields_are_wired_without_shell_interpolation(self):
        # Existing authenticated GitHub form observed read-only: string fields
        # are INPUT type=text, mode is SELECT, boolean is checkbox value=true.
        # Workflow expressions convert typed booleans to literal true/false env.
        # Exact new owner form is still inspected after merge, before dispatch.
        import re
        workflow=(ROOT/'.github/workflows/owner-document-enrollment.yml').read_text()
        fields=re.findall(r'^      ([a-z0-9_]+):$',workflow.split('permissions:')[0],re.MULTILINE)
        self.assertEqual(fields,['expected_live_sha','mode','issuance_approved','handover_ready','handoff_public_key','backup_sha256','receipt_run'])
        bindings={'RUNTIME_SHA':'expected_live_sha','OWNER_MODE':'mode','ISSUANCE_APPROVED':'issuance_approved','HANDOVER_READY':'handover_ready','HANDOFF_PUBLIC_KEY':'handoff_public_key','BACKUP_SHA':'backup_sha256','RECEIPT_RUN':'receipt_run'}
        for env,field in bindings.items():self.assertIn(env+': ${{ inputs.'+field+' }}',workflow)
        self.assertIn('options: [check, issue-document]',workflow);self.assertEqual(workflow.count('type: boolean'),2)
        self.assertNotIn('run: ${{',workflow)
    def test_check_mode_never_issues_under_either_boolean_encoding(self):
        for approved in ('true','false'):
            for ready in ('true','false'):
                env=self.environment();env.update(OWNER_MODE='check',ISSUANCE_APPROVED=approved,HANDOVER_READY=ready,HANDOFF_PUBLIC_KEY='ignored in check',BACKUP_SHA='ignored in check',RECEIPT_RUN='ignored in check')
                request,_=transport.input_request(env,pins)
                self.assertEqual(request['mode'],'check');self.assertEqual(request['approved'],approved=='true');self.assertEqual(request['publicKey'],'');self.assertIsNone(request['backup'])
    def test_issue_mode_requires_both_literal_true_boolean_encodings(self):
        for field in ('ISSUANCE_APPROVED','HANDOVER_READY'):
            for value in ('false','TRUE','False','1','',None,True,False):
                env=self.issue_environment();env[field]=value
                with self.subTest(field=field,value=value):
                    with self.assertRaises(Exception):transport.input_request(env,pins)
        request,_=transport.input_request(self.issue_environment(),pins);self.assertEqual(request['mode'],'issue-document');self.assertTrue(request['approved'])
    def test_runtime_and_mode_dispatch_inputs_are_exact_in_both_modes(self):
        for mode in ('check','issue-document'):
            for field,values in [('RUNTIME_SHA',('',pins['runtimeSha'].upper(),'0'*40,pins['runtimeSha']+'\n')),('OWNER_MODE',('issue','send','issue-document ','CHECK',''))]:
                for value in values:
                    env=self.issue_environment() if mode=='issue-document' else self.environment();env[field]=value
                    with self.subTest(mode=mode,field=field):
                        with self.assertRaises(Exception):transport.input_request(env,pins)
    def test_issue_backup_and_receipt_dispatch_inputs_are_strict(self):
        for field,values in [('BACKUP_SHA',('','a'*63,'A'*64,'a'*65,'b'*64+'\n')),('RECEIPT_RUN',('','0','0123','-1','1.0','123\n','run123'))]:
            for value in values:
                env=self.issue_environment();env[field]=value
                with self.subTest(field=field):
                    with self.assertRaises(Exception):transport.input_request(env,pins)
        request,_=transport.input_request(self.issue_environment(),pins);self.assertEqual(request['backup']['sha256'],'b'*64);self.assertEqual(request['backup']['runId'],'123')
    def test_ssh_environment_cannot_inherit_credentials(self):
        with mock.patch.dict(os.environ,{'HOME':'/home/runner','SECRET':'not inherited','GH_TOKEN':'synthetic'}):
            self.assertEqual(transport.runner_environment(),{'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/home/runner','LC_ALL':'C'})
    def test_all_historical_dependencies_match_pins(self):
        for name,digest in transport.SOURCE_PINS.items():self.assertEqual(hashlib.sha256(transport.source(name)).hexdigest(),digest)
    def test_streamed_payload_compiles_without_execution(self):
        payload=transport.payload(REQUEST,pins);compile(payload,'streamed-protocol','exec');self.assertNotIn(b'BUBBLEWASH_OWNER_RESEND_KEY',payload.split(b'host.main(')[-1])
    def test_no_provider_or_runtime_mutation_in_new_capsule(self):
        raw=(ROOT/'ops/owner-document-capsule.mjs').read_text()
        for forbidden in ('fetch(', 'resend.com', 'getDatabase(', 'UPDATE staff_accounts', 'CREATE TABLE staff_accounts', 'DELETE FROM'):
            self.assertNotIn(forbidden,raw)
        self.assertEqual(raw.count('INSERT INTO '),3)

class ProtocolTests(unittest.TestCase):
    def setUp(self):self.saved=host.CAPSULE
    def tearDown(self):host.CAPSULE=self.saved
    def call(self,code,callback=lambda:None,timeout=3):
        host.CAPSULE=code
        return host.invoke_capsule(shutil.which('node'),ROOT,{'synthetic':True},callback,{'PATH':'/usr/bin:/bin'},timeout)
    def test_ready_commit_protocol_once(self):
        seen=[]
        code="import {readSync,writeSync} from 'node:fs';function line(){let s='',b=Buffer.alloc(1);while(readSync(0,b,0,1,null)&&b[0]!==10)s+=b;return s;}export async function main(){line();writeSync(1,'READY\\n');if(line()!=='COMMIT')throw Error();writeSync(1,'sealed-only');}"
        self.assertEqual(self.call(code,lambda:seen.append('bound')),b'sealed-only');self.assertEqual(seen,['bound'])
    def test_child_eof_never_commits(self):
        callback=mock.Mock()
        with self.assertRaises(Exception):self.call('export async function main(){}',callback)
        callback.assert_not_called()
    def test_child_timeout_kills_and_reaps(self):
        original=host.subprocess.Popen;created=[]
        def spawn(*a,**k):p=original(*a,**k);created.append(p);return p
        with mock.patch.object(host.subprocess,'Popen',side_effect=spawn):
            with self.assertRaises(Exception):self.call('export async function main(){await new Promise(()=>{});}',timeout=.15)
        self.assertEqual(len(created),1);self.assertIsNotNone(created[0].poll())
    def test_precommit_refusal_kills_without_second_attempt(self):
        original=host.subprocess.Popen;created=[]
        def spawn(*a,**k):p=original(*a,**k);created.append(p);return p
        code="import {writeSync,readSync} from 'node:fs';export async function main(){writeSync(1,'READY\\n');readSync(0,Buffer.alloc(1),0,1,null);await new Promise(()=>{});}"
        with mock.patch.object(host.subprocess,'Popen',side_effect=spawn):
            with self.assertRaises(Exception):self.call(code,lambda:(_ for _ in ()).throw(ValueError('binding drift')))
        self.assertEqual(len(created),1);self.assertIsNotNone(created[0].poll())
    def test_extra_stdout_before_ready_refuses(self):
        with self.assertRaises(Exception):self.call("export async function main(){console.log('private diagnostic');}")
    def test_private_request_size_is_bounded_before_spawn(self):
        with mock.patch.object(host.subprocess,'Popen') as spawn:
            with self.assertRaises(Exception):host.invoke_capsule('/usr/bin/node',ROOT,{'data':'x'*17000},lambda:None,{},.1)
            spawn.assert_not_called()

class SchemaTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=ROOT);self.database=Path(self.temp.name)/'db.sqlite';self.owner=pwd.getpwuid(os.getuid());self.sql=(RUNTIME/'db/proposed/research-v1.sql').read_bytes()
        with sqlite3.connect(self.database) as db:
            db.executescript("CREATE TABLE staff_accounts(email TEXT PRIMARY KEY,role TEXT,status TEXT);CREATE TABLE staff_owner_capabilities(email TEXT PRIMARY KEY,all_staff_access INTEGER);CREATE TABLE staff_credential_overrides(login TEXT);CREATE TABLE submissions(id TEXT,data TEXT);"+self.sql.decode())
        self.database.chmod(0o600)
        self.identity=mock.patch.object(guards,'database_identity',return_value=('safe-fixture',));self.identity.start()
    def tearDown(self):self.identity.stop();self.temp.cleanup()
    def inspect(self):return host.inspect_database(self.database,REQUEST['recipient']['email'],{},self.sql,self.owner)
    def test_read_only_schema_and_collision_clear_do_not_change_bytes(self):
        before=self.database.read_bytes();collision,digest=self.inspect();self.assertFalse(collision['duplicatePresent']);self.assertEqual(self.database.read_bytes(),before)
        with sqlite3.connect(self.database) as db:expected=hashlib.sha256(host.canonical(guards.schema(db))).hexdigest()
        self.assertEqual(digest,expected)
    def test_every_collision_category_is_coarse(self):
        email=REQUEST['recipient']['email']
        with sqlite3.connect(self.database) as db:
            db.execute('INSERT INTO staff_accounts VALUES (?,?,?)',(email,'admin','suspended'));db.execute('INSERT INTO staff_credential_overrides VALUES (?)',(email,));db.execute('INSERT INTO submissions VALUES (?,?)',('fixture',json.dumps({'submissionType':'staff-onboarding','staffEmail':email})))
        collision,_=host.inspect_database(self.database,email,{'BUBBLEWASH_ADMIN_EMAIL':email},self.sql,self.owner)
        self.assertEqual(collision['duplicateTypes'],['configured','master','managed','roster']);self.assertEqual(collision['managedStatus'],'suspended');self.assertNotIn(email,host.canonical(collision).decode())
    def test_unknown_table_trigger_and_extra_research_index_refuse(self):
        for statement,undo in [('CREATE TABLE unknown(x)','DROP TABLE unknown'),('CREATE TRIGGER unexpected AFTER INSERT ON submissions BEGIN SELECT 1; END','DROP TRIGGER unexpected'),('CREATE INDEX research_extra ON research_responses(payload_hash)','DROP INDEX research_extra')]:
            with sqlite3.connect(self.database) as db:db.execute(statement)
            with self.assertRaises(Exception):self.inspect()
            with sqlite3.connect(self.database) as db:db.execute(undo)
    def test_missing_partial_schema_never_initializes(self):
        with sqlite3.connect(self.database) as db:db.execute('DROP TABLE research_notification_outbox')
        before=self.database.read_bytes()
        with self.assertRaises(Exception):self.inspect()
        self.assertEqual(self.database.read_bytes(),before)
    def test_missing_database_is_not_created(self):
        self.database.unlink()
        with self.assertRaises(Exception):self.inspect()
        self.assertFalse(self.database.exists())
    def test_unknown_wal_consistency_refuses_without_sidecar_creation(self):
        with sqlite3.connect(self.database) as db:db.execute('PRAGMA journal_mode=WAL')
        self.assertFalse(Path(str(self.database)+'-wal').exists())
        with self.assertRaises(Exception):self.inspect()
        self.assertFalse(Path(str(self.database)+'-wal').exists());self.assertFalse(Path(str(self.database)+'-shm').exists())

class BoundaryTests(unittest.TestCase):
    def test_existing_privilege_drop_order_is_irreversible_before_callback(self):
        order=[];owner=types.SimpleNamespace(pw_uid=1234,pw_gid=2345)
        patches=[mock.patch.object(guards.os,'setgroups',side_effect=lambda x:order.append(('groups',x))),mock.patch.object(guards.os,'setgid',side_effect=lambda x:order.append(('gid',x))),mock.patch.object(guards.os,'setuid',side_effect=lambda x:order.append(('uid',x))),mock.patch.object(guards.os,'getuid',return_value=1234),mock.patch.object(guards.os,'geteuid',return_value=1234),mock.patch.object(guards.os,'getgid',return_value=2345),mock.patch.object(guards.os,'getegid',return_value=2345),mock.patch.object(guards.os,'getgroups',return_value=[]),mock.patch.object(guards.resource,'setrlimit')]
        for p in patches:p.start()
        try:guards.app_operation(owner,lambda:order.append(('database','after drop')))
        finally:
            for p in reversed(patches):p.stop()
        self.assertEqual(order,[('groups',[]),('gid',2345),('uid',1234),('database','after drop')])
    def test_main_locks_then_drops_before_any_operation(self):
        order=[];owner=types.SimpleNamespace(pw_uid=1234,pw_gid=2345)
        from contextlib import contextmanager
        @contextmanager
        def lock(*args):order.append('lock');yield lambda:order.append('binding');order.append('unlock')
        fake_core=types.SimpleNamespace(RUNTIME=Path('/fixed'),deployment_lock=lock)
        fake_guards=types.SimpleNamespace(app_operation=lambda owner,run:(order.append('drop'),run()))
        output=types.SimpleNamespace(buffer=types.SimpleNamespace(write=lambda raw:order.append('captured-result'),flush=lambda:None))
        with mock.patch.multiple(host,core=fake_core,guards=fake_guards),mock.patch.object(host.os,'geteuid',return_value=0),mock.patch.object(host.pwd,'getpwnam',return_value=owner),mock.patch.object(host.resource,'setrlimit'),mock.patch.object(host.signal,'signal'),mock.patch.object(host.signal,'alarm'),mock.patch.object(host.sys,'stdout',output),mock.patch.object(host,'operation',side_effect=lambda *args:(order.append('operation'),b'{}')[1]):host.main(copy.deepcopy(REQUEST))
        self.assertEqual(order,['lock','drop','operation','binding','captured-result','unlock'])
    def test_check_never_invokes_writer_and_source_config_drift_refuse(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as temporary:
            home=Path(temporary);release=home/'bubblewash-releases'/'fixed';(release/'db/proposed').mkdir(parents=True);(release/'db/proposed/research-v1.sql').write_bytes(b'fixture')
            database=home/'existing.sqlite';database.touch();current=home/'current';current.symlink_to(release,target_is_directory=True)
            raw=b'protected unchanged config';marker=b'fixed current marker'
            values={'BUBBLEWASH_DATABASE_PATH':str(database)};owner=types.SimpleNamespace(pw_uid=os.getuid())
            def parse(data):return {'sha':pins['runtimeSha'],'path':str(release)} if data==marker else values
            fakecore=types.SimpleNamespace(CURRENT=current,HOME=home,RUNTIME=home,ENV=home/'protected.env',parse=parse)
            fakeguards=types.SimpleNamespace(inspect_read=lambda path,*args: pins['runtimeSha'].encode() if path.name=='.release-sha' else marker,environment_snapshot=mock.Mock(return_value=(raw,('env',))),database_identity=lambda *args:('db',),runtime_flags=mock.Mock())
            fakescanner=types.SimpleNamespace(source_snapshot=mock.Mock(return_value=({},('source',))),content_commitment=lambda _:pins['runtimeContent'],open_configuration=mock.Mock())
            fakefacts=types.SimpleNamespace(trusted_executable=lambda p:p,source=lambda *args:{'sha256':host.NODE_SHA256},bounded=lambda *args,**kwargs:b'v22.0.0\n')
            fakeoperator=types.SimpleNamespace(verify_source=mock.Mock(),verify_runtime=mock.Mock())
            collision={'duplicatePresent':False}
            with mock.patch.multiple(host,core=fakecore,guards=fakeguards,scanner=fakescanner,facts=fakefacts,operator=fakeoperator),mock.patch.object(host.preflight,'owner_delivery_configuration',return_value={'personalMfaKeyReady':True}),mock.patch.object(host,'inspect_database',return_value=(collision,'e'*64)),mock.patch.object(host,'runtime_configuration'),mock.patch.object(host,'invoke_capsule') as writer:
                result=json.loads(host.operation(copy.deepcopy(REQUEST),owner,lambda:None));self.assertEqual(result['state'],'clear');writer.assert_not_called()
                fakescanner.source_snapshot.side_effect=[({},('source',)),({},('changed',))]
                with self.assertRaises(Exception):host.operation(copy.deepcopy(REQUEST),owner,lambda:None)
                writer.assert_not_called();fakescanner.source_snapshot.side_effect=None
                fakeguards.environment_snapshot.side_effect=[(raw,('env',)),(raw+b'drift',('env',))]
                with self.assertRaises(Exception):host.operation(copy.deepcopy(REQUEST),owner,lambda:None)
                writer.assert_not_called()
    def test_public_error_output_is_fixed_and_uncertain_never_retried(self):
        from io import StringIO
        output=StringIO()
        with mock.patch.object(host,'validate',side_effect=ValueError('secret@example.invalid TOKEN SECRET')),mock.patch.object(host.signal,'signal'),mock.patch.object(host.signal,'alarm'),mock.patch.object(host.resource,'setrlimit'),mock.patch.object(host.sys,'stdout',output),mock.patch.multiple(host,ATTEMPTED=True,STAGE='issuance'):
            with self.assertRaises(SystemExit):host.main(REQUEST)
        result=json.loads(output.getvalue());self.assertEqual(result,{'ok':False,'state':'outcome-uncertain-stop','stage':'issuance','retryPermitted':False})

class StorageTests(unittest.TestCase):
    def test_ciphertext_storage_is_private_verified_and_never_recipient_metadata(self):
        backup=load('backup_fixture','.github/backup/backup_release.py')
        request=copy.deepcopy(REQUEST);request['mode']='issue-document';raw=b'synthetic-encrypted-fixture-not-a-token';calls=[];uploaded={};assets=[]
        env={'BACKUP_STORE_SHA':'d'*40,'BACKUP_STORE_ID':'123'}
        class Api:
            def api(self,suffix='',method='GET',payload=None):
                calls.append((suffix,method,payload))
                if suffix=='':return {'private':True,'visibility':'private','full_name':transport.STORE,'id':123}
                if suffix.startswith('git/commits/'):return {'sha':env['BACKUP_STORE_SHA']}
                if suffix=='releases':
                    self.release={**payload,'id':12,'assets':assets};return self.release
                if method=='PATCH':self.release={**self.release,**payload,'published_at':'2026-01-01'}
                return self.release
            def upload(self,identity,path):
                self.assertion=identity==12;uploaded[path.name]=path.read_bytes();assets.append({'id':100+len(assets),'name':path.name,'size':path.stat().st_size,'state':'uploaded','content_type':'application/octet-stream','digest':'sha256:'+backup.digest(path)})
            def download(self,identity,target,size):target.write_bytes(uploaded[next(a['name'] for a in assets if a['id']==identity)])
        fakehost=types.SimpleNamespace(envelope=mock.Mock(),context=host.context);api=Api()
        result=transport.publish(backup,api,env,request,raw,fakehost)
        self.assertEqual(result['state'],'sealed-handover-stored');self.assertFalse(result['retryPermitted']);self.assertEqual(sum(method=='POST' for _,method,_ in calls),1)
        self.assertNotIn(request['recipient']['email'],json.dumps(calls));self.assertNotIn(request['recipient']['email'],json.dumps(result));self.assertIn(raw,uploaded.values())
    def test_upload_failure_after_commit_is_uncertain_and_never_reissues(self):
        from io import StringIO
        request=copy.deepcopy(REQUEST);request['mode']='issue-document'
        fakehost=types.SimpleNamespace();facts=types.SimpleNamespace(bounded=mock.Mock(return_value=b'{"schema":"synthetic encrypted"}'))
        backup=types.SimpleNamespace(GitHub=mock.Mock(return_value=object()))
        def modules(name,path):return facts if path.endswith('facts.py') else backup
        output=StringIO()
        with mock.patch.object(transport,'input_request',return_value=(request,fakehost)),mock.patch.object(transport,'module',side_effect=modules),mock.patch.object(transport,'store_preflight'),mock.patch.object(transport,'payload',return_value=b'private stdin only'),mock.patch.object(transport,'runner_environment',return_value={}),mock.patch.object(transport,'publish',side_effect=ValueError('private-token-not-logged')) as publish,mock.patch.object(transport.sys,'stdout',output),mock.patch.object(transport.resource,'setrlimit'):
            with self.assertRaises(SystemExit) as stopped:transport.main()
        self.assertEqual(stopped.exception.code,1);facts.bounded.assert_called_once();publish.assert_called_once()
        self.assertEqual(json.loads(output.getvalue()),{'ok':False,'state':'outcome-uncertain-stop','stage':'storage','retryPermitted':False})
    def test_private_storage_identity_failure_precedes_upload(self):
        backup=load('backup_fixture_refusal','.github/backup/backup_release.py');api=types.SimpleNamespace(api=mock.Mock(return_value={'private':False}),upload=mock.Mock());env={'BACKUP_STORE_SHA':'d'*40,'BACKUP_STORE_ID':'123'}
        with self.assertRaises(Exception):transport.store_preflight(backup,api,env)
        api.upload.assert_not_called()
    def test_ciphertext_local_files_are_exclusive_0600(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'cipher.enc';transport.write_private(path,b'ciphertext');self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o600)
            with self.assertRaises(Exception):transport.write_private(path,b'replacement')
            self.assertEqual(path.read_bytes(),b'ciphertext')

class WorkflowOrderingTests(unittest.TestCase):
    def test_strict_control_selector_precedes_nested_checkout(self):
        workflow=(ROOT/'.github/workflows/owner-document-enrollment.yml').read_text()
        checkout='uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262'
        control='python3 -B ops/integration-release/select_source.py --release . --profile integration-candidate-v1'
        runtime='python3 -B ops/deploy-survey-update.py --check-runtime'
        first=workflow.index(checkout);second=workflow.index(checkout,first+len(checkout))
        self.assertEqual(workflow.count(control),1)
        self.assertLess(first,workflow.index(control));self.assertLess(workflow.index(control),second)
        self.assertLess(second,workflow.index(runtime));self.assertLess(workflow.index(runtime),workflow.index('uses: tailscale/'))
        self.assertLess(workflow.index('"$GITHUB_RUN_ATTEMPT" == 1'),workflow.index(control))
        self.assertLess(workflow.index('"$(git rev-parse HEAD)" == "$GITHUB_SHA"'),workflow.index(control))
        self.assertLess(workflow.index(runtime),workflow.index('BUBBLEWASH_ADDITIONAL_OWNER_INPUT:'))
    def test_actual_strict_selector_accepts_clean_control_and_rejects_nested_runtime(self):
        contracts=load('workflow_order_contracts','ops/integration-release/contracts.py')
        contract=json.loads((ROOT/'ops/integration-release/source-contracts.json').read_bytes())
        profile=contract['profiles']['integration-candidate-v1']
        # Reproduce a pristine control checkout, excluding the intentional later
        # runtime checkout and installed/generated root dependencies. Never relax
        # the real selector or its approved root-directory policy.
        with tempfile.TemporaryDirectory(prefix='owner-control-order-') as temporary:
            clean=Path(temporary)/'control';clean.mkdir()
            for name in contracts.SOURCE_DIRS:
                if (ROOT/name).exists():shutil.copytree(ROOT/name,clean/name)
            for name in profile['rootFiles']:shutil.copyfile(ROOT/name,clean/name)
            command=['python3','-B',str(clean/'ops/integration-release/select_source.py'),'--release',str(clean),'--profile','integration-candidate-v1']
            accepted=subprocess.run(command,capture_output=True,text=True,timeout=30)
            self.assertEqual(accepted.returncode,0,accepted.stderr);self.assertEqual(accepted.stdout.strip(),'integration-candidate-v1')
            (clean/'runtime-artifact').mkdir()
            rejected=subprocess.run(command,capture_output=True,text=True,timeout=30)
            self.assertNotEqual(rejected.returncode,0);self.assertIn('source matches no unique reviewed integration contract',rejected.stderr)
            (clean/'runtime-artifact').rmdir()
            restored=subprocess.run(command,capture_output=True,text=True,timeout=30)
            self.assertEqual(restored.returncode,0,restored.stderr)

class AppUidRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='owner-appuid-');self.root=Path(self.temp.name);self.release=self.root/'release';self.release.mkdir();self.proc=self.root/'proc';self.proc.mkdir();self.database=self.root/'existing.sqlite';self.database.touch();self.node=self.root/'node';self.node.touch();self.uid=os.getuid();self.main=222;self.listener=333;self.calls=[]
        self.values={'NODE_ENV':'production','BUBBLEWASH_DISABLE_DEMO_LOGIN':'true','BUBBLEWASH_RESEARCH_OPEN':'true','BUBBLEWASH_RESEARCH_EMAIL_ENABLED':'true','BUBBLEWASH_STAFF_AUTH_DISABLED':'false','BUBBLEWASH_BOOKINGS_DISABLED':'true','BUBBLEWASH_DATABASE_PATH':str(self.database),'PRESERVED_SETTING':'synthetic-private-value'}
        for pid in (self.main,self.listener):
            directory=self.proc/str(pid);directory.mkdir();(directory/'cwd').symlink_to(self.release,target_is_directory=True);(directory/'exe').symlink_to(self.node);(directory/'cgroup').write_bytes(b'0::/same-service\n');self.write_stat(pid,'12345');self.write_env(pid,self.values)
        self.operator=load('appuid_original_operator','ops/run-research-test.py')
        self.facts=types.SimpleNamespace(require=host.require,trusted_executable=lambda path:path,bounded=self.bounded)
        def path(value):return self.proc if str(value)=='/proc' else Path(value)
        self.patches=[mock.patch.multiple(host,core=core,guards=guards,preflight=preflight,operator=self.operator,facts=self.facts),mock.patch.object(preflight,'PROC',self.proc),mock.patch.object(self.operator,'Path',side_effect=path)]
        for patch in self.patches:patch.start()
    def tearDown(self):
        for patch in reversed(self.patches):patch.stop()
        self.temp.cleanup()
    def write_stat(self,pid,start):
        (self.proc/str(pid)/'stat').write_text(str(pid)+' (fixture) S '+'0 '*18+start+'\n')
    def write_env(self,pid,values):
        (self.proc/str(pid)/'environ').write_bytes(b'\0'.join((key+'='+value).encode() for key,value in values.items())+b'\0')
    def bounded(self,args,**kwargs):
        self.calls.append((args,kwargs));self.assertNotIn('runuser',args);self.assertNotIn('sudo',args)
        self.assertEqual(kwargs['env']['XDG_RUNTIME_DIR'],f'/run/user/{self.uid}');self.assertEqual(kwargs['env']['DBUS_SESSION_BUS_ADDRESS'],f'unix:path=/run/user/{self.uid}/bus')
        if args[0]=='/usr/bin/ss':return ('LISTEN 0 511 *:3000 *:* users:(("node",pid='+str(self.listener)+',fd=18))\n').encode()
        self.assertEqual(args[:4],['/usr/bin/systemctl','--user','show','bubblewash-local.service'])
        if args[-1]=='--property=MainPID':return ('MainPID='+str(self.main)+'\n').encode()
        return ('LoadState=loaded\nActiveState=active\nNeedDaemonReload=no\nMainPID='+str(self.main)+'\nWorkingDirectory='+str(self.release)+'\nEnvironmentFiles='+str(self.operator.ENV)+' (ignore_errors=no)\n').encode()
    def verify(self):return host.runtime_configuration(self.release,self.values,str(self.node),self.uid,self.database)
    def test_actual_nonroot_runuser_reproduction(self):
        executable=shutil.which('runuser');self.assertIsNotNone(executable);self.assertGreater(os.getuid(),0)
        result=subprocess.run([executable,'-u',pwd.getpwuid(os.getuid()).pw_name,'--','/usr/bin/true'],capture_output=True,text=True,timeout=5)
        self.assertNotEqual(result.returncode,0);self.assertIn('non-root',result.stderr)
    def test_same_uid_direct_runtime_checks_pass_with_all_original_guards(self):
        self.assertGreater(self.uid,0);self.verify();self.assertTrue(self.calls)
        self.assertTrue(all(args[0] in ('/usr/bin/systemctl','/usr/bin/ss') for args,_ in self.calls))
    def test_each_process_rejects_any_protected_env_drift(self):
        for pid in (self.main,self.listener):
            changed=dict(self.values,PRESERVED_SETTING='changed')
            self.write_env(pid,changed)
            with self.subTest(pid=pid):
                with self.assertRaises(Exception):self.verify()
            self.write_env(pid,self.values)
    def test_each_process_rejects_closed_flags_or_unsafe_production_mode(self):
        for pid in (self.main,self.listener):
            for key in ('BUBBLEWASH_RESEARCH_OPEN','BUBBLEWASH_RESEARCH_EMAIL_ENABLED','BUBBLEWASH_DISABLE_DEMO_LOGIN','NODE_ENV'):
                changed=dict(self.values);changed[key]='false';self.write_env(pid,changed)
                with self.subTest(pid=pid,key=key):
                    with self.assertRaises(Exception):self.verify()
                self.write_env(pid,self.values)
    def test_cwd_and_cgroup_binding_remain_enforced(self):
        (self.proc/str(self.listener)/'cgroup').write_bytes(b'0::/different-service\n')
        with self.assertRaises(Exception):self.verify()
        (self.proc/str(self.listener)/'cgroup').write_bytes(b'0::/same-service\n');cwd=self.proc/str(self.main)/'cwd';cwd.unlink();cwd.symlink_to(self.root,target_is_directory=True)
        with self.assertRaises(Exception):self.verify()
    def test_process_start_time_drift_refuses(self):
        original=preflight.process_identity;counts={}
        def changed(pid):
            counts[pid]=counts.get(pid,0)+1
            value=original(pid)
            return (value[0],b'changed') if counts[pid]>=4 else value
        with mock.patch.object(preflight,'process_identity',side_effect=changed):
            with self.assertRaises(Exception):self.verify()
    def test_final_service_or_listener_pid_change_refuses(self):
        for field in ('main','listener'):
            original=self.bounded;counts={'pid':0,'ss':0}
            def changing(args,**kwargs):
                result=original(args,**kwargs)
                if args[-1]=='--property=MainPID':
                    counts['pid']+=1
                    if field=='main' and counts['pid']==2:return b'MainPID=444\n'
                if args[0]=='/usr/bin/ss':
                    counts['ss']+=1
                    if field=='listener' and counts['ss']==3:return b'LISTEN users:(("node",pid=444,fd=18))\n'
                return result
            with mock.patch.object(self.facts,'bounded',side_effect=changing):
                with self.subTest(field=field):
                    with self.assertRaises(Exception):self.verify()
    def test_uid_mismatch_refuses_before_commands(self):
        with self.assertRaises(Exception):host.runtime_configuration(self.release,self.values,str(self.node),self.uid+1,self.database)
        self.assertEqual(self.calls,[])
    def test_initial_and_precommit_sites_use_full_same_uid_verifier(self):
        tree=ast.parse((ROOT/'ops/owner-document-host.py').read_text());operation=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='operation');before=next(n for n in ast.walk(operation) if isinstance(n,ast.FunctionDef) and n.name=='before_commit')
        self.assertEqual(sum(isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='runtime_configuration' for n in ast.walk(operation)),2)
        self.assertTrue(any(isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='runtime_configuration' for n in ast.walk(before)))
        self.assertFalse(any(isinstance(n,ast.Attribute) and n.attr=='runtime_flags' for n in ast.walk(operation)))

if __name__=='__main__':unittest.main()
