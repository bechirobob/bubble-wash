import './block-egress.mjs';
import assert from 'node:assert/strict';
import { createFixtureEdge } from './fixture-edge.mjs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) if (existsSync(name)) throw new Error('Results fixture refuses local environment files.');
const platform = Object.fromEntries(['PATH','HOME','TMPDIR','TEMP','TMP','SYSTEMROOT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
for (const key of Object.keys(process.env)) delete process.env[key];
const directory = mkdtempSync(join(tmpdir(), 'bubblewash-results-synthetic-'));
Object.assign(process.env, platform, { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', BUBBLEWASH_DATABASE_PATH: join(directory, 'synthetic.sqlite'), BUBBLEWASH_SESSION_SECRET: 'synthetic-results-session-secret-never-production', BUBBLEWASH_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 19).toString('base64'), BUBBLEWASH_STAFF_AUTH_DISABLED: 'false', BUBBLEWASH_DISABLE_DEMO_LOGIN: 'true', BUBBLEWASH_ADMIN_MFA_REQUIRED: 'false', NEXT_PUBLIC_BUBBLEWASH_ADMIN_MFA_REQUIRED: 'false', BUBBLEWASH_PUBLIC_URL: 'http://localhost:3217', BUBBLEWASH_TRUST_PROXY_HEADERS: 'true' });
const { createPasswordHash } = await import('../../src/lib/passwords.ts');
process.env.BUBBLEWASH_ADMIN_EMAIL = 'master@example.invalid';
process.env.BUBBLEWASH_ADMIN_PASSWORD_HASH = createPasswordHash('synthetic-master-results-password');
const { getDatabase } = await import('../../src/lib/data-store.ts');
const { initializeStaffAccountsSchema, inviteOwnerAccount, inviteStaffAccount, activateStaffAccount } = await import('../../src/lib/staff-accounts.ts');
initializeStaffAccountsSchema(getDatabase());
const token = inviteOwnerAccount({ email: 'owner@example.invalid', name: 'Synthetic owner' }, 'synthetic-local-fixture');
assert.equal(activateStaffAccount(token, 'synthetic-owner-results-password'), true);
const { startAdminMfaEnrollment, confirmAdminMfaEnrollment } = await import('../../src/lib/admin-mfa.ts');
const { totpCode } = await import('../../src/lib/totp.ts');
const enrollment = await startAdminMfaEnrollment('owner@example.invalid');
assert.equal(confirmAdminMfaEnrollment('owner@example.invalid', totpCode(enrollment.manualKey)).ok, true);
for (const role of ['vendor', 'driver', 'support']) {
  const staffToken = inviteStaffAccount({ email: `${role}@example.invalid`, name: `Synthetic ${role}`, role, entityId: ['vendor','driver'].includes(role) ? `synthetic-${role}` : '' }, 'synthetic-local-fixture');
  assert.equal(activateStaffAccount(staffToken, `synthetic-${role}-results-password`), true);
}
const auth = await import('../../src/lib/auth.ts');
const sessions = Object.fromEntries(['owner', 'master', 'vendor', 'driver', 'support'].map(role => [role, auth.encodeSession(auth.findStaffUser(`${role}@example.invalid`, `synthetic-${role}-results-password`), role === 'owner')]));
const { schemaVersion } = await import('../../src/lib/research/policy.ts');
const { saveResponse } = await import('../../src/lib/research/store.ts');
getDatabase().exec(readFileSync(resolve('db/proposed/research-v1.sql'), 'utf8'));
const names = ['Ama Demo', 'Kojo Demo', 'Akua Demo', 'Kwame Demo', 'Abena Demo', 'Kofi Demo'];
const areas = ['Tse Addo', 'East Legon', 'Airport', 'Cantonments', 'Achimota', 'Haatso'];
for (let i = 0; i < 84; i++) {
  const answers = { 'icp-student': i % 4 === 0 ? 'Yes' : 'No', 'icp-business': i % 5 === 0 ? 'Yes' : 'No', 'icp-corporate': i % 3 !== 0 ? 'Yes' : 'No', 'icp-household': i % 2 === 0 ? 'Yes' : 'No', A1: i % 2 === 0 ? '25 to 34' : '35 to 44', A2: i >= 78 ? 'Neither' : 'Both', A3: i >= 75 && i < 78 ? 'Other (specify)' : i >= 72 && i < 75 ? 'None of these' : areas[i % 6], E1: ['5','4','5','3','5','4','5','2','4','1','5','4'][i % 12], E2: ['Per bag','Monthly subscription','Per item'][i % 3], C1: i % 3 === 0 ? ['Takes too much time', 'Costs too much'] : ['Takes too much time', 'Ironing'], A8: i % 4 === 0 ? 'House help' : 'Me', B6b: i % 3 === 0 ? 'Yes, occasionally' : 'No', C3: 'Synthetic research response for interface testing only. Reliable collection times would make the biggest difference.', H1: i % 2 === 0 ? 'Yes' : 'No', H2: 'No', H3: 'No' };
  if (answers.A3 === 'Other (specify)') answers['A3-other'] = 'Synthetic area needing review';
  if (answers.A8 === 'House help') answers.A8a = String(400 + i * 10);
  if (answers.B6b === 'Yes, occasionally') answers.B6c = 'GH₵100–299';
  if (i % 17 === 0) delete answers.E1;
  const contact = i === 82 ? 81 : i;
  saveResponse({ adultEligible: true, instrument: 'consumer', schemaVersion, submissionKey: randomUUID(), identity: { name: `${names[i % names.length]} ${i + 1}`, organisation: '', email: `demo-${contact}@example.invalid`, phone: `024${String(contact).padStart(7,'0')}` }, consent: true, answers, reference: 'synthetic-results-preview' });
}
const db = getDatabase();
db.prepare("UPDATE research_responses SET created_at='2026-10-23T12:00:00.000Z'").run();
const firstId = db.prepare('SELECT id FROM research_responses LIMIT 1').get().id;
const fixtureFile = '/tmp/bubblewash-results-fixture-proof.json';
writeFileSync(fixtureFile, JSON.stringify({ sessions, firstId, directory }), { mode: 0o600 });
const server = spawn(process.execPath, ['--import', resolve('tests/browser/block-egress.mjs'), 'node_modules/next/dist/bin/next', 'start', '-H', 'localhost', '-p', '3218'], { env: process.env, stdio: 'inherit' });
const edge = createFixtureEdge({ upstreamPort: 3218, origin: 'http://localhost:3217' }); edge.listen(3217, 'localhost');
let stopping = false;
function stop() { if (!stopping) { stopping = true; server.kill('SIGTERM'); } }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
server.on('exit', code => { edge.closeAllConnections(); edge.close(); db.close(); rmSync(directory,{recursive:true,force:true}); rmSync(fixtureFile,{force:true}); process.exit(stopping ? 0 : code ?? 1); });
server.on('error', error => { console.error(error.message); stop(); });
