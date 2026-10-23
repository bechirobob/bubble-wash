import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHmac } from 'node:crypto';
const root=process.cwd();
const temporary=mkdtempSync(path.join(tmpdir(),'bubblewash-creator-proof-'));
for (const key of Object.keys(process.env)) if (/^(BUBBLEWASH_|NEXT_PUBLIC_BUBBLEWASH_|RESEND_|WHATSAPP_|PAYSTACK_)/.test(key)) delete process.env[key];
Object.assign(process.env,{NODE_ENV:'test',BUBBLEWASH_DATABASE_PATH:path.join(temporary,'test.sqlite'),BUBBLEWASH_SESSION_SECRET:'synthetic-session-secret-no-production-purpose',NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED:'false',NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED:'false'});
globalThis.fetch=async()=>{throw new Error('External calls forbidden in fixture')};
const load=p=>import(pathToFileURL(path.join(root,p)).href);
const {NextRequest}=await load('node_modules/next/server.js');
const store=await load('src/lib/data-store.ts');
const sessions=await load('src/lib/customer-session.ts');
const {POST:submit}=await load('src/app/api/submit/route.ts');
const {POST:access}=await load('src/app/api/customer/access/route.ts');
const {POST:reissue}=await load('src/app/api/customer/delivery-code/route.ts');
const {GET:order}=await load('src/app/api/customer/order/route.ts');
const {GET:track}=await load('src/app/api/track/route.ts');
process.chdir(temporary);
let checks=0;const equal=(a,b)=>{assert.deepEqual(a,b);checks++};
const post=(url,body,cookie='')=>new NextRequest('https://example.invalid'+url,{method:'POST',headers:{host:'example.invalid',origin:'https://example.invalid','content-type':'application/json',cookie},body:JSON.stringify(body)});
const sessionCookie=response=>response.headers.getSetCookie()[0].split(';')[0];
const decode=cookie=>sessions.decodeCustomerSession(decodeURIComponent(cookie.split('=').slice(1).join('=')));
const payload={submissionType:'pickup-booking',idempotencyKey:'creator-session-synthetic-0001',name:'Synthetic',email:'claimed@example.invalid',phone:'0200000004',company:'Synthetic',pickupAddress:'Synthetic reception, Osu, Accra',pickupDate:new Date(Date.now()+86400000).toISOString().slice(0,10),pickupWindow:'8:00–10:00',plan:'Weekly',businessType:'Office or small team',laundryRhythm:'About once a week',locationCount:'1 location',servicePriority:'Standard scheduled service',paymentPreference:'Invoice me',alertPreference:'Call me',addons:[]};
try {
  const created=await submit(post('/api/submit',payload));equal(created.status,200);
  const body=await created.json();equal(body.bookingReference,'BW-001');equal(/^\d{6}$/.test(body.deliveryCode),true);
  const cookie=sessionCookie(created);equal(decode(cookie).verifiedContact,false);equal(decode(cookie).orderId,body.id);
  equal((await order(new NextRequest('https://example.invalid/api/customer/order',{headers:{cookie}}))).status,200);
  equal((await reissue(post('/api/customer/delivery-code',{},cookie))).status,403);
  // An authentic pre-fix cookie could claim verifiedContact without mailbox
  // proof. Preserve its own-order access but do not inherit that claim.
  const old=JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0],'base64url').toString('utf8'));
  old.verifiedContact=true;delete old.contactProof;
  const oldPayload=Buffer.from(JSON.stringify(old)).toString('base64url');
  const oldSigned=oldPayload+'.'+createHmac('sha256',process.env.BUBBLEWASH_SESSION_SECRET).update(oldPayload).digest('base64url');
  const oldCookie=sessions.customerSessionCookieName+'='+oldSigned;
  equal(decode(oldCookie).verifiedContact,false);
  equal((await order(new NextRequest('https://example.invalid/api/customer/order',{headers:{cookie:oldCookie}}))).status,200);
  equal((await reissue(post('/api/customer/delivery-code',{},oldCookie))).status,403);
  const proven=sessions.decodeCustomerSession(sessions.encodeCustomerSession(body.id,payload.email,true));
  equal(proven.verifiedContact,true);equal(proven.contactProof,'mailbox-v1');

  const replay=await submit(post('/api/submit',payload));const replayBody=await replay.json();equal(replayBody.id,body.id);equal(replayBody.deliveryCode,body.deliveryCode);equal(decode(sessionCookie(replay)).verifiedContact,false);
  const other='BW-A1B2C3D4E5F60708';store.appendSubmissionRecord({id:other,createdAt:new Date().toISOString(),data:{...payload,idempotencyKey:undefined}});
  const pivot=await access(post('/api/customer/access',{orderId:other,contact:payload.email},cookie));equal(pivot.status,200);equal(decode(sessionCookie(pivot)).verifiedContact,false);
  equal((await reissue(post('/api/customer/delivery-code',{},sessionCookie(pivot)))).status,403);
  const predictable=await access(post('/api/customer/access',{orderId:'BW-002',contact:payload.email},cookie));equal(predictable.status,400);equal(predictable.headers.has('set-cookie'),false);
  const numeric='BW-1234567812344234';
  store.getDatabase().prepare('INSERT INTO submissions VALUES (?,?,?,?)').run(numeric,'time','legacy-synthetic',JSON.stringify(payload));
  for(const id of ['BW-001',numeric]) {
    for(const field of ['id','trackingToken']) {
      const result=await track(new NextRequest('https://example.invalid/api/track?'+field+'='+id));
      equal(result.status,400);equal(result.headers.has('set-cookie'),false);
    }
    const result=await access(post('/api/customer/access',{orderId:id,contact:payload.email},cookie));
    equal(result.status,400);equal(result.headers.has('set-cookie'),false);
  }
  for(const id of [body.id,other]) {
    const result=await track(new NextRequest('https://example.invalid/api/track?trackingToken='+id));
    equal(result.status,200);equal(result.headers.get('cache-control'),'private, no-store');
    equal((await result.json()).tracking.bookingReference,id===body.id?'BW-001':'BW-002');
  }
  equal(pivot.headers.get('cache-control'),'private, no-store');

  console.log(JSON.stringify({ok:true,checks,creatorMailboxProof:false,ownOrderAndInitialHandoffPreserved:true}));
} finally {store.getDatabase().close();process.chdir(root);rmSync(temporary,{recursive:true,force:true});}
