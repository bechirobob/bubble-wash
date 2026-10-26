// Disposable synthetic owner only. Never contacts production or sends messages.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,generateKeyPairSync,createPublicKey} from 'node:crypto';
import * as capsule from '../ops/owner-renewal-capsule.mjs';
const root=path.resolve(new URL('..',import.meta.url).pathname);
const dir=mkdtempSync(path.join(tmpdir(),'synthetic-owner-renewal-'));
Object.assign(process.env,{NODE_ENV:'production',BUBBLEWASH_DATABASE_DRIVER:'sqlite',BUBBLEWASH_DATABASE_PATH:path.join(dir,'fixture.sqlite'),BUBBLEWASH_ADMIN_EMAIL:'master@example.invalid',BUBBLEWASH_DISABLE_DEMO_LOGIN:'true',BUBBLEWASH_STAFF_AUTH_DISABLED:'false',BUBBLEWASH_SESSION_SECRET:'synthetic-only-not-a-real-session-secret'});
globalThis.fetch=async()=>{throw Error('Network forbidden in renewal fixture');};
const deps=await capsule.runtime(root),data=await import('../src/lib/data-store.ts');
const db=data.getDatabase();deps.initializeStaffAccountsSchema(db);db.exec(capsule.CAPABILITY_DDL);db.exec(readFileSync(path.join(root,'db/proposed/research-v1.sql'),'utf8'));
const canonical=v=>JSON.stringify(v);const hash=v=>createHash('sha256').update(v).digest('hex');
const context={controlSha:'a'.repeat(40),runtimeSha:'b'.repeat(40),runId:'12345',runAttempt:'1'};
const keys=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const request={mode:'check',email:'pending@example.invalid',name:'Synthetic Pending',actor:'github-actions:fixture',release:root,dbPath:process.env.BUBBLEWASH_DATABASE_PATH,env:{...process.env},context,publicKey:keys.publicKey,schemaSha256:hash(canonical(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').raw().all()))};
const insert=db.prepare('INSERT INTO staff_accounts VALUES (?,?,?,?,?,?,?,?,?,?)');
insert.run(request.email,request.name,'admin','','','old-version','invited',hash('old-synthetic-token'),'2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z');
db.prepare('INSERT INTO staff_owner_capabilities VALUES (?,1)').run(request.email);
insert.run('preserved@example.invalid','Other Owner','admin','','other-password','other-version','active','','','2020-01-01');db.prepare('INSERT INTO staff_owner_capabilities VALUES (?,1)').run('preserved@example.invalid');
const dump=()=>JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').raw().all()]));
let freshToken='';
const checks=[];const test=(name,fn)=>{fn();checks.push(name);};
const original=db.prepare('SELECT * FROM staff_accounts WHERE email=?').get(request.email);
const reset=()=>db.prepare('UPDATE staff_accounts SET name=@name,role=@role,entity_id=@entity_id,password_hash=@password_hash,credential_version=@credential_version,status=@status,token_hash=@token_hash,token_expires_at=@token_expires_at,updated_at=@updated_at WHERE email=@email').run(original);
try {
 test('readonly eligible check changes no records',()=>{const before=dump();const status=capsule.checkInvitation(request,deps);assert.equal(status.eligible,true);assert.match(status.fingerprint,/^[a-f0-9]{64}$/);assert.equal(dump(),before);request.statusFingerprint=status.fingerprint;});
 for(const [field,value] of [['status','active'],['status','suspended'],['status','archived'],['role','support'],['password_hash','set'],['entity_id','bound'],['name','Different'],['token_expires_at','2099-01-01T00:00:00.000Z'],['token_hash','']]) test('refuse '+field+'='+value,()=>{db.prepare('UPDATE staff_accounts SET '+field+'=? WHERE email=?').run(value,request.email);const before=dump();assert.throws(()=>capsule.renewInvitation(request,deps,()=>{}));assert.equal(dump(),before);reset();});
 test('missing capability refuses',()=>{db.prepare('DELETE FROM staff_owner_capabilities WHERE email=?').run(request.email);const before=dump();assert.throws(()=>capsule.renewInvitation(request,deps,()=>{}));assert.equal(dump(),before);db.prepare('INSERT INTO staff_owner_capabilities VALUES (?,1)').run(request.email);});
 test('stale fingerprint refuses without writes',()=>{const before=dump();assert.throws(()=>capsule.renewInvitation({...request,statusFingerprint:'0'.repeat(64)},deps,()=>{}));assert.equal(dump(),before);});
 test('encryption failure rolls back all changes',()=>{const before=dump();assert.throws(()=>capsule.renewInvitation(request,deps,()=>{},()=>{throw Error('fixture');}));assert.equal(dump(),before);});
 test('parent precommit refusal rolls back',()=>{const before=dump();assert.throws(()=>capsule.renewInvitation(request,deps,()=>{throw Error('fixture');}));assert.equal(dump(),before);});
 test('bootstrap collision refuses',()=>{const before=dump();assert.throws(()=>capsule.renewInvitation({...request,env:{...request.env,BUBBLEWASH_ADMIN_EMAIL:request.email}},deps,()=>{}));assert.equal(dump(),before);});
 test('successful renewal preserves access and others with24h encrypted link',()=>{
  const other=db.prepare('SELECT * FROM staff_accounts WHERE email=?').get('preserved@example.invalid');const schema=db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();let committed=false;
  const encrypted=capsule.renewInvitation(request,deps,()=>{committed=true;});assert.equal(committed,true);assert.equal(encrypted.includes(Buffer.from(request.email)),false);
  const plain=capsule.unseal(encrypted,keys.privateKey,{context,email:request.email,name:request.name,keySha256:hash(createPublicKey(keys.publicKey).export({type:'spki',format:'der'}))});
  assert.equal(Date.parse(plain.expiresAt)-Date.parse(plain.createdAt),86400000);const row=db.prepare('SELECT * FROM staff_accounts WHERE email=?').get(request.email);
  for(const field of ['email','name','role','entity_id','password_hash','status'])assert.equal(row[field],original[field]);assert.notEqual(row.token_hash,original.token_hash);freshToken=new URL(plain.activationUrl).hash.slice(1);assert.equal(row.token_hash,hash(freshToken));assert.notEqual(row.credential_version,original.credential_version);
  assert.deepEqual(db.prepare('SELECT * FROM staff_accounts WHERE email=?').get('preserved@example.invalid'),other);assert.deepEqual(db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(),schema);assert.equal(db.prepare('SELECT count(*) n FROM submissions').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM staff_owner_capabilities').get().n,2);
 });
 test('repeat operation cannot rotate fresh invitation',()=>{const before=dump();assert.throws(()=>capsule.renewInvitation(request,deps,()=>{}));assert.equal(dump(),before);});
 const staff=await import('../src/lib/staff-accounts.ts');
 test('actual activation rejects old token, redeems fresh once and preserves owner capability',()=>{
  assert.equal(staff.activateStaffAccount('old-synthetic-token','Synthetic owner test password 123!'),false);
  assert.equal(staff.activateStaffAccount(freshToken,'Synthetic owner test password 123!'),true);
  assert.equal(staff.activateStaffAccount(freshToken,'Another synthetic password 123!'),false);
  const account=staff.listStaffAccounts().find(a=>a.email===request.email);assert.equal(account.status,'active');assert.equal(account.role,'admin');assert.equal(account.allStaffAccess,true);
  assert.equal(db.prepare('SELECT token_hash FROM staff_accounts WHERE email=?').get(request.email).token_hash,'');
  assert.equal(capsule.checkInvitation(request,deps).eligible,false);
 });
 console.log(JSON.stringify({ok:true,checks:checks.length,syntheticOnly:true,noProviderCalls:true}));
} finally {db.close();rmSync(dir,{recursive:true,force:true});}
