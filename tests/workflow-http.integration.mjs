import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPasswordHash } from '../src/lib/passwords.ts';
const uat = process.argv.includes('--uat');
const sourceRoot = process.cwd();
const directory = mkdtempSync(join(tmpdir(), 'bubblewash-http-'));
const origin = 'http://127.0.0.1:3099';
for (const key of Object.keys(process.env)) if (/^(BUBBLEWASH_|NEXT_PUBLIC_BUBBLEWASH_|RESEND_|WHATSAPP_|PAYSTACK_)/.test(key)) delete process.env[key];
Object.assign(process.env, { NODE_ENV: 'production', BUBBLEWASH_DATABASE_PATH: join(directory, 'workflow.sqlite'), BUBBLEWASH_SESSION_SECRET: 'isolated-http-regression-session-secret-32-plus', BUBBLEWASH_STAFF_AUTH_DISABLED: 'false', BUBBLEWASH_DISABLE_DEMO_LOGIN: 'true', BUBBLEWASH_ADMIN_MFA_REQUIRED: 'false', BUBBLEWASH_VENDOR_ENTITY_ID: 'vendor-http', BUBBLEWASH_DRIVER_ENTITY_ID: 'driver-http', BUBBLEWASH_PUBLIC_URL: origin, NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED: 'false', NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED: 'false', RESEND_API_KEY: '', PAYSTACK_SECRET_KEY: '' });
if (uat) Object.assign(process.env, { BUBBLEWASH_UAT_ENABLED:'true', BUBBLEWASH_UAT_ISOLATION_CONFIRMED:'true', BUBBLEWASH_UAT_DATA_ROOT:directory, BUBBLEWASH_RESEARCH_EMAIL_ENABLED:'false', BUBBLEWASH_BOOKINGS_DISABLED:'false', BUBBLEWASH_ADMIN_MFA_REQUIRED:'true' });
if (!uat) for (const role of ['admin', 'vendor', 'driver', 'support']) { process.env[`BUBBLEWASH_${role.toUpperCase()}_EMAIL`] = `${role}@example.invalid`; process.env[`BUBBLEWASH_${role.toUpperCase()}_PASSWORD_HASH`] = createPasswordHash(`isolated-${role}-password-123`); }
// Isolate legacy cwd/data imports in both fixture process and Next server. No .env files are copied.
const runtimeRoot=join(directory,'runtime'); mkdirSync(runtimeRoot);
for(const name of ['.next','node_modules','public','src'])symlinkSync(join(sourceRoot,name),join(runtimeRoot,name),'dir');
for(const name of ['next.config.mjs','package.json'])copyFileSync(join(sourceRoot,name),join(runtimeRoot,name));
const denyNetwork=join(directory,'deny-network.mjs'); writeFileSync(denyNetwork, "globalThis.fetch=async()=>{throw new Error('External fetch forbidden in synthetic HTTP server')};\n");
process.chdir(directory);
const { inviteStaffAccount, activateStaffAccount } = await import('../src/lib/staff-accounts.ts');
if (!uat) for (const role of ['vendor', 'driver', 'support']) {
  const token = inviteStaffAccount({ email: `${role}@example.invalid`, name: `Synthetic ${role}`, role, entityId: process.env[`BUBBLEWASH_${role.toUpperCase()}_ENTITY_ID`] || '' }, 'fixture');
  assert.equal(activateStaffAccount(token, `isolated-${role}-password-123`), true);
}
const availability = await import('../src/lib/availability-store.ts');
availability.upsertVendorAvailability({ vendorId: 'vendor-http', vendorName: 'HTTP Laundry', serviceZones: ['Osu'], serviceTypes: ['Wash + fold'], capacityRemaining: 3, availabilityStatus: 'available', updatedBy: 'fixture' });
availability.upsertDriverAvailability({ driverId: 'driver-http', driverName: 'HTTP Rider', serviceZones: ['Osu'], capacityRemaining: 3, availabilityStatus: 'active', updatedBy: 'fixture' });
if (uat) {
  const { issueUatCohort } = await import('../src/lib/uat-accounts.ts');
  issueUatCohort(['admin','vendor','driver','support'].map(role => ({username:`review-${role}`,name:`Review ${role}`,role,password:`isolated-${role}-password-123`,entityId:['vendor','driver'].includes(role) ? `${role}-http` : undefined})), 'synthetic-fixture');
}
const server = spawn(process.execPath, ['--import',denyNetwork,join(sourceRoot,'node_modules/next/dist/bin/next'), 'start', runtimeRoot, '-H', '127.0.0.1', '-p', '3099'], { cwd:runtimeRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; server.stdout.on('data', (d) => output += d); server.stderr.on('data', (d) => output += d);
// Emulate the production HTTPS reverse proxy while transport stays on loopback.
let checks = 0; const cookies = {};
async function post(path, body, role, expected = 200) { const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { origin: 'https://127.0.0.1:3099', 'content-type': 'application/json', ...(cookies[role] ? { cookie: cookies[role] } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }); const data = await response.json(); assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`); checks++; return { data, response }; }
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch {} if (server.exitCode !== null) throw new Error(output); await new Promise((r) => setTimeout(r, 250)); }
  for (const role of ['admin', 'vendor', 'driver', 'support']) { const { response } = await post('/api/login', { ...(uat ? { username:`review-${role}` } : { email:`${role}@example.invalid` }), password: `isolated-${role}-password-123` }); cookies[role] = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '); }
  if (uat) {
    await post('/api/submit', {submissionType:'vendor-application',company:'Additional Test Laundry',name:'Test Vendor Contact',email:'vendor-contact@example.invalid',phone:'0200000000',area:'Osu',services:'Wash + fold',capacity:'0',availability:'inactive',message:'Synthetic onboarding acceptance test'},'admin');
    assert.ok(availability.listVendorAvailability().some(v=>v.vendorName==='Additional Test Laundry' && v.capacityRemaining===0)); checks++;
    await post('/api/submit', {submissionType:'driver-onboarding',name:'Additional Test Driver',email:'driver-contact@example.invalid',phone:'0200000000',area:'Osu',vehicle:'Motorbike',driverStatus:'training',routeCapacity:'0',message:'Synthetic driver onboarding acceptance test'},'admin');
    assert.ok(availability.listDriverAvailability().some(d=>d.driverName==='Additional Test Driver' && d.capacityRemaining===0)); checks++;
    const {currentStaffUsers} = await import('../src/lib/auth.ts');
    assert.equal(currentStaffUsers().length,4,'onboarding creates operational roster, not new permanent sign-in privileges'); checks++;
  }
  const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const bookingPayload = { submissionType: 'pickup-booking', idempotencyKey: randomUUID(), name: 'HTTP Customer', email: 'customer@example.invalid', phone: '0200000000', company: 'HTTP Account', pickupAddress: 'HTTP reception, Osu, Accra', pickupDate: date, pickupWindow: '8:00–10:00', plan: 'Weekly', businessType: 'Office or small team', laundryRhythm: 'About once a week', locationCount: '1 location', servicePriority: 'Standard scheduled service', paymentPreference: 'Invoice me', alertPreference: 'Call me', addons: [] };
  const { data: booking, response: bookingResponse } = await post('/api/submit', bookingPayload, uat ? 'admin' : undefined);
  cookies.customer = [bookingResponse.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '),...(uat?[cookies.admin]:[])].join('; ');
  const orderId = booking.id;
  assert.equal(booking.bookingReference, 'BW-001'); assert.notEqual(orderId, booking.bookingReference); checks += 2;
  const replay = (await post('/api/submit', bookingPayload, uat ? 'admin' : undefined)).data;
  assert.equal(replay.id, orderId); assert.equal(replay.bookingReference, 'BW-001'); assert.equal(replay.replayed, true); checks += 3;
  assert.equal((await fetch(`${origin}/api/track?trackingToken=BW-001`,{headers:uat?{cookie:cookies.admin}:{}})).status, 400); checks++;
  await post('/api/customer/access', { orderId: 'BW-001', contact: 'customer@example.invalid' }, uat?'admin':undefined, 400);
  async function action(role, actionKey, fields = {}, expected = 200) { return post('/api/orders/advance', { orderId, actionKey, ...fields }, role, expected); }
  await action('vendor', 'vendor-accept-job', {}, 404);
  await action('admin', 'admin-schedule-pickup', { confirmedPickupDate: date, confirmedPickupWindow: '8:00–10:00', operatorNote: 'Customer confirmed reception access.' });
  await action('admin', 'admin-assign-vendor');
  await action('vendor', 'vendor-accept-job');
  await action('driver', 'driver-start-route');
  // Actual authenticated browser route, including ahead-clock fixes and explicit resume.
  async function stopBrowser(body, expected=200, extraHeaders={}) {
    const response=await fetch(`${origin}/api/dispatch/location`,{method:'DELETE',headers:{origin:'https://127.0.0.1:3099','content-type':'application/json',cookie:cookies.driver,...extraHeaders},body:JSON.stringify(body)});
    const data=await response.json(); assert.equal(response.status,expected,JSON.stringify(data)); checks++; return data;
  }
  const start = async (id=orderId, role='driver', expected=200) => (await post('/api/dispatch/location',{action:'start',orderId:id},role,expected)).data.generation;
  await start('unassigned-order','driver',409);
  await start(orderId,'vendor',403);
  const generation=await start();
  assert.match(generation,/^[0-9a-f-]{36}$/); checks++;
  const firstPoint={orderId,generation,latitude:5.56,longitude:-0.18,accuracyMeters:10,capturedAt:new Date(Date.now()+20_000).toISOString()};
  await post('/api/dispatch/location',firstPoint,'driver');
  assert.equal((await stopBrowser({})).cleared,true); checks++;
  const latePoint={...firstPoint,capturedAt:new Date(Date.now()+21_000).toISOString()};
  await post('/api/dispatch/location',latePoint,'driver',409);
  await post('/api/dispatch/location',{...latePoint,generation:undefined},'driver',422);
  const resumed=await start();
  const resumedPoint={...firstPoint,generation:resumed,capturedAt:new Date().toISOString()};
  await post('/api/dispatch/location',resumedPoint,'driver');
  assert.equal((await stopBrowser({generation,orderId})).staleGeneration,true); checks++;
  assert.equal((await stopBrowser({generation:resumed,orderId:'another-order'})).staleGeneration,true); checks++;
  const location=await (await fetch(`${origin}/api/dispatch/location`,{headers:{cookie:cookies.driver}})).json();
  assert.equal(location.location.capturedAt,resumedPoint.capturedAt); checks++;
  await stopBrowser({generation:resumed,orderId},403,{origin:'https://attacker.example.invalid'});
  await stopBrowser({generation:resumed,orderId},401,{cookie:'',authorization:'Bearer synthetic-invalid-token'});
  assert.equal((await stopBrowser({generation:resumed,orderId})).cleared,true); checks++;
  await post('/api/dispatch/location',{...latePoint,generation:resumed},'driver',409);
  const final=await start();
  await post('/api/dispatch/location',{...latePoint,generation:final},'driver');
  // Legacy timestamp is informational: even an old clock cannot retain the ahead-clock marker.
  assert.equal((await stopBrowser({stoppedAt:'2000-01-01T00:00:00.000Z'})).cleared,true); checks++;
  await post('/api/dispatch/location',{...latePoint,generation:final},'driver',409);

  await action('driver', 'driver-mark-picked-up', { pickupBagCount: '1', operatorNote: 'Received one sealed bag.' });
  await action('driver', 'driver-drop-at-vendor', { vendorRecipient: 'Laundry receiver', handoffBagCount: '1', operatorNote: 'Received at vendor desk.' });
  await action('vendor', 'vendor-log-intake', { bagTag: `${orderId}-BAG`, intakeBagCount: '1', intakeCondition: 'Count and condition matched', receivedWeightKg: '20', operatorNote: 'Calibrated scale receipt checked.' });
  const customerOrder = await (await fetch(`${origin}/api/customer/order`, { headers: { cookie: cookies.customer } })).json(); assert.equal(customerOrder.order.invoice.totalMinor, 170000); checks++;
  assert.equal(customerOrder.order.bookingReference, 'BW-001'); assert.equal(customerOrder.order.vendorCode, 'HTT'); assert.equal(customerOrder.order.invoice.bookingReference, 'BW-001'); checks += 3;
  await action('vendor', 'vendor-start-washing');
  await action('vendor', 'vendor-mark-ready', { readyBagCount: '1', qualityCheck: 'Count and finishing checked', operatorNote: 'Sealed clean bag for return.' });
  await action('driver', 'driver-out-for-delivery');
  await action('driver', 'driver-mark-delivered', { recipientName: 'HTTP Customer', bagCount: '1', deliveryCode: booking.deliveryCode, operatorNote: 'Customer checked and received bag.' });
  await post('/api/orders/invoice', { orderId, kind: 'payment', amount: '1700', reference: 'HTTP-BANK-SETTLEMENT', note: 'Matched actual synthetic bank receipt.' }, 'admin');
  await action('admin', 'admin-close-order');
  const tracking = await (await fetch(`${origin}/api/track?id=${orderId}`,{headers:uat?{cookie:cookies.admin}:{}})).json(); assert.equal(tracking.tracking.status, 'Closed'); assert.equal(tracking.tracking.bookingReference, 'BW-001'); checks += 2;
  assert.equal(availability.listVendorAvailability()[0].capacityRemaining, 3); assert.equal(availability.listDriverAvailability()[0].capacityRemaining, 3); checks += 2;
  await action('driver', 'driver-mark-delivered', { recipientName: 'HTTP Customer', bagCount: '1', deliveryCode: booking.deliveryCode, operatorNote: 'Duplicate delivery attempt.' }, 400);
  console.log(JSON.stringify({ ok: true, checks, scope: 'real HTTP booking through synthetic settlement and closeout, four roles, private order, one-time handoff, capacity restored', uat, vendorAndDriverOnboarding: uat }));
} catch (error) { console.error(output.slice(-5000)); throw error; }
finally { if (server.exitCode === null) { const ended = new Promise((resolve) => server.once('exit', resolve)); server.kill('SIGTERM'); await ended; } process.chdir(sourceRoot); rmSync(directory, { recursive: true, force: true }); }
