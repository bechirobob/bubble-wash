import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
const cwd=process.cwd();
const directory=mkdtempSync(join(tmpdir(),'bubblewash-request-retry-'));
for(const key of Object.keys(process.env))if(/^(BUBBLEWASH_|NEXT_PUBLIC_BUBBLEWASH_|RESEND_|WHATSAPP_|PAYSTACK_)/.test(key))delete process.env[key];
Object.assign(process.env,{BUBBLEWASH_DATABASE_PATH:join(directory,'synthetic.sqlite'),BUBBLEWASH_SESSION_SECRET:'synthetic-request-retry-secret-more-than32characters',NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED:'false',NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED:'false'});
process.chdir(directory);
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('External fetch forbidden in synthetic retry proof');};
try{
 const {NextRequest}=await import('next/server.js');
 const {appendSubmissionRecord,readSubmissionRecordsForOrder}=await import('../src/lib/data-store.ts');
 const {encodeCustomerSession,customerSessionCookieName}=await import('../src/lib/customer-session.ts');
 const {POST}=await import('../src/app/api/customer/request/route.ts');
 const {createCustomerRequest}=await import('../src/lib/customer-requests.ts');
 const {operationalDatabase}=await import('../src/lib/operational-store.ts');
 const db=operationalDatabase();
 const schema=()=>db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
 const schemaBefore=schema();
 const id='BW-SYNTHETIC-RETRY';
 appendSubmissionRecord({id,createdAt:new Date().toISOString(),source:'synthetic-test',data:{submissionType:'pickup-booking',name:'Synthetic Retry',email:'retry@example.invalid',phone:'0200000000'}});
 const cookie=`${customerSessionCookieName}=${encodeCustomerSession(id,'retry@example.invalid',true)}`;
 const payload={action:'care',note:'Synthetic committed response lost, then retried',idempotencyKey:randomUUID()};
 const request=(body=payload)=>new NextRequest('https://bubblewash.co/api/customer/request',{method:'POST',headers:{host:'bubblewash.co',origin:'https://bubblewash.co','content-type':'application/json',cookie},body:JSON.stringify(body)});
 const first=await POST(request());assert.equal(first.status,200);
 // The caller receives no receipt; it retries the same logical request.
 const retry=await POST(request());assert.equal(retry.status,200);
 const cases=readSubmissionRecordsForOrder(id).filter(record=>record.data.submissionType==='support-ticket');
 console.log(JSON.stringify({syntheticOnly:true,firstStatus:first.status,retryStatus:retry.status,ticketCount:cases.length}));
 assert.equal(cases.length,1,'committed request retried with the same key must create exactly one support ticket');
 const receipt=await retry.json();assert.equal(receipt.ticketId,cases[0].id);assert.equal(receipt.replayed,true);
 const conflict=await POST(request({...payload,note:'Changed logical request'}));assert.equal(conflict.status,409);
 assert.equal(readSubmissionRecordsForOrder(id).filter(r=>r.data.submissionType==='support-ticket').length,1);
 const invalid=await POST(request({...payload,idempotencyKey:'short'}));assert.equal(invalid.status,400);
 const other='BW-SYNTHETIC-OTHER';
 appendSubmissionRecord({id:other,createdAt:new Date().toISOString(),source:'synthetic-test',data:{submissionType:'pickup-booking',name:'Other Synthetic',email:'other@example.invalid'}});
 const otherReceipt=createCustomerRequest(other,payload,payload.idempotencyKey,"submission");assert.equal(otherReceipt.status,200);assert.notEqual(otherReceipt.body.ticketId,receipt.ticketId);
 const unkeyed={action:'care',note:'Legacy unkeyed request'};
 const noKey1=createCustomerRequest(id,unkeyed);const noKey2=createCustomerRequest(id,unkeyed);
 assert.equal(noKey1.status,200);assert.equal(noKey2.status,200);assert.notEqual(noKey1.body.ticketId,noKey2.body.ticketId);
 assert.deepEqual(schema(),schemaBefore,'keyed requests must not create tables/indexes or alter schema');
 // Default legacy-key callers must still execute the real schema/receipt path.
 assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='mobile_customer_requests'").get(),undefined);
 const freshLegacyPayload={action:'care',note:'New legacy caller request'};
 const legacyBefore=readSubmissionRecordsForOrder(id).length;
 const freshLegacy=createCustomerRequest(id,freshLegacyPayload,'new-legacy-key');
 assert.equal(freshLegacy.status,200);assert.equal(freshLegacy.body.replayed,undefined);
 const persistedLegacy=db.prepare('SELECT receipt FROM mobile_customer_requests WHERE order_id=? AND request_key=?').get(id,'new-legacy-key');
 assert.deepEqual(JSON.parse(persistedLegacy.receipt),freshLegacy.body);
 const freshLegacyReplay=createCustomerRequest(id,freshLegacyPayload,'new-legacy-key');
 assert.equal(freshLegacyReplay.status,200);assert.deepEqual(freshLegacyReplay.body,{...freshLegacy.body,replayed:true});
 assert.equal(readSubmissionRecordsForOrder(id).length,legacyBefore+1);
 assert.equal(createCustomerRequest(id,{...freshLegacyPayload,note:'Changed'},'new-legacy-key').status,409);
 // A web-storage lookup also respects an already persisted legacy receipt.
 assert.deepEqual(createCustomerRequest(id,freshLegacyPayload,'new-legacy-key','submission').body,freshLegacyReplay.body);
 // Explicit historical receipt retains its original response shape.

 const legacyPayload={action:'care',note:'Legacy committed request'};
 const legacyReceipt={ok:true,ticketId:'BWC-LEGACY-RECEIPT',message:'Legacy receipt'};
 const legacyHash=createHash('sha256').update(JSON.stringify(['care','','',legacyPayload.note])).digest('hex');
 db.prepare('INSERT INTO mobile_customer_requests VALUES (?,?,?,?)').run(id,'old-key',legacyHash,JSON.stringify(legacyReceipt));
 const legacy=createCustomerRequest(id,legacyPayload,'old-key');assert.equal(legacy.status,200);assert.deepEqual(legacy.body,{...legacyReceipt,replayed:true});
 assert.equal(createCustomerRequest(id,{...legacyPayload,note:'Changed'},'old-key').status,409);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mobile_customer_requests').get().n,2);
 console.log('PASS: replay, conflict, per-order isolation, browser key validation, no-key compatibility, web schema unchanged, genuine default legacy table create/replay, historical receipts');
}finally{globalThis.fetch=originalFetch;process.chdir(cwd);rmSync(directory,{recursive:true,force:true});}
