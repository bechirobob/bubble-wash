import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPasswordHash } from '../src/lib/passwords.ts';
const sourceRoot = process.cwd();
const directory = mkdtempSync(join(tmpdir(), 'bubblewash-failure-matrix-'));
const origin = 'http://127.0.0.1:3197';
for (const key of Object.keys(process.env)) if (/^(BUBBLEWASH_|NEXT_PUBLIC_BUBBLEWASH_|RESEND_|WHATSAPP_|PAYSTACK_)/.test(key)) delete process.env[key];
Object.assign(process.env, { NODE_ENV: 'production', BUBBLEWASH_DATABASE_PATH: join(directory, 'workflow.sqlite'), BUBBLEWASH_SESSION_SECRET: 'isolated-http-regression-session-secret-32-plus', BUBBLEWASH_STAFF_AUTH_DISABLED: 'false', BUBBLEWASH_DISABLE_DEMO_LOGIN: 'true', BUBBLEWASH_ADMIN_MFA_REQUIRED: 'false', BUBBLEWASH_VENDOR_ENTITY_ID: 'vendor-http', BUBBLEWASH_DRIVER_ENTITY_ID: 'driver-http', BUBBLEWASH_PUBLIC_URL: origin, NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED: 'false', NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED: 'false', RESEND_API_KEY: '', PAYSTACK_SECRET_KEY: '' });
for (const role of ['admin', 'vendor', 'driver', 'support']) { process.env[`BUBBLEWASH_${role.toUpperCase()}_EMAIL`] = `${role}@example.invalid`; process.env[`BUBBLEWASH_${role.toUpperCase()}_PASSWORD_HASH`] = createPasswordHash(`isolated-${role}-password-123`); }
// Isolate legacy cwd/data imports in both fixture process and Next server. No .env files are copied.
const runtimeRoot=join(directory,'runtime'); mkdirSync(runtimeRoot);
for(const name of ['.next','node_modules','public','src'])symlinkSync(join(sourceRoot,name),join(runtimeRoot,name),'dir');
for(const name of ['next.config.mjs','package.json'])copyFileSync(join(sourceRoot,name),join(runtimeRoot,name));
const denyNetwork=join(directory,'deny-network.mjs'); writeFileSync(denyNetwork, "globalThis.fetch=async()=>{throw new Error('External fetch forbidden in synthetic HTTP server')};\n");
process.chdir(directory);
const { inviteStaffAccount, activateStaffAccount } = await import('../src/lib/staff-accounts.ts');
for (const role of ['vendor', 'driver', 'support']) {
  const token = inviteStaffAccount({ email: `${role}@example.invalid`, name: `Synthetic ${role}`, role, entityId: process.env[`BUBBLEWASH_${role.toUpperCase()}_ENTITY_ID`] || '' }, 'fixture');
  assert.equal(activateStaffAccount(token, `isolated-${role}-password-123`), true);
}
const availability = await import('../src/lib/availability-store.ts');
availability.upsertVendorAvailability({ vendorId: 'vendor-http', vendorName: 'HTTP Laundry', serviceZones: ['Osu'], serviceTypes: ['Wash + fold'], capacityRemaining: 3, availabilityStatus: 'available', updatedBy: 'fixture' });
availability.upsertDriverAvailability({ driverId: 'driver-http', driverName: 'HTTP Rider', serviceZones: ['Osu'], capacityRemaining: 3, availabilityStatus: 'active', updatedBy: 'fixture' });
const server = spawn(process.execPath, ['--import',denyNetwork,join(sourceRoot,'node_modules/next/dist/bin/next'), 'start', runtimeRoot, '-H', '127.0.0.1', '-p', '3197'], { cwd:runtimeRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; server.stdout.on('data', (d) => output += d); server.stderr.on('data', (d) => output += d);
// Emulate the production HTTPS reverse proxy while transport stays on loopback.
let checks = 0; const cookies = {};
async function post(path, body, role, expected = 200) { const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { origin: 'https://127.0.0.1:3197', 'content-type': 'application/json', ...(cookies[role] ? { cookie: cookies[role] } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }); const data = await response.json(); assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`); checks++; return { data, response }; }
const { getDatabase } = await import('../src/lib/data-store.ts');
const db = getDatabase();
const { buildOrderSummaries } = await import('../src/lib/submissions.ts');
const { readSubmissionRecordsForOrder } = await import('../src/lib/data-store.ts');
const snapshot = id => ({ records: readSubmissionRecordsForOrder(id).length,
  stage: buildOrderSummaries(readSubmissionRecordsForOrder(id))[0].workflowStage.key,
  vendors: availability.listVendorAvailability().map(v => [v.vendorId,v.capacityRemaining]),
  drivers: availability.listDriverAvailability().map(v => [v.driverId,v.capacityRemaining]) });
const date = new Date(Date.now() + 2 * 86400000).toISOString().slice(0,10);
const later = new Date(Date.now() + 3 * 86400000).toISOString().slice(0,10);
let serial = 0;
async function book() {
  const {data,response} = await post('/api/submit', { submissionType:'pickup-booking',idempotencyKey:randomUUID(),name:'Synthetic matrix customer',email:`matrix${++serial}@example.invalid`,phone:'0200000000',company:'Synthetic matrix',pickupAddress:'Synthetic reception, Osu, Accra',pickupDate:date,pickupWindow:'8:00–10:00',plan:'Weekly',businessType:'Office or small team',laundryRhythm:'About once a week',locationCount:'1 location',servicePriority:'Standard scheduled service',paymentPreference:'Invoice me',alertPreference:'Call me',addons:[] });
  cookies.customer=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');return data;
}
const advance=(id,key,fields={},role='admin',expected=200)=>post('/api/orders/advance',{orderId:id,actionKey:key,...fields},role,expected);
const request=async(action,fields={})=>(await post('/api/customer/request',{action,note:'Synthetic review only',...fields},'customer')).data.ticketId;
const decide=(ticketId,decision='approve',role='support',expected=200)=>post('/api/customer/decision',{ticketId,decision,note:'Synthetic explicit decision'},role,expected);
async function rejected(id,key,fields,role,status=400) {
  const before=snapshot(id);await advance(id,key,fields,role,status);assert.deepEqual(snapshot(id),before,'rejected workflow action must not mutate order or capacity');checks++;
}
try {
  for(let i=0;i<60;i++){try{if((await fetch(`${origin}/api/health`)).ok)break;}catch{}if(server.exitCode!==null)throw new Error(output);await new Promise(r=>setTimeout(r,250));}
  for(const role of ['admin','vendor','driver','support']){const {response}=await post('/api/login',{email:`${role}@example.invalid`,password:`isolated-${role}-password-123`});cookies[role]=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');}
  const booking=await book();const id=booking.id;
  await post('/api/customer/request',{action:'cancel',note:'Synthetic'},undefined,401);
  await post('/api/customer/request',{action:'reschedule',note:'Synthetic',requestedDate:'invalid',requestedWindow:'8:00–10:00'},'customer',400);
  // Model a committed response lost to the caller: discard first receipt, then retry
  // the identical logical request key. The server must not create a second case.
  const retryPayload={action:'care',note:'Synthetic response-loss retry',idempotencyKey:randomUUID()};
  await post('/api/customer/request',retryPayload,'customer');
  await post('/api/customer/request',retryPayload,'customer');
  const retries=readSubmissionRecordsForOrder(id).filter(r=>r.data.customerAction==='care' && r.data.message===retryPayload.note);
  const reschedule=await request('reschedule',{requestedDate:later,requestedWindow:'8:00–10:00'});
  for(const role of ['vendor','driver'])await decide(reschedule,'approve',role,403);
  const before=snapshot(id);await decide(reschedule);assert.equal(snapshot(id).stage,before.stage);
  assert.ok(readSubmissionRecordsForOrder(id).some(r=>r.data.confirmedPickupDate===later));checks+=2;
  await decide(reschedule,'approve','admin',409);
  await advance(id,'admin-schedule-pickup',{confirmedPickupDate:later,confirmedPickupWindow:'8:00–10:00',operatorNote:'Synthetic confirmed slot'});
  await advance(id,'admin-assign-vendor');
  const cancel=await request('cancel');const reserved=snapshot(id);await decide(cancel);
  assert.equal(snapshot(id).stage,'cancelled');assert.equal(availability.listVendorAvailability()[0].capacityRemaining,reserved.vendors[0][1]+1);assert.equal(availability.listDriverAvailability()[0].capacityRemaining,reserved.drivers[0][1]+1);checks+=3;
  const cancelled=snapshot(id);await decide(cancel,'approve','admin',409);assert.deepEqual(snapshot(id),cancelled);checks++;

  const second=await book();const order=second.id;
  await advance(order,'admin-schedule-pickup',{confirmedPickupDate:date,confirmedPickupWindow:'8:00–10:00',operatorNote:'Synthetic confirmed slot'});
  await advance(order,'admin-assign-vendor');
  // Two genuine simultaneous requests must produce one transition, not two records.
  const count=readSubmissionRecordsForOrder(order).length;
  const race=await Promise.all([1,2].map(()=>fetch(`${origin}/api/orders/advance`,{method:'POST',headers:{origin:'https://127.0.0.1:3197','content-type':'application/json',cookie:cookies.vendor},body:JSON.stringify({orderId:order,actionKey:'vendor-accept-job'})})));
  assert.equal(race.filter(r=>r.status===200).length,1);assert.ok(race.some(r=>[400,409].includes(r.status)));assert.equal(readSubmissionRecordsForOrder(order).length,count+1);checks+=3;
  await advance(order,'driver-start-route',{},'driver');
  await rejected(order,'driver-mark-picked-up',{pickupBagCount:'0',operatorNote:'Synthetic'},'driver');
  await advance(order,'driver-mark-picked-up',{pickupBagCount:'1',operatorNote:'Synthetic sealed bag'},'driver');
  const lateCancel=await request('cancel');const lateReschedule=await request('reschedule',{requestedDate:later,requestedWindow:'8:00–10:00'});
  for(const ticket of [lateCancel,lateReschedule]){const prior=snapshot(order);await decide(ticket,'approve','support',409);assert.deepEqual(snapshot(order),prior);await decide(ticket,'decline');checks++;}
  await rejected(order,'driver-drop-at-vendor',{handoffBagCount:'1',operatorNote:'Synthetic missing recipient'},'driver');
  await advance(order,'driver-drop-at-vendor',{vendorRecipient:'Synthetic receiver',handoffBagCount:'1',operatorNote:'Synthetic handoff'},'driver');
  const intake={bagTag:'SYNTHETIC-MATRIX',intakeBagCount:'1',intakeCondition:'Matched',receivedWeightKg:'20',operatorNote:'Synthetic verified weight'};
  for(const fields of [{...intake,intakeBagCount:'1.5'},{...intake,receivedWeightKg:'0'},{...intake,bagTag:''}])await rejected(order,'vendor-log-intake',fields,'vendor');
  await advance(order,'vendor-log-intake',intake,'vendor');await advance(order,'vendor-start-washing',{},'vendor');
  await rejected(order,'vendor-mark-ready',{readyBagCount:'1',qualityCheck:'',operatorNote:'Synthetic'},'vendor');
  await advance(order,'vendor-mark-ready',{readyBagCount:'1',qualityCheck:'Count and finishing checked',operatorNote:'Synthetic sealed return'},'vendor');
  await advance(order,'driver-out-for-delivery',{},'driver');
  const delivered={recipientName:'Synthetic customer',bagCount:'1',deliveryCode:second.deliveryCode,operatorNote:'Synthetic handoff'};
  await rejected(order,'driver-mark-delivered',{...delivered,deliveryCode:'bad'},'driver');
  const wrong=second.deliveryCode==='000000'?'999999':'000000';
  await rejected(order,'driver-mark-delivered',{...delivered,deliveryCode:wrong},'driver',409);
  await advance(order,'driver-mark-delivered',delivered,'driver');
  // Quality remedy is a manual dispute decision, not a nonexistent re-clean automation.
  const quality=await request('quality');const refund=await request('refund');
  assert.ok(db.prepare('SELECT 1 FROM order_holds WHERE order_id=?').get(order));checks++;
  await post('/api/orders/invoice',{orderId:order,kind:'payment',amount:'1700',reference:'SYNTHETIC-MATRIX-SETTLEMENT',note:'Synthetic ledger receipt only'},'admin');
  await rejected(order,'admin-close-order',{},'admin',409);
  await decide(refund,'approve','support',409);
  await decide(quality);assert.ok(db.prepare('SELECT 1 FROM order_holds WHERE order_id=?').get(order));checks++;
  await post('/api/orders/invoice',{orderId:order,kind:'refund',amount:'10',reference:'SYNTHETIC-MATRIX-REFUND',note:'Synthetic ledger adjustment only'},'admin');
  await decide(refund);assert.equal(db.prepare('SELECT 1 FROM order_holds WHERE order_id=?').get(order),undefined);checks++;
  await rejected(order,'admin-close-order',{},'admin',400);
  await post('/api/orders/invoice',{orderId:order,kind:'credit',amount:'10',reference:'SYNTHETIC-MATRIX-CREDIT',note:'Synthetic approved adjustment only'},'admin');
  await advance(order,'admin-close-order');assert.equal(snapshot(order).stage,'closed');checks++;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n,0);checks++;
  console.log(JSON.stringify({lifecycleChecks:checks,responseLossTicketCount:retries.length}));
  assert.equal(retries.length,1,'same logical customer request must survive response-loss retry without duplicate tickets');checks++;
  console.log(JSON.stringify({ok:true,checks,scope:'synthetic HTTP lifecycle failures, customer decisions, evidence validation, concurrent claim, dispute holds; no provider calls'}));
} catch(error){console.error(output.slice(-5000));throw error;}
finally{if(server.exitCode===null){const ended=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await ended;}process.chdir(sourceRoot);rmSync(directory,{recursive:true,force:true});}
