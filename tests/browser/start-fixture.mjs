import './block-egress.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPasswordHash } from '../../src/lib/passwords.ts';

// Refuse local Next.js env files, which could reintroduce live provider credentials.
for (const filename of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  if (existsSync(filename)) throw new Error(`Browser fixture refuses ${filename}; use a clean test checkout.`);
}

// No inherited application credentials, live database path or provider keys.
const platformEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
for (const key of Object.keys(process.env)) delete process.env[key];
const directory = mkdtempSync(join(tmpdir(), 'bubblewash-browser-'));
Object.assign(process.env, platformEnv, {
  NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
  BUBBLEWASH_DATABASE_PATH: join(directory, 'synthetic.sqlite'),
  BUBBLEWASH_SESSION_SECRET: 'synthetic-browser-session-secret-never-use-in-production',
  BUBBLEWASH_STAFF_AUTH_DISABLED: 'false', BUBBLEWASH_DISABLE_DEMO_LOGIN: 'true',
  BUBBLEWASH_ADMIN_MFA_REQUIRED: 'false', NEXT_PUBLIC_BUBBLEWASH_ADMIN_MFA_REQUIRED: 'false',
  // This loopback-only fixture intentionally trusts distinct synthetic test IPs.
  // Production configuration and rate-limit thresholds are unchanged.
  BUBBLEWASH_TRUST_PROXY_HEADERS: 'true',
  BUBBLEWASH_VENDOR_ENTITY_ID: 'vendor-browser', BUBBLEWASH_DRIVER_ENTITY_ID: 'driver-browser',
  BUBBLEWASH_PUBLIC_URL: 'http://localhost:3100',
  NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED: 'false', NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED: 'false',
});
for (const role of ['admin']) {
  process.env[`BUBBLEWASH_${role.toUpperCase()}_EMAIL`] = `${role}@example.invalid`;
  process.env[`BUBBLEWASH_${role.toUpperCase()}_PASSWORD_HASH`] = createPasswordHash(`synthetic-${role}-password-123`);
}
// Production non-admin access uses managed identities, never environment fallbacks.
const { inviteStaffAccount, activateStaffAccount } = await import('../../src/lib/staff-accounts.ts');
for (const role of ['vendor', 'driver', 'support']) {
  const token = inviteStaffAccount({ email: `${role}@example.invalid`, name: `Synthetic ${role}`, role, entityId: process.env[`BUBBLEWASH_${role.toUpperCase()}_ENTITY_ID`] || '' }, 'synthetic-fixture');
  assert.equal(activateStaffAccount(token, `synthetic-${role}-password-123`), true);
}
const availability = await import('../../src/lib/availability-store.ts');
availability.upsertVendorAvailability({ vendorId: 'vendor-browser', vendorName: 'Synthetic Laundry', serviceZones: ['Osu'], serviceTypes: ['Wash + fold'], capacityRemaining: 10, availabilityStatus: 'available', updatedBy: 'synthetic-fixture' });
availability.upsertDriverAvailability({ driverId: 'driver-browser', driverName: 'Synthetic Rider', serviceZones: ['Osu'], capacityRemaining: 10, availabilityStatus: 'active', updatedBy: 'synthetic-fixture' });
const { appendSubmissionRecord, getDatabase } = await import('../../src/lib/data-store.ts');
appendSubmissionRecord({ id: 'BW-BROWSEROVERDUE01', createdAt: new Date(Date.now() - 3600000).toISOString(), source: 'synthetic-browser-fixture', data: { submissionType: 'pickup-booking', name: 'Synthetic overdue customer', company: 'Synthetic overdue account', email: 'overdue@example.invalid', phone: '0200000000', pickupAddress: 'Synthetic reception, Osu, Accra', pickupDate: new Date().toISOString().slice(0, 10), pickupWindow: '8:00–10:00', plan: 'Weekly', paymentPreference: 'Invoice me', alertPreference: 'Call me' } });
const server = spawn(process.execPath, ['--import', resolve('tests/browser/block-egress.mjs'), 'node_modules/next/dist/bin/next', 'start', '-H', 'localhost', '-p', '3100'], { env: process.env, stdio: 'inherit' });
let stopping = false;
function stop() { if (!stopping) { stopping = true; server.kill('SIGTERM'); } }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
server.on('exit', code => { getDatabase().close(); rmSync(directory, { recursive: true, force: true }); process.exit(stopping ? 0 : code ?? 1); });
server.on('error', error => { console.error(error); getDatabase().close(); rmSync(directory, { recursive: true, force: true }); process.exit(1); });
