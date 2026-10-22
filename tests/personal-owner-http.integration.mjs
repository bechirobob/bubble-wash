import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { totpCode } from '../src/lib/totp.ts';
import { randomUUID } from 'node:crypto';
import { createPasswordHash } from '../src/lib/passwords.ts';
const directory = mkdtempSync(join(tmpdir(), 'bubblewash-http-'));
const origin = 'http://127.0.0.1:3102';
Object.assign(process.env, { NODE_ENV: 'production', BUBBLEWASH_DATABASE_PATH: join(directory, 'workflow.sqlite'), BUBBLEWASH_SESSION_SECRET: 'isolated-http-regression-session-secret-32-plus', BUBBLEWASH_STAFF_AUTH_DISABLED: 'false', BUBBLEWASH_DISABLE_DEMO_LOGIN: 'true', BUBBLEWASH_ADMIN_MFA_REQUIRED: 'false', BUBBLEWASH_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 21).toString('base64'), BUBBLEWASH_VENDOR_ENTITY_ID: 'vendor-http', BUBBLEWASH_DRIVER_ENTITY_ID: 'driver-http', BUBBLEWASH_PUBLIC_URL: origin, NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED: 'false', NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED: 'false', RESEND_API_KEY: '', PAYSTACK_SECRET_KEY: '' });
for (const role of ['admin', 'vendor', 'driver', 'support']) { process.env[`BUBBLEWASH_${role.toUpperCase()}_EMAIL`] = `${role}@example.invalid`; process.env[`BUBBLEWASH_${role.toUpperCase()}_PASSWORD_HASH`] = createPasswordHash(`isolated-${role}-password-123`); }
const { inviteOwnerAccount, inviteStaffAccount, activateStaffAccount } = await import('../src/lib/staff-accounts.ts');
for (const role of ['vendor', 'driver', 'support']) {
  const token = inviteStaffAccount({ email: `${role}@example.invalid`, name: `Synthetic ${role}`, role, entityId: process.env[`BUBBLEWASH_${role.toUpperCase()}_ENTITY_ID`] || '' }, 'fixture');
  assert.equal(activateStaffAccount(token, `isolated-${role}-password-123`), true);
}
const ownerToken = inviteOwnerAccount({ email: 'owner@example.invalid', name: 'Personal Owner' }, 'fixture');
assert.equal(activateStaffAccount(ownerToken, 'isolated-owner-password-123'), true);
const availability = await import('../src/lib/availability-store.ts');
availability.upsertVendorAvailability({ vendorId: 'vendor-http', vendorName: 'HTTP Laundry', serviceZones: ['Osu'], serviceTypes: ['Wash + fold'], capacityRemaining: 3, availabilityStatus: 'available', updatedBy: 'fixture' });
availability.upsertDriverAvailability({ driverId: 'driver-http', driverName: 'HTTP Rider', serviceZones: ['Osu'], capacityRemaining: 3, availabilityStatus: 'active', updatedBy: 'fixture' });
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', '3102'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; server.stdout.on('data', (d) => output += d); server.stderr.on('data', (d) => output += d);
// Emulate the production HTTPS reverse proxy while transport stays on loopback.
let checks = 0; const cookies = {};
async function post(path, body, role, expected = 200) { const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { origin: 'https://127.0.0.1:3102', 'content-type': 'application/json', ...(cookies[role] ? { cookie: cookies[role] } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }); const data = await response.json(); assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`); checks++; return { data, response }; }
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch {} if (server.exitCode !== null) throw new Error(output); await new Promise((r) => setTimeout(r, 250)); }
  for (const role of ['admin', 'vendor', 'driver', 'support']) { const { response } = await post('/api/login', { email: `${role}@example.invalid`, password: `isolated-${role}-password-123` }); cookies[role] = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '); }
  const activationPage = await fetch(`${origin}/staff/activate`);
  assert.equal(activationPage.headers.get('referrer-policy'), 'no-referrer');
  assert.match(activationPage.headers.get('cache-control') || '', /no-store/); checks += 2;
  const ownerCredentials = { email: 'owner@example.invalid', password: 'isolated-owner-password-123' };
  const needsEnrollment = await post('/api/login', ownerCredentials, undefined, 403);
  assert.equal(needsEnrollment.data.mfaStep, 'enroll'); assert.equal(needsEnrollment.response.headers.get('set-cookie'), null);
  const setup = await post('/api/admin/mfa/enroll', { ...ownerCredentials, action: 'start' });
  const confirmation = await post('/api/admin/mfa/enroll', { ...ownerCredentials, action: 'confirm', code: totpCode(setup.data.enrollment.manualKey) });
  const needsCode = await post('/api/login', ownerCredentials, undefined, 401);
  assert.equal(needsCode.data.mfaStep, 'verify'); assert.equal(needsCode.response.headers.get('set-cookie'), null);
  const ownerLogin = await post('/api/login', { ...ownerCredentials, totp: confirmation.data.recoveryCodes[0] });
  cookies.owner = ownerLogin.response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const masterVendorPage = await fetch(`${origin}/vendors`, { headers: { cookie: cookies.admin }, redirect: 'manual' });
  if (masterVendorPage.status === 200) assert.match(await masterVendorPage.text(), /NEXT_REDIRECT|http-equiv="refresh"/);
  else assert.equal(masterVendorPage.status, 307);
  for (const path of ['/admin', '/vendors', '/drivers', '/support']) {
    const page = await fetch(`${origin}${path}`, { headers: { cookie: cookies.owner }, redirect: 'manual' });
    assert.equal(page.status, 200, path); checks++;
    const html = await page.text();
    assert.doesNotMatch(html, /NEXT_REDIRECT|http-equiv="refresh"/);
    assert.match(html, /Personal Owner/);
    if (path === '/drivers') assert.equal(html.includes('Share live location'), false);
  }
  await post('/api/dispatch/location', { orderId: 'any' }, 'owner', 403);
  const gpsDelete = await fetch(`${origin}/api/dispatch/location`, { method: 'DELETE', headers: { origin: 'https://127.0.0.1:3102', 'content-type': 'application/json', cookie: cookies.owner }, body: '{}' });
  assert.equal(gpsDelete.status, 403); checks++;
  await post('/api/staff/accounts', { email: 'forbidden@example.invalid', name: 'Forbidden', role: 'admin' }, 'vendor', 403);
  await post('/api/staff/accounts', { email: 'forbidden@example.invalid', name: 'Forbidden', role: 'admin' }, 'admin', 400);
  const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const { data: booking, response: bookingResponse } = await post('/api/submit', { submissionType: 'pickup-booking', idempotencyKey: randomUUID(), name: 'HTTP Customer', email: 'customer@example.invalid', phone: '0200000000', company: 'HTTP Account', pickupAddress: 'HTTP reception, Osu, Accra', pickupDate: date, pickupWindow: '8:00–10:00', plan: 'Weekly', businessType: 'Office or small team', laundryRhythm: 'About once a week', locationCount: '1 location', servicePriority: 'Standard scheduled service', paymentPreference: 'Invoice me', alertPreference: 'Call me', addons: [] });
  cookies.customer = bookingResponse.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const orderId = booking.id;
  async function action(role, actionKey, fields = {}, expected = 200) { return post('/api/orders/advance', { orderId, actionKey, ...fields }, role, expected); }
  await action('vendor', 'vendor-accept-job', {}, 404);
  await action('owner', 'admin-schedule-pickup', { confirmedPickupDate: date, confirmedPickupWindow: '8:00–10:00', operatorNote: 'Customer confirmed reception access.' });
  await action('owner', 'admin-assign-vendor');
  await action('admin', 'vendor-accept-job', { allStaffAccess: true, role: 'vendor' }, 400);
  await action('owner', 'vendor-accept-job');
  await action('owner', 'driver-start-route');
  await action('owner', 'driver-mark-picked-up', { pickupBagCount: '1', operatorNote: 'Received one sealed bag.' });
  await action('owner', 'driver-drop-at-vendor', { vendorRecipient: 'Laundry receiver', handoffBagCount: '1', operatorNote: 'Received at vendor desk.' });
  await action('owner', 'vendor-log-intake', { bagTag: `${orderId}-BAG`, intakeBagCount: '1', intakeCondition: 'Count and condition matched', receivedWeightKg: '20', operatorNote: 'Calibrated scale receipt checked.' });
  const customerOrder = await (await fetch(`${origin}/api/customer/order`, { headers: { cookie: cookies.customer } })).json(); assert.equal(customerOrder.order.invoice.totalMinor, 170000); checks++;
  await action('owner', 'vendor-start-washing');
  await action('owner', 'vendor-mark-ready', { readyBagCount: '1', qualityCheck: 'Count and finishing checked', operatorNote: 'Sealed clean bag for return.' });
  await action('owner', 'driver-out-for-delivery');
  await action('owner', 'driver-mark-delivered', { recipientName: 'HTTP Customer', bagCount: '1', deliveryCode: booking.deliveryCode, operatorNote: 'Customer checked and received bag.' });
  await post('/api/orders/invoice', { orderId, kind: 'payment', amount: '1700', reference: 'HTTP-BANK-SETTLEMENT', note: 'Matched actual synthetic bank receipt.' }, 'admin');
  await action('owner', 'admin-close-order');
  const tracking = await (await fetch(`${origin}/api/track?id=${orderId}`)).json(); assert.equal(tracking.tracking.status, 'Closed'); checks++;
  assert.equal(availability.listVendorAvailability()[0].capacityRemaining, 3); assert.equal(availability.listDriverAvailability()[0].capacityRemaining, 3); checks += 2;
  await action('owner', 'driver-mark-delivered', { recipientName: 'HTTP Customer', bagCount: '1', deliveryCode: booking.deliveryCode, operatorNote: 'Duplicate delivery attempt.' }, 400);
  const records = (await import('../src/lib/data-store.ts')).getDatabase().prepare("SELECT data FROM submissions WHERE source = 'bubblewash-workflow-automation'").all();
  assert.ok(records.length > 5);
  for (const row of records) { const event = JSON.parse(row.data); assert.equal(event.submittedByEmail, 'owner@example.invalid'); assert.equal(event.submittedByRole, 'admin'); assert.equal(event.name, 'Personal Owner'); }
  console.log(JSON.stringify({ ok: true, checks, scope: 'personal owner cross-workspace workflow, unchanged master privileges, denied GPS, verified actor identity and evidence gates' }));
} catch (error) { console.error(output.slice(-5000)); throw error; }
finally { if (server.exitCode === null) { const ended = new Promise((resolve) => server.once('exit', resolve)); server.kill('SIGTERM'); await ended; } rmSync(directory, { recursive: true, force: true }); }
