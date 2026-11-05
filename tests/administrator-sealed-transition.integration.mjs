// Disposable synthetic administrator only. Never contacts production or sends messages.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,generateKeyPairSync,createPublicKey} from 'node:crypto';
import * as capsule from '../ops/administrator-transition-capsule.mjs';
import * as ownerCapsule from '../ops/owner-renewal-capsule.mjs';
const root=path.resolve(new URL('..',import.meta.url).pathname);
const dir=mkdtempSync(path.join(tmpdir(),'synthetic-owner-renewal-'));
Object.assign(process.env,{NODE_ENV:'production',BUBBLEWASH_DATABASE_DRIVER:'sqlite',BUBBLEWASH_DATABASE_PATH:path.join(dir,'fixture.sqlite'),BUBBLEWASH_ADMIN_EMAIL:'master@example.invalid',BUBBLEWASH_DISABLE_DEMO_LOGIN:'true',BUBBLEWASH_STAFF_AUTH_DISABLED:'false',BUBBLEWASH_SESSION_SECRET:'synthetic-only-not-a-real-session-secret'});
globalThis.fetch=async()=>{throw Error('Network forbidden in renewal fixture');};
const deps=await capsule.runtime(root),data=await import('../src/lib/data-store.ts');
const db=data.getDatabase();deps.initializeStaffAccountsSchema(db);db.exec(capsule.CAPABILITY_DDL);db.exec(readFileSync(path.join(root,'db/proposed/research-v1.sql'),'utf8'));
const canonical=v=>JSON.stringify(v);const hash=v=>createHash('sha256').update(v).digest('hex');
const context={controlSha:'a'.repeat(40),runtimeSha:'b'.repeat(40),runId:'12345',runAttempt:'1',operation:capsule.OPERATION};
const keys=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const request={mode:'check',operation:capsule.OPERATION,email:'abigail@bubblewash.co',name:'Abigail Kabirou',actor:'github-actions:fixture',release:root,dbPath:process.env.BUBBLEWASH_DATABASE_PATH,env:{...process.env},context,publicKey:keys.publicKey,schemaSha256:hash(canonical(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').raw().all()))};
const insert=db.prepare('INSERT INTO staff_accounts VALUES (?,?,?,?,?,?,?,?,?,?)');
insert.run(request.email,request.name,'admin','','','old-version','invited',hash('old-synthetic-token'),'2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z');
db.prepare('INSERT INTO staff_owner_capabilities VALUES (?,1)').run(request.email);
insert.run('preserved@example.invalid','Other Owner','admin','','other-password','other-version','active','','','2020-01-01');db.prepare('INSERT INTO staff_owner_capabilities VALUES (?,1)').run('preserved@example.invalid');
const dump=()=>JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').raw().all()]));
const transitionModule=await import('../ops/administrator-invitation-transition.ts');
db.exec('SAVEPOINT schema_fixture');db.exec(transitionModule.administratorPermissionsDdl);
request.expectedAfterSchemaSha256=hash(canonical(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').raw().all()));
db.exec('ROLLBACK TO schema_fixture; RELEASE schema_fixture');
let freshToken='',sealed,plainResult;
const expected={context,email:request.email,name:request.name,keySha256:hash(createPublicKey(keys.publicKey).export({type:'spki',format:'der'}))};
const checks=[];const test=(name,fn)=>{fn();checks.push(name);};
const original=db.prepare('SELECT * FROM staff_accounts WHERE email=?').get(request.email);
const reset=()=>db.prepare('UPDATE staff_accounts SET name=@name,role=@role,entity_id=@entity_id,password_hash=@password_hash,credential_version=@credential_version,status=@status,token_hash=@token_hash,token_expires_at=@token_expires_at,updated_at=@updated_at WHERE email=@email').run(original);
try {
 test('readonly eligible check changes no records',()=>{const before=dump();const status=capsule.checkInvitation(request,deps);assert.equal(status.eligible,true);assert.match(status.fingerprint,/^[a-f0-9]{64}$/);assert.equal(dump(),before);request.statusFingerprint=status.fingerprint;request.mode='transition-document';});
 for(const [field,value] of [['status','active'],['status','suspended'],['status','archived'],['role','support'],['password_hash','set'],['entity_id','bound'],['name','Different'],['token_expires_at','2099-01-01T00:00:00.000Z'],['token_hash','']]) test('refuse '+field+'='+value,()=>{db.prepare('UPDATE staff_accounts SET '+field+'=? WHERE email=?').run(value,request.email);const before=dump();assert.throws(()=>capsule.transitionInvitation(request,deps,()=>{}));assert.equal(dump(),before);reset();});
 test('missing capability refuses',()=>{db.prepare('DELETE FROM staff_owner_capabilities WHERE email=?').run(request.email);const before=dump();assert.throws(()=>capsule.transitionInvitation(request,deps,()=>{}));assert.equal(dump(),before);db.prepare('INSERT INTO staff_owner_capabilities VALUES (?,1)').run(request.email);});
 test('stale fingerprint refuses without writes',()=>{const before=dump();assert.throws(()=>capsule.transitionInvitation({...request,statusFingerprint:'0'.repeat(64)},deps,()=>{}));assert.equal(dump(),before);});
 test('encryption failure rolls back all changes',()=>{const before=dump();assert.throws(()=>capsule.transitionInvitation(request,deps,()=>{},()=>{throw Error('fixture');}));assert.equal(dump(),before);});
 test('parent precommit refusal rolls back',()=>{const before=dump();assert.throws(()=>capsule.transitionInvitation(request,deps,()=>{throw Error('fixture');}));assert.equal(dump(),before);});
 test('bootstrap collision refuses',()=>{const before=dump();assert.throws(()=>capsule.transitionInvitation({...request,env:{...request.env,BUBBLEWASH_ADMIN_EMAIL:request.email}},deps,()=>{}));assert.equal(dump(),before);});
 for(const [field,value] of [['operation','owner'],['email','other@example.invalid'],['schemaSha256','0'.repeat(64)],['expectedAfterSchemaSha256','0'.repeat(64)]]) test('request boundary '+field,()=>{const before=dump();assert.throws(()=>capsule.transitionInvitation({...request,[field]:value},deps,()=>{}));assert.equal(dump(),before);});
 test('successful transition removes owner access and preserves others with24h encrypted link',()=>{
  const other=db.prepare('SELECT * FROM staff_accounts WHERE email=?').get('preserved@example.invalid');const schema=db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();let committed=false;
  const encrypted=capsule.transitionInvitation(request,deps,()=>{committed=true;});assert.equal(committed,true);assert.equal(encrypted.includes(Buffer.from(request.email)),false);
  const plain=capsule.unseal(encrypted,keys.privateKey,{context,email:request.email,name:request.name,keySha256:hash(createPublicKey(keys.publicKey).export({type:'spki',format:'der'}))});
  assert.equal(Date.parse(plain.expiresAt)-Date.parse(plain.createdAt),86400000);const row=db.prepare('SELECT * FROM staff_accounts WHERE email=?').get(request.email);
  for(const field of ['email','name','role','entity_id','password_hash','status'])assert.equal(row[field],original[field]);assert.notEqual(row.token_hash,original.token_hash);freshToken=new URL(plain.activationUrl).hash.slice(1);assert.equal(row.token_hash,hash(freshToken));assert.notEqual(row.credential_version,original.credential_version);
  assert.deepEqual(db.prepare('SELECT * FROM staff_accounts WHERE email=?').get('preserved@example.invalid'),other);assert.notDeepEqual(db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(),schema);assert.equal(db.prepare('SELECT * FROM staff_admin_permissions WHERE email=?').get(request.email).survey_results,1);assert.equal(db.prepare('SELECT count(*) n FROM submissions').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM staff_owner_capabilities').get().n,1);sealed=encrypted;plainResult=plain;assert.equal(plain.allStaffAccess,false);
 });
 test('secure unseal rejects context/key/recipient and owner-purpose substitution',()=>{
  for(const bad of [{...expected,email:'other@example.invalid'},{...expected,keySha256:'0'.repeat(64)},{...expected,context:{...context,runId:'999'}}])assert.throws(()=>capsule.unseal(sealed,keys.privateKey,bad));
  for(const [field,value] of [['allStaffAccess',true],['operationalWorkspaceAccess',false],['surveyResultsAccess',false],['ttlHours',23],['expiresAt',new Date(Date.parse(plainResult.createdAt)+86399000).toISOString()],['email','other@example.invalid'],['activationUrl','https://evil.invalid/'],['mfaPolicy','shared-seed']]) {
   const bad=capsule.seal({...plainResult,[field]:value},keys.publicKey,context);assert.throws(()=>capsule.unseal(bad,keys.privateKey,expected));
  }
  assert.throws(()=>capsule.seal(plainResult,keys.publicKey,{...context,operation:'owner'}));
  const ownerContext={controlSha:context.controlSha,runtimeSha:context.runtimeSha,runId:context.runId,runAttempt:context.runAttempt};
  const ownerRaw=ownerCapsule.seal({...plainResult,context:ownerContext,allStaffAccess:true},keys.publicKey,ownerContext);
  assert.throws(()=>capsule.unseal(ownerRaw,keys.privateKey,expected));
  assert.throws(()=>ownerCapsule.unseal(sealed,keys.privateKey,{...expected,context:ownerContext}));
  const wrongKeys=generateKeyPairSync('rsa',{modulusLength:3072,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  assert.throws(()=>capsule.unseal(sealed,wrongKeys.privateKey,expected));
 });
 test('private CLI recovery emits no plaintext and refuses overwrite',()=>{
  const keyFile=path.join(dir,'key.pem'),cipherFile=path.join(dir,'handover.enc'),outFile=path.join(dir,'private-handover.json');
  writeFileSync(keyFile,keys.privateKey,{mode:0o600});writeFileSync(cipherFile,sealed,{mode:0o600});
  const args=[path.join(root,'ops/administrator-transition-capsule.mjs'),'decrypt',keyFile,cipherFile,'--handover-file',outFile];
  const result=spawnSync(process.execPath,args,{input:JSON.stringify(expected)+'\n',encoding:'utf8'});
  assert.equal(result.status,0);assert.equal(result.stdout,'');assert.equal(statSync(outFile).mode&0o777,0o600);
  assert.deepEqual(JSON.parse(readFileSync(outFile,'utf8')),{activationUrl:plainResult.activationUrl,expiresAt:plainResult.expiresAt});
  assert.notEqual(spawnSync(process.execPath,args,{input:JSON.stringify(expected)+'\n',encoding:'utf8'}).status,0);
 });
 test('repeat operation cannot rotate fresh invitation',()=>{const before=dump();assert.throws(()=>capsule.transitionInvitation(request,deps,()=>{}));assert.equal(dump(),before);});
 const staff=await import('../src/lib/staff-accounts.ts');
 test('actual activation rejects old token, redeems fresh once without owner capability',()=>{
  assert.equal(staff.activateStaffAccount('old-synthetic-token','Synthetic owner test password 123!'),false);
  assert.equal(staff.activateStaffAccount(freshToken,'Synthetic owner test password 123!'),true);
  assert.equal(staff.activateStaffAccount(freshToken,'Another synthetic password 123!'),false);
  const account=staff.listStaffAccounts().find(a=>a.email===request.email);assert.equal(account.status,'active');assert.equal(account.role,'admin');assert.equal(account.allStaffAccess,false);assert.equal(account.operationalWorkspaceAccess,true);assert.equal(account.surveyResultsAccess,true);
  assert.equal(db.prepare('SELECT token_hash FROM staff_accounts WHERE email=?').get(request.email).token_hash,'');
  assert.throws(()=>capsule.checkInvitation(request,deps)); // Pre-migration schema commitment is deliberately stale.
 });
 console.log(JSON.stringify({ok:true,checks:checks.length,syntheticOnly:true,noProviderCalls:true}));
} finally {db.close();rmSync(dir,{recursive:true,force:true});}
