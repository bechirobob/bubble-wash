import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'bw-uat-second-'));
Object.assign(process.env, { NODE_ENV: 'production', BUBBLEWASH_UAT_ENABLED: 'true', BUBBLEWASH_UAT_ISOLATION_CONFIRMED: 'true', BUBBLEWASH_PUBLIC_URL: 'https://uat.example.invalid', BUBBLEWASH_DATABASE_PATH: join(directory,'synthetic.sqlite'), BUBBLEWASH_UAT_DATA_ROOT: directory, NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED:'false', NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED:'false', BUBBLEWASH_RESEARCH_EMAIL_ENABLED:'false', BUBBLEWASH_DISABLE_DEMO_LOGIN:'true', BUBBLEWASH_SESSION_SECRET:'synthetic-session-secret-only-for-test-123' });
const {generateKeyPairSync,privateDecrypt,createDecipheriv,constants}=await import('node:crypto');
const {issueSealedHandover,retrieveSealedHandover}=await import('../scripts/uat-sealed-handover.mjs');
const {getDatabase}=await import('../src/lib/data-store.ts');
const {upsertVendorAvailability,upsertDriverAvailability}=await import('../src/lib/availability-store.ts');
const {findStaffUser}=await import('../src/lib/auth.ts');
const db=getDatabase();
const pair=generateKeyPairSync('rsa',{modulusLength:3072});
const publicKey=pair.publicKey.export({type:'spki',format:'pem'});
const firstRequest={action:'issue',approved:true,ready:true,publicKey};
const second=await import('../scripts/uat-second-cohort.mjs');
const issueSecondCohort=(request,database=db)=>second.issueSecondCohort(request,database);
const retrieveSecondCohort=request=>second.retrieveSecondCohort(request,db);
const secondCohortState=()=>second.secondCohortState(db);
const {revokeUatAccount}=await import('../src/lib/uat-accounts.ts');
const {randomUUID}=await import('node:crypto');
function decrypt(envelope, operationId, state) {
  const key=privateDecrypt({key:pair.privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(envelope.wrappedKey,'base64'));
  try {
    const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));
    decipher.setAAD(Buffer.from(envelope.schema));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
    const value=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]));
    assert.equal(value.schema,'bubblewash-uat-second-cohort/v1');
    assert.equal(value.operationId,operationId);assert.equal(value.expectedStateSha256,state);
    assert.equal(value.recipientSha256,envelope.recipientSha256);
    return value;
  } finally {key.fill(0);}
}
const snapshot=()=>JSON.stringify(['staff_uat_accounts','staff_uat_audit','vendor_availability','driver_availability','uat_sealed_handover','submissions','driver_live_locations'].map(table=>db.prepare(`SELECT * FROM ${table}`).all()));
const hasSecond=()=>db.prepare("SELECT 1 FROM sqlite_master WHERE name='uat_second_cohort_handover'").get();
try {
  assert.throws(()=>second.secondCohortState());
  const base={approved:true,ready:true,publicKey,operationId:randomUUID(),notBefore:Date.now(),approvedUntil:Date.now()+300000};
  assert.throws(()=>issueSecondCohort({...base,expectedStateSha256:secondCohortState()}),'cannot bootstrap originals');
  upsertVendorAvailability({vendorId:'uat-vendor-one',vendorName:'UAT Laundry One',serviceZones:['Osu'],serviceTypes:['Wash + fold'],capacityRemaining:10,availabilityStatus:'available',updatedBy:'synthetic-test'});
  upsertDriverAvailability({driverId:'uat-driver-one',driverName:'UAT Driver One',serviceZones:['Osu'],capacityRemaining:10,availabilityStatus:'active',updatedBy:'synthetic-test'});
  const first=issueSealedHandover(firstRequest);
  revokeUatAccount('review-driver','synthetic-revocation');
  db.prepare("UPDATE staff_uat_accounts SET status='expired',password_hash='' WHERE username='review-support'").run();
  db.prepare('INSERT INTO submissions VALUES (?,?,?,?)').run('synthetic-preserved','2000-01-01','synthetic','{"orderId":"synthetic-old-order"}');
  db.prepare('INSERT INTO driver_live_locations VALUES (?,?,?,?,?,?,?)').run('synthetic-old-driver','synthetic-old-order',5.6,-0.2,10,'2000-01-01','2000-01-01');
  const before=snapshot();
  const request={...base,expectedStateSha256:secondCohortState()};
  for(const override of [{approved:false},{ready:false},{operationId:'bad'},{expectedStateSha256:'0'.repeat(64)},
    {notBefore:Date.now()+60000},{approvedUntil:Date.now()-1},{approvedUntil:base.notBefore+300001},{publicKey:'invalid'}]) {
    assert.throws(()=>issueSecondCohort({...request,...override}));assert.equal(snapshot(),before);assert.equal(hasSecond(),undefined);
  }
  assert.throws(()=>second.issueSecondCohort(request));
  assert.throws(()=>second.secondCohortState({...db,name:join(directory,'other.sqlite')}));
  // Changes to approved roster/audit state invalidate the captured precondition.
  for(const sql of ["UPDATE vendor_availability SET vendor_name='Changed'", "UPDATE staff_uat_audit SET actor='changed'"]) {
    try {db.transaction(()=>{
      db.exec(sql);const changed=snapshot();
      assert.throws(()=>issueSecondCohort(request));assert.equal(snapshot(),changed);
      throw new Error('restore synthetic state');
    })();}catch(error){assert.equal(error.message,'restore synthetic state');}
  }
  db.exec('CREATE TABLE uat_second_cohort_handover (id INTEGER)');
  assert.throws(()=>issueSecondCohort(request),'even an empty existing receipt table is uncertain');
  db.exec('DROP TABLE uat_second_cohort_handover');
  const weak=generateKeyPairSync('rsa',{modulusLength:2048});
  assert.throws(()=>issueSecondCohort({...request,publicKey:weak.publicKey.export({type:'spki',format:'pem'})}));
  // Missing driver fails after earlier roles were inserted; entire cohort/audit rolls back.
  try {db.transaction(()=>{
    db.prepare("DELETE FROM driver_availability WHERE driver_id='uat-driver-one'").run();
    const missing=snapshot();
    assert.throws(()=>issueSecondCohort({...request,expectedStateSha256:secondCohortState()}));
    assert.equal(snapshot(),missing);assert.equal(hasSecond(),undefined);
    throw new Error('restore synthetic roster');
  })();} catch(error){assert.equal(error.message,'restore synthetic roster');}
  assert.equal(snapshot(),before);
  // Fail the final receipt insert, proving accounts, audit, and DDL rollback.
  const wrapped={name:db.name,prepare(sql){if(sql.startsWith('INSERT INTO uat_second_cohort_handover'))throw new Error('synthetic disk failure');return db.prepare(sql);},exec:sql=>db.exec(sql),transaction:fn=>db.transaction(fn)};
  assert.throws(()=>issueSecondCohort(request,wrapped),/synthetic disk failure/);
  assert.equal(snapshot(),before);assert.equal(hasSecond(),undefined);
  const realNow=Date.now;let calls=0;
  Date.now=()=>++calls<2?realNow():request.approvedUntil;
  try{assert.throws(()=>issueSecondCohort(request));}finally{Date.now=realNow;}
  assert.equal(snapshot(),before);assert.equal(hasSecond(),undefined);
  calls=0;Date.now=()=>++calls<2?realNow():request.notBefore-1;
  try{assert.throws(()=>issueSecondCohort(request));}finally{Date.now=realNow;}
  assert.equal(snapshot(),before);assert.equal(hasSecond(),undefined);
  const issuedBefore=Date.now();
  const envelope=issueSecondCohort(request);
  const value=decrypt(envelope,request.operationId,request.expectedStateSha256);
  assert.ok(Date.parse(value.issued_at)>=issuedBefore && Date.parse(value.issued_at)<=Date.now());
  assert.equal(Date.parse(value.expires_at)-Date.parse(value.issued_at),604800000);
  assert.deepEqual(Object.keys(value.accounts),['admin','vendor','driver','support']);
  assert.equal(new Set(Object.values(value.accounts).map(a=>a.password)).size,4);
  for(const [role,account] of Object.entries(value.accounts)) {
    const identity=findStaffUser(account.username,account.password);
    assert.equal(identity.role,role);assert.equal(identity.allStaffAccess,false);assert.equal(identity.temporaryAccess,true);
    assert.equal(identity.entityId,['vendor','driver'].includes(role)?`uat-${role}-one`:undefined);
    assert.ok(!JSON.stringify(envelope).includes(account.password));
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM staff_uat_accounts').all()).includes(account.password));
  }
  const after=JSON.parse(snapshot()),old=JSON.parse(before);
  assert.deepEqual(after[0].filter(a=>a.username.startsWith('review-')),old[0]);
  assert.deepEqual(after[1].filter(a=>a.username.startsWith('review-')),old[1]);
  assert.deepEqual(after.slice(2),old.slice(2));
  assert.deepEqual(retrieveSealedHandover(publicKey),first);
  const committed=snapshot();
  const other=generateKeyPairSync('rsa',{modulusLength:3072});
  assert.throws(()=>retrieveSecondCohort({...request,publicKey:other.publicKey.export({type:'spki',format:'pem'})}));
  for(const override of [{},{operationId:randomUUID()},{expectedStateSha256:secondCohortState()}])assert.throws(()=>issueSecondCohort({...request,...override}));
  assert.deepEqual(retrieveSecondCohort({...request,approvedUntil:0}),envelope);
  for(const override of [{operationId:randomUUID()},{expectedStateSha256:'0'.repeat(64)},{publicKey:weak.publicKey.export({type:'spki',format:'pem'})}])assert.throws(()=>retrieveSecondCohort({...request,...override}));
  assert.throws(()=>decrypt(envelope,randomUUID(),request.expectedStateSha256),'encrypted binding rejects a substituted operation');
  const damaged=Buffer.from(envelope.ciphertext,'base64');damaged[0]^=1;
  assert.throws(()=>decrypt({...envelope,ciphertext:damaged.toString('base64')},request.operationId,request.expectedStateSha256));
  assert.equal(snapshot(),committed);
  db.exec('DROP TABLE uat_second_cohort_handover');
  assert.throws(()=>issueSecondCohort({...request,expectedStateSha256:secondCohortState()}),'lost receipt cannot silently reissue');
  assert.equal(snapshot(),committed);
  process.env.BUBBLEWASH_UAT_ENABLED='false';
  assert.throws(()=>issueSecondCohort(request));assert.throws(()=>retrieveSecondCohort(request));
  console.log('Second cohort: atomicity, seven-day window, preservation, roster validation, encrypted operation binding, recovery, duplicate/stale rejection and rollback passed.');
} finally {db.close();rmSync(directory,{recursive:true,force:true});}
