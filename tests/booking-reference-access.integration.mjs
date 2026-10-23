import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
globalThis.AsyncLocalStorage = AsyncLocalStorage;
const root=process.cwd();
const dir=mkdtempSync(join(tmpdir(),'bubblewash-ref-review-'));
for(const key of Object.keys(process.env)) if(/^(BUBBLEWASH_|NEXT_PUBLIC_BUBBLEWASH_|RESEND_|WHATSAPP_|PAYSTACK_)/.test(key)) delete process.env[key];
Object.assign(process.env,{NODE_ENV:'test',BUBBLEWASH_DATABASE_PATH:join(dir,'test.sqlite'),BUBBLEWASH_SESSION_SECRET:'synthetic-reference-security-secret-32-plus',NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED:'false',NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED:'false',BUBBLEWASH_VENDOR_ENTITY_ID:'vendor-synthetic',BUBBLEWASH_DRIVER_ENTITY_ID:'driver-synthetic'});
globalThis.fetch=async()=>{throw new Error('External network forbidden in independent fixture')};
const load=rel=>import(pathToFileURL(join(root,rel)).href);
const {NextRequest}=await load('node_modules/next/server.js');
process.chdir(dir);
const store=await load('src/lib/data-store.ts');
const {saveBookingOnce}=await load('src/lib/operational-store.ts');
const sessions=await load('src/lib/customer-session.ts');
const {GET:track}=await load('src/app/api/track/route.ts');
const {POST:access}=await load('src/app/api/customer/access/route.ts');
const {GET:order}=await load('src/app/api/customer/order/route.ts');
const {POST:recover}=await load('src/app/api/customer/recover/route.ts');
const {POST:reissue}=await load('src/app/api/customer/delivery-code/route.ts');
let checks=0;
const equal=(a,b,msg)=>{assert.deepEqual(a,b,msg);checks++};
const db=store.getDatabase();
const rec=(id,email,phone)=>({id,createdAt:new Date().toISOString(),source:'synthetic-security-fixture',data:{submissionType:'pickup-booking',name:'Synthetic Customer',email,phone,company:'Synthetic Account',plan:'Weekly',area:'Osu',pickupAddress:'PRIVATE ADDRESS MARKER',pickupWindow:'8:00–10:00',service:'Wash + fold'}});
// An all-numeric UUID prefix must still produce a usable nonnumeric private
// capability through actual tracking, access, payment and QR routes below.
const {submissionIdentity}=await load('src/lib/submission-identity.ts');
const alice=rec(submissionIdentity('12345678-1234-4234-8234-123456789012'),'alice@example.invalid','0200000001');
const bob=rec('BW-B1B2C3D4E5F60708','bob@example.invalid','0200000002');
const a=saveBookingOnce(alice,'synthetic-key-alice',()=>{});
const b=saveBookingOnce(bob,'synthetic-key-bob',()=>{});
// Preserve a real historical all-numeric internal ID in the synthetic store.
// It must not bypass the numeric-label denial merely because a row exists.
const legacyNumeric=rec('BW-1234567812344234','legacy-numeric@example.invalid','0200000009');
db.prepare('INSERT INTO submissions (id, created_at, source, data) VALUES (?, ?, ?, ?)').run(legacyNumeric.id,legacyNumeric.createdAt,legacyNumeric.source,JSON.stringify(legacyNumeric.data));
const cookie=(id,contact,verified=false)=>`${sessions.customerSessionCookieName}=${sessions.encodeCustomerSession(id,contact,verified)}`;
const post=(path,body,ck='')=>{db.prepare('DELETE FROM rate_limits').run();return new NextRequest('https://example.invalid'+path,{method:'POST',headers:{host:'example.invalid',origin:'https://example.invalid','content-type':'application/json',cookie:ck},body:JSON.stringify(body)})};
const get=(path,ck='')=>{db.prepare('DELETE FROM rate_limits').run();return new NextRequest('https://example.invalid'+path,{headers:{cookie:ck}})};
try {
  equal(alice.id,'BW-R1234567812344234');
  equal(/^BW-\d+$/i.test(alice.id),false);
  equal(a.bookingReference,'BW-001');equal(b.bookingReference,'BW-002');
  for(const value of ['BW-001','BW-002','BW-999','BW-1000','BW-1234567812344234','bw-001']) {
    for(const field of ['id','trackingToken']){
      const r=await track(get(`/api/track?${field}=${encodeURIComponent(value)}`));equal(r.status,400,`predictable tracking ${field} ${value}`);equal(r.headers.has('set-cookie'),false);
    }
    for(const ck of ['',cookie(alice.id,alice.data.email),cookie(alice.id,alice.data.email,true),cookie(bob.id,bob.data.email,true)]){
      const r=await access(post('/api/customer/access',{orderId:value,contact:alice.data.email},ck));equal(r.status,400,'visible ref never mints session');equal(r.headers.has('set-cookie'),false);
    }
  }
  const storedNumericAccess=await access(post('/api/customer/access',{orderId:legacyNumeric.id,contact:legacyNumeric.data.email}));
  equal(storedNumericAccess.status,400);equal(storedNumericAccess.headers.has('set-cookie'),false);
  for(const field of ['id','trackingToken']){
    const r=await track(get(`/api/track?${field}=${alice.id.toLowerCase()}`));equal(r.status,200);equal(r.headers.get('cache-control'),'private, no-store');const data=await r.json();
    equal(data.tracking.bookingReference ?? data.tracking.id,'BW-001');equal(JSON.stringify(data).includes(alice.data.pickupAddress),false);equal(JSON.stringify(data).includes(alice.data.email),false);equal(JSON.stringify(data).includes(alice.data.phone),false);
  }
  equal((await access(post('/api/customer/access',{orderId:alice.id,contact:bob.data.email}))).status,401);
  const open=await access(post('/api/customer/access',{orderId:alice.id,contact:alice.data.email}));equal(open.status,200);equal(open.headers.get('cache-control'),'private, no-store');
  const openBody=await open.json();equal(openBody.order.bookingReference,'BW-001');equal(openBody.order.orderId,alice.id);
  const rawCookie=open.headers.getSetCookie()[0].split(';')[0];const session=sessions.decodeCustomerSession(decodeURIComponent(rawCookie.split('=').slice(1).join('=')));equal(session.verifiedContact,false);
  equal((await reissue(post('/api/customer/delivery-code',{},rawCookie))).status,403);
  equal((await order(get('/api/customer/order',rawCookie+'tampered'))).status,401);
  equal((await order(get('/api/customer/order',rawCookie))).status,200);
  // Simulate possession of a delivered recovery token, never send email.
  await recover(post('/api/customer/recover',{token:'bad'}));
  const token=randomBytes(32).toString('base64url');db.prepare('INSERT INTO customer_recovery VALUES (?,?,?,NULL)').run(createHash('sha256').update(token).digest('hex'),alice.data.email,new Date(Date.now()+600000).toISOString());
  const redeemed=await recover(post('/api/customer/recover',{token}));equal(redeemed.status,200);const recoveryBody=await redeemed.json();equal(recoveryBody.references.map(x=>x.bookingReference),['BW-001']);equal(recoveryBody.order.orderId,alice.id);
  const recoveredCookie=redeemed.headers.getSetCookie()[0].split(';')[0];equal(sessions.decodeCustomerSession(decodeURIComponent(recoveredCookie.split('=').slice(1).join('='))).verifiedContact,true);
  equal((await recover(post('/api/customer/recover',{token}))).status,400);
  // A recovered account still cannot use guessed contact to open another capability.
  equal((await access(post('/api/customer/access',{orderId:bob.id,contact:alice.data.email},recoveredCookie))).status,401);
  const other=await access(post('/api/customer/access',{orderId:bob.id,contact:bob.data.email},recoveredCookie));equal(other.status,200);
  const otherCookie=other.headers.getSetCookie()[0].split(';')[0];equal(sessions.decodeCustomerSession(decodeURIComponent(otherCookie.split('=').slice(1).join('='))).verifiedContact,false);
  equal((await reissue(post('/api/customer/delivery-code',{},otherCookie))).status,403);

  // Creating a booking with a claimed email proves possession of that new
  // booking only, not control of the mailbox or any other matching booking.
  const {POST:submit}=await load('src/app/api/submit/route.ts');
  const createdWithClaimedEmail=await submit(post('/api/submit',{
    submissionType:'pickup-booking',idempotencyKey:'synthetic-claimed-email-0001',
    name:'Synthetic Claimant',email:bob.data.email,phone:'0200000004',company:'Synthetic Account',
    pickupAddress:'Synthetic reception, Osu, Accra',pickupDate:new Date(Date.now()+86400000).toISOString().slice(0,10),pickupWindow:'8:00–10:00',plan:'Weekly',businessType:'Office or small team',laundryRhythm:'About once a week',locationCount:'1 location',servicePriority:'Standard scheduled service',paymentPreference:'Invoice me',alertPreference:'Call me',addons:[]
  }));
  equal(createdWithClaimedEmail.status,200);
  const claimedCookie=createdWithClaimedEmail.headers.getSetCookie()[0].split(';')[0];
  const claimedSession=sessions.decodeCustomerSession(decodeURIComponent(claimedCookie.split('=').slice(1).join('=')));
  equal(claimedSession.verifiedContact,false,'Claiming a booking email must not verify mailbox possession');
  equal(/^BW-R[A-F0-9]{16}$/.test(claimedSession.orderId),true,'Actual new submission uses the private marker');
  equal((await track(get(`/api/track?trackingToken=${claimedSession.orderId}`))).status,200);
  const ownCapability=await access(post('/api/customer/access',{orderId:claimedSession.orderId,contact:bob.data.email}));
  equal(ownCapability.status,200);
  const ownCapabilityBody=await ownCapability.json();
  equal(ownCapabilityBody.order.orderId,claimedSession.orderId);
  equal(/^BW-\d+$/.test(ownCapabilityBody.order.bookingReference),true);
  equal((await reissue(post('/api/customer/delivery-code',{},claimedCookie))).status,403);
  const claimPivot=await access(post('/api/customer/access',{orderId:bob.id,contact:bob.data.email},claimedCookie));
  equal(claimPivot.status,200);
  const pivotCookie=claimPivot.headers.getSetCookie()[0].split(';')[0];
  equal(sessions.decodeCustomerSession(decodeURIComponent(pivotCookie.split('=').slice(1).join('='))).verifiedContact,false);
  equal((await reissue(post('/api/customer/delivery-code',{},pivotCookie))).status,403);

  // Historical signed creator cookies had true without mailbox proof. Demote
  // them while preserving own-order access, and never transfer that old flag.
  const signedSession=fields=>{
    const value=Buffer.from(JSON.stringify(fields)).toString('base64url');
    return value+'.'+createHmac('sha256',process.env.BUBBLEWASH_SESSION_SECRET).update(value).digest('base64url');
  };
  const legacyFields=JSON.parse(Buffer.from(sessions.encodeCustomerSession(bob.id,bob.data.email,true).split('.')[0],'base64url').toString());
  delete legacyFields.contactProof;
  for(const proof of [undefined,'mailbox-v0',true,'']){
    const encoded=signedSession({...legacyFields,...(proof===undefined?{}:{contactProof:proof})});
    const oldCookie=`${sessions.customerSessionCookieName}=${encoded}`;
    equal(sessions.decodeCustomerSession(encoded).verifiedContact,false);
    equal((await order(get('/api/customer/order',oldCookie))).status,200);
    equal((await reissue(post('/api/customer/delivery-code',{},oldCookie))).status,403);
    const inherited=await access(post('/api/customer/access',{orderId:bob.id,contact:bob.data.email},oldCookie));
    equal(inherited.status,200);
    const inheritedCookie=inherited.headers.getSetCookie()[0].split(';')[0];
    equal(sessions.decodeCustomerSession(decodeURIComponent(inheritedCookie.split('=').slice(1).join('='))).verifiedContact,false);
  }
  equal(sessions.decodeCustomerSession(signedSession({...legacyFields,contactProof:'mailbox-v1',expiresAt:1})),null);
  equal(sessions.decodeCustomerSession(decodeURIComponent(recoveredCookie.split('=').slice(1).join('='))).contactProof,'mailbox-v1');

  // Display references cannot become payment authorization or transaction IDs.
  process.env.NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED='true';
  const {POST:initializePayment}=await load('src/app/api/payments/initialize/route.ts');
  const {GET:verifyPayment}=await load('src/app/api/payments/verify/route.ts');
  const {POST:paymentWebhook}=await load('src/app/api/payments/webhook/route.ts');
  equal((await initializePayment(post('/api/payments/initialize',{orderId:'BW-001'},rawCookie))).status,400);
  equal((await initializePayment(post('/api/payments/initialize',{orderId:bob.id},rawCookie))).status,401);
  equal((await verifyPayment(get('/api/payments/verify?reference=BW-001'))).status,404);
  process.env.PAYSTACK_SECRET_KEY='mock_signature_only_not_a_real_secret';
  equal((await paymentWebhook(post('/api/payments/webhook',{event:'charge.success',data:{reference:'BW-001'}}))).status,401);
  db.prepare('INSERT INTO order_invoices (order_id,invoice_id,account_key,period,lines,total_minor,created_at) VALUES (?,?,?,?,?,?,?)').run(alice.id,'INVOICE-SYNTHETIC','account-synthetic','2026-10','[]',10000,new Date().toISOString());
  const initializeCalls=[];
  globalThis.fetch=async(url,init)=>{
    initializeCalls.push({url,body:JSON.parse(init.body)});
    return Response.json({status:true,data:{reference:JSON.parse(init.body).reference,authorization_url:'https://checkout.paystack.com/mock-only'}});
  };
  const paidInit=await initializePayment(post('/api/payments/initialize',{orderId:alice.id,bookingReference:'BW-999'},rawCookie));
  equal(paidInit.status,200);equal(initializeCalls.length,1);
  const provider=initializeCalls[0].body;
  equal(provider.metadata.order_id,alice.id);
  equal(provider.metadata.custom_fields.find(field=>field.variable_name==='booking_reference').value,'BW-001');
  equal(/^BW-PAY-[A-Z0-9]{18}$/.test(provider.reference),true);
  equal(provider.amount,10000);equal(provider.currency,'GHS');
  equal(new URL(provider.callback_url).searchParams.get('payment_reference'),provider.reference);
  equal(store.findCheckoutByPaymentReference(provider.reference).data.orderId,alice.id);
  globalThis.fetch=async()=>{throw new Error('External network forbidden in independent fixture')};
  delete process.env.PAYSTACK_SECRET_KEY;
  process.env.NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED='false';

  // Real staff cookie resolution in a synthetic Next request context. No server,
  // browser, provider or production credentials are involved.
  const auth=await load('src/lib/auth.ts');
  const {GET:label}=await load('src/app/api/orders/label/route.ts');
  const {workAsyncStorage}=await load('node_modules/next/dist/server/app-render/work-async-storage.external.js');
  const {workUnitAsyncStorage}=await load('node_modules/next/dist/server/app-render/work-unit-async-storage.external.js');
  const withStaff=(role,fn)=>{
    const user=auth.currentStaffUsers().find(value=>value.role===role);
    const value=user?auth.encodeSession(user):'';
    const requestStore={type:'request',phase:'render',cookies:{get:name=>name===auth.sessionCookieName&&value?{name,value}:undefined}};
    return workAsyncStorage.run({route:'/api/orders/label'},()=>workUnitAsyncStorage.run(requestStore,fn));
  };
  const labelRequest=()=>get(`/api/orders/label?orderId=${alice.id}`);
  equal((await withStaff(null,()=>label(labelRequest()))).status,403);
  equal((await withStaff('support',()=>label(labelRequest()))).status,403);
  equal((await withStaff('vendor',()=>label(labelRequest()))).status,404);
  equal((await withStaff('driver',()=>label(labelRequest()))).status,404);
  const adminLabel=await withStaff('admin',()=>label(labelRequest()));equal(adminLabel.status,200);
  const svg=await adminLabel.text();equal(svg.includes('>BW-001</text>'),true);equal(svg.includes(alice.id),false);
  equal(adminLabel.headers.get('content-disposition'),'inline; filename="BW-001-bag.svg"');
  const custody=await load('src/lib/chain-of-custody.ts');
  const bag=custody.createBagLabelToken(alice.id);equal(custody.verifyBagLabelToken(bag).orderId,alice.id);
  equal(custody.verifyBagLabelToken(bag).bagTag,`${alice.id}-BAG`);equal(custody.verifyBagLabelToken(bag+'tampered'),null);
  store.appendSubmissionRecord({id:'EV-SYNTHETIC-ASSIGNMENT',createdAt:new Date().toISOString(),data:{submissionType:'admin-operation',orderId:alice.id,vendorId:'vendor-synthetic',driverId:'driver-synthetic',vendor:'Synthetic Vendor',driver:'Synthetic Driver'}});
  equal((await withStaff('vendor',()=>label(labelRequest()))).status,200);
  equal((await withStaff('driver',()=>label(labelRequest()))).status,200);

  // The ordinary visible labels are separate from transport identifiers. These
  // structural checks complement the actual API/label checks, not browser QA.
  const source=relative=>readFileSync(join(root,relative),'utf8');
  for(const [file,visible] of [
    ['src/components/BookingExperience.tsx','bookingLabel(confirmation)'],
    ['src/components/TrackingLookup.tsx','bookingLabel(result)'],
    ['src/components/CustomerOrderManager.tsx','bookingLabel(order)']
  ]) equal(source(file).includes(visible),true);
  equal(source('src/components/BookingExperience.tsx').includes('/track#tracking='),true);
  equal(source('src/lib/notifications.ts').includes('/track#tracking='),true);
  equal(source('src/components/TrackingLookup.tsx').includes('window.history.replaceState'),true);
  for(const [file,pattern] of [
    ['src/components/BookingExperience.tsx',/>[^<]*\{confirmation\.id\}/],
    ['src/components/TrackingLookup.tsx',/<dd>\{result\.id\}/],
    ['src/components/CustomerOrderManager.tsx',/>\{(?:order|ref)\.orderId\}/]
  ]) equal(pattern.test(source(file)),false,'No internal ID rendered as ordinary visible label');

  // Distinct events with the same visible booking label must never collapse
  // into one outbox identity. Retrying one event still uses its original key.
  const notifications=await load('src/lib/notifications.ts');
  process.env.NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED='true';
  process.env.BUBBLEWASH_OPERATIONS_EMAIL='operations@example.invalid';
  for(const id of ['EV-IDEMPOTENCY-A','EV-IDEMPOTENCY-B']) notifications.queueSubmissionNotifications({id,createdAt:new Date().toISOString(),data:{submissionType:'support-ticket-action',bookingReference:'BW-001'}});
  notifications.queueSubmissionNotifications({id:'EV-IDEMPOTENCY-A',createdAt:new Date().toISOString(),data:{submissionType:'support-ticket-action',bookingReference:'BW-999'}});
  const dedupes=db.prepare("SELECT dedupe_key FROM notification_outbox WHERE dedupe_key LIKE 'EV-IDEMPOTENCY-%' ORDER BY dedupe_key").all().map(row=>row.dedupe_key);
  equal(dedupes,['EV-IDEMPOTENCY-A:operations:email','EV-IDEMPOTENCY-A:operations:whatsapp','EV-IDEMPOTENCY-B:operations:email','EV-IDEMPOTENCY-B:operations:whatsapp']);
  notifications.queueSubmissionNotifications(store.findSubmissionRecordById('EV-SYNTHETIC-ASSIGNMENT'));
  const eventMessage=store.readNotification(db.prepare("SELECT id FROM notification_outbox WHERE dedupe_key=?").get('EV-SYNTHETIC-ASSIGNMENT:customer:email').id);
  equal(eventMessage.dedupeKey,'EV-SYNTHETIC-ASSIGNMENT:customer:email');
  equal(eventMessage.payload.subject.includes('BW-001'),true);
  equal(eventMessage.payload.text.includes('BW-001'),true);
  equal(eventMessage.payload.subject.includes(alice.id),false);
  equal(eventMessage.payload.text.includes(alice.id),false);
  const eventOperations=store.readNotification(db.prepare("SELECT id FROM notification_outbox WHERE dedupe_key=?").get('EV-SYNTHETIC-ASSIGNMENT:operations:email').id);
  equal(eventOperations.dedupeKey,'EV-SYNTHETIC-ASSIGNMENT:operations:email');
  equal(eventOperations.payload.subject.includes('BW-001'),true);
  equal(eventOperations.payload.text.includes('BW-001'),true);
  equal(eventOperations.payload.subject.includes(alice.id),false);
  notifications.queueSubmissionNotifications({id:'ONBOARD-SYNTHETIC',createdAt:new Date().toISOString(),data:{submissionType:'client-onboarding',name:'Synthetic Account',email:'new-account@example.invalid',phone:'0200000003',alertPreference:'Email only'}});
  const onboardRows=db.prepare("SELECT payload FROM notification_outbox WHERE dedupe_key LIKE 'ONBOARD-SYNTHETIC:%'").all();
  equal(onboardRows.length,3);
  for(const row of onboardRows){
    const message=JSON.parse(row.payload);const visible=message.subject+' '+message.text;
    equal(visible.includes('Legacy test booking'),false);
    equal(visible.includes('/track'),false);
    equal(visible.includes('ONBOARD-SYNTHETIC'),false);
  }
  // Only the synthetic rows are removed; this database is an isolated fixture.
  db.prepare('DELETE FROM notification_outbox').run();
  process.env.RESEND_API_KEY='mock_not_a_real_secret';
  process.env.BUBBLEWASH_EMAIL_FROM='mock@example.invalid';
  const sent=[];
  globalThis.fetch=async(url,init)=>{sent.push({url,init});return Response.json({id:'mock-accepted-not-delivered'});};
  for(const id of ['NQ-IDEMPOTENCY-A','NQ-IDEMPOTENCY-B']) store.enqueueNotification({id,dedupeKey:id,channel:'email',target:'customer',payload:{toEmail:'customer@example.invalid',subject:'Same display BW-001',text:'Same message',purpose:'privacy'}});
  await notifications.processNotificationOutbox(2);equal(sent.length,2);
  for(const id of ['NQ-IDEMPOTENCY-A','NQ-IDEMPOTENCY-B']){
    const stored=store.readNotification(id);
    equal(stored.providerIdempotencyKey,`bubblewash/${createHash('sha256').update(`${id}:${stored.providerRequest}`).digest('hex')}`);
  }
  equal(new Set(sent.map(value=>value.init.headers['Idempotency-Key'])).size,2);
  console.log(JSON.stringify({ok:true,checks,scope:'actual access/recovery/QR routes; display links; stable outbox IDs; synthetic fixtures only'}));
} finally {process.chdir(root);db.close();rmSync(dir,{recursive:true,force:true});}
