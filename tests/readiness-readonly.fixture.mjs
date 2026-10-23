// Fresh-process synthetic fixture: never connects to production or any network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createPasswordHash } from '../src/lib/passwords.ts';
const [directory, mode, scenario] = process.argv.slice(2);
Object.assign(process.env, {
  NODE_ENV: 'production', BUBBLEWASH_DATABASE_DRIVER: 'sqlite', NEXT_TELEMETRY_DISABLED: '1',
  BUBBLEWASH_DATABASE_PATH: path.join(directory, 'database.sqlite'),
  BUBBLEWASH_DISABLE_DEMO_LOGIN: 'true', BUBBLEWASH_STAFF_AUTH_DISABLED: 'false',
  BUBBLEWASH_BOOKINGS_DISABLED: 'true', BUBBLEWASH_TRUST_EDGE_HEADERS: 'true',
  BUBBLEWASH_SESSION_SECRET: 'synthetic-session-secret-at-least-thirty-two-characters',
  BUBBLEWASH_BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  BUBBLEWASH_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
  BUBBLEWASH_BACKUP_PRIMARY_DIR: path.join(directory, 'primary'),
  BUBBLEWASH_BACKUP_OFFSITE_DIR: path.join(directory, 'offsite'),
  BUBBLEWASH_BACKUP_STATUS_PATH: path.join(directory, 'status.json'),
  BUBBLEWASH_PUBLIC_URL: 'https://example.test',
  BUBBLEWASH_ADMIN_EMAIL: 'fallback@example.test',
  BUBBLEWASH_ADMIN_PASSWORD_HASH: createPasswordHash('synthetic-strong-password-not-real', 'synthetic-salt'),
  BUBBLEWASH_MAINTENANCE_TOKEN: 'synthetic-maintenance-token-at-least-thirty-two-characters',
  BUBBLEWASH_ADMIN_MFA_REQUIRED: 'true', NEXT_PUBLIC_BUBBLEWASH_ADMIN_MFA_REQUIRED: 'true',
});
const { getDatabase, openReadOnlyDatabase } = await import('../src/lib/data-store.ts');
if (mode === 'seed') {
  const now = new Date().toISOString();
  fs.writeFileSync(process.env.BUBBLEWASH_BACKUP_STATUS_PATH, JSON.stringify({ ok: true, createdAt: now, restoreVerifiedAt: now, offsiteStoredAt: now }));
  if (scenario === 'missing-database') process.exit(0);
  const db = getDatabase();
  const { initializeStaffAccountsSchema } = await import('../src/lib/staff-accounts.ts');
  initializeStaffAccountsSchema(db);
  const admin = 'managed-admin@example.test';
  const owner = scenario.startsWith('owner-');
  const hash = process.env.BUBBLEWASH_ADMIN_PASSWORD_HASH;
  db.prepare('INSERT INTO staff_accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(admin, 'Synthetic Admin', 'admin', '', hash, 'managed-version', 'active', '', '', now);
  db.prepare('INSERT INTO staff_credential_overrides VALUES (?, ?, ?, ?, ?)')
    .run('admin', admin, hash, 'override-version', now);
  if (owner) {
    db.exec('CREATE TABLE staff_owner_capabilities (email TEXT PRIMARY KEY COLLATE NOCASE REFERENCES staff_accounts(email), all_staff_access INTEGER NOT NULL CHECK (all_staff_access = 1))');
    db.prepare('INSERT INTO staff_owner_capabilities VALUES (?, 1)').run(admin);
  }
  const { currentStaffUsers, encodeSession } = await import('../src/lib/auth.ts');
  const resolved = currentStaffUsers();
  assert.equal(resolved.length, 1); assert.equal(resolved[0].credentialVersion, 'managed-version');
  const { startAdminMfaEnrollment, confirmAdminMfaEnrollment, adminMfaConfigured } = await import('../src/lib/admin-mfa.ts');
  const { totpCode } = await import('../src/lib/totp.ts');
  const enrollment = await startAdminMfaEnrollment(admin);
  assert.equal(confirmAdminMfaEnrollment(admin, totpCode(enrollment.manualKey)).ok, true);
  assert.equal(adminMfaConfigured(admin), true);
  fs.writeFileSync(path.join(directory, 'session'), encodeSession(resolved[0], owner));
  db.prepare('INSERT INTO driver_live_locations VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('synthetic-driver', 'synthetic-order', 5.6, -0.1, 20, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z');
  if (scenario === 'owner-mfa-removed') db.prepare("DELETE FROM admin_mfa_settings WHERE admin_email = ?").run(admin);
  if (scenario === 'owner-revoked') db.prepare("UPDATE staff_accounts SET status = 'suspended', credential_version = 'revoked'").run();
  if (scenario === 'missing-staff-table') db.exec('DROP TABLE staff_accounts');
  if (scenario === 'missing-core-table') db.exec('DROP TABLE privacy_requests');
  if (scenario === 'missing-core-index') db.exec('DROP INDEX idx_driver_live_locations_captured_at');
  if (scenario === 'revoked-admin') db.prepare("UPDATE staff_accounts SET status = 'suspended', credential_version = 'revoked'").run();
  if (scenario === 'schema-mismatch') db.exec('ALTER TABLE driver_live_locations RENAME COLUMN latitude TO old_latitude');
  db.close();
} else {
  const { NextRequest } = await import('next/server.js');
  const { GET } = await import('../src/app/api/ready/route.ts');
  const session = scenario === 'missing-database' ? '' : fs.readFileSync(path.join(directory, 'session'), 'utf8');
  let origin = 'http://localhost';
  let server;
  let stopped;
  if (mode === 'http') {
    const { createServer } = await import('node:net');
    const { spawn } = await import('node:child_process');
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    origin = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], { env: process.env, stdio: 'ignore' });
    stopped = new Promise((resolve) => server.once('exit', resolve));
  }
  try {
    if (server) {
      let healthy = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        assert.equal(server.exitCode, null, 'Synthetic Next server exited');
        try { healthy = (await fetch(origin + '/api/health')).ok; } catch {}
        if (healthy) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(healthy, true, 'Synthetic Next health did not become ready');
      for (const route of ['/', '/services', '/book', '/track', '/manage', '/early-access']) {
        assert.equal((await fetch(origin + route)).status, 200, route);
      }
    }
  for (const access of ['anonymous', 'maintenance', 'admin-session']) {
    const headers = access === 'maintenance' ? { authorization: `Bearer ${process.env.BUBBLEWASH_MAINTENANCE_TOKEN}` }
      : access === 'admin-session' ? { cookie: `bubblewash_staff_session=${session}` } : {};
    const response = server ? await fetch(origin + '/api/ready', { headers })
      : await GET(new NextRequest(origin + '/api/ready', { headers }));
    const body = await response.json();
    const ready = ['complete', 'owner-complete', 'owner-mfa-removed'].includes(scenario);
    assert.equal(response.status, ready ? 200 : 503, `${scenario}/${access}`);
    assert.equal(body.ok, ready); assert.equal(body.bookings, 'paused');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const detailed = scenario !== 'missing-database' && (access === 'maintenance' ||
      access === 'admin-session' && !['missing-staff-table', 'revoked-admin', 'owner-revoked', 'owner-mfa-removed'].includes(scenario));
    assert.equal(Object.hasOwn(body, 'checks'), detailed, `${scenario}/${access}: detail access`);
    if (ready && detailed && scenario !== 'owner-mfa-removed') assert.ok(!body.warnings.some((warning) => warning.includes('MFA enrollment')));
    assert.ok(!JSON.stringify(body).includes('managed-admin@example.test'));
    assert.ok(!JSON.stringify(body).includes(process.env.BUBBLEWASH_ADMIN_PASSWORD_HASH));
  }
  } finally {
    if (server) {
      server.kill('SIGTERM');
      const timeout = setTimeout(() => server.kill('SIGKILL'), 5000);
      await stopped; clearTimeout(timeout);
    }
  }
  if (scenario !== 'missing-database') {
    const db = openReadOnlyDatabase();
    assert.equal(db.readonly, true);
    assert.throws(() => db.prepare('DELETE FROM driver_live_locations').run(), /readonly|read-only/i);
    assert.equal(db.prepare('SELECT count(*) AS n FROM driver_live_locations').get().n, 1);
    db.close();
  }
}
