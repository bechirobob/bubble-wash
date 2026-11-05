import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const directory = mkdtempSync(join(tmpdir(), 'bw-admin-transition-'));
Object.assign(process.env, { NODE_ENV: 'production', BUBBLEWASH_DATABASE_PATH: join(directory, 'synthetic.sqlite'), BUBBLEWASH_DISABLE_DEMO_LOGIN: 'true', BUBBLEWASH_STAFF_AUTH_DISABLED: 'false', BUBBLEWASH_SESSION_SECRET: 'synthetic-only-session-secret', BUBBLEWASH_ADMIN_EMAIL: 'master@example.invalid' });
const { getDatabase } = await import('../src/lib/data-store.ts');
const { initializeStaffAccountsSchema, listStaffAccounts, activateStaffAccount } = await import('../src/lib/staff-accounts.ts');
const { administratorTransitionFingerprint, prepareAdministratorInvitation } = await import('../ops/administrator-invitation-transition.ts');
const { encodeSession, decodeSession, currentStaffUsers, staffSessionDestination } = await import('../src/lib/auth.ts');
const { canViewResearchResults } = await import('../src/lib/research/access.ts');
const { canEnterOperationalWorkspaces } = await import('../src/lib/staff-permissions.ts');
const db = getDatabase();
try {
  initializeStaffAccountsSchema(db);
  db.exec('CREATE TABLE staff_owner_capabilities (email TEXT PRIMARY KEY COLLATE NOCASE REFERENCES staff_accounts(email), all_staff_access INTEGER NOT NULL CHECK (all_staff_access = 1))');
  const email = 'abigail@bubblewash.co', oldToken = 'synthetic-expired-token';
  db.prepare("INSERT INTO staff_accounts VALUES (?, ?, 'admin', '', '', 'old-version', 'invited', ?, '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z')")
    .run(email, 'Abigail Kabirou', createHash('sha256').update(oldToken).digest('hex'));
  db.prepare('INSERT INTO staff_owner_capabilities VALUES (?, 1)').run(email);
  db.prepare("INSERT INTO staff_credential_overrides VALUES ('admin', 'preserved@example.invalid', 'preserved-hash', 'preserved-version', '2000-01-01')").run();
  const master = db.prepare('SELECT * FROM staff_credential_overrides').all();
  const input = () => ({ expectedFingerprint: administratorTransitionFingerprint(db), actor: 'reviewer@example.invalid', confirmedEmail: email, approved: true, operationalWorkspaces: true, surveyResults: true });
  const state = () => JSON.stringify({schema:db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), accounts:db.prepare('SELECT * FROM staff_accounts').all(), owners:db.prepare('SELECT * FROM staff_owner_capabilities').all(),audit:db.prepare('SELECT * FROM submissions').all(),mfa:db.prepare('SELECT * FROM admin_mfa_settings').all(),recovery:db.prepare('SELECT * FROM admin_mfa_recovery_codes').all(),replay:db.prepare('SELECT * FROM mfa_replay_guard').all()});
  function rejected(i = input(), env = process.env) { const before = state(); assert.throws(() => prepareAdministratorInvitation(db, i, env)); assert.equal(state(), before); }
  rejected({...input(), approved:false}); rejected({...input(), expectedFingerprint:'0'.repeat(64)});
  rejected({...input(), confirmedEmail:'someone@example.invalid'});
  rejected(input(), {...process.env, BUBBLEWASH_UAT_ENABLED:'true'});
  rejected(input(), {...process.env, BUBBLEWASH_ADMIN_EMAIL:email});
  db.prepare("UPDATE staff_credential_overrides SET login = ?").run(email); rejected();
  db.prepare("UPDATE staff_credential_overrides SET login = 'preserved@example.invalid'").run();
  for (const status of ['active','suspended','archived']) { db.prepare('UPDATE staff_accounts SET status = ?').run(status); rejected(); }
  db.prepare("UPDATE staff_accounts SET status = 'invited', token_expires_at = '2999-01-01T00:00:00Z'").run(); rejected();
  db.prepare("UPDATE staff_accounts SET token_expires_at = '2000-01-01T00:00:00Z'").run();
  db.prepare("INSERT INTO admin_mfa_settings VALUES (?, 'synthetic-not-a-real-secret', 'pending', '2999-01-01', NULL, '2000-01-01', '2000-01-01')").run(email);
  rejected(); db.prepare('DELETE FROM admin_mfa_settings WHERE admin_email = ?').run(email);
  db.prepare("INSERT INTO mfa_replay_guard VALUES (?, 1, '2000-01-01')").run(email);
  rejected(); db.prepare('DELETE FROM mfa_replay_guard WHERE subject = ?').run(email);
  // Every roster surface/identity field rejects normalized collisions without changing accounts.
  for (const kind of ['staff-onboarding','vendor-application','driver-onboarding']) {
    for (const field of ['email','staffEmail']) {
      const id = `roster-${kind}-${field}`;
      db.prepare('INSERT INTO submissions VALUES (?, ?, ?, ?)').run(id, '2000-01-01', 'synthetic', JSON.stringify({submissionType:kind, [field]:' ABIGAIL@BUBBLEWASH.CO '}));
      rejected(); db.prepare('DELETE FROM submissions WHERE id = ?').run(id);
    }
  }
  // Savepoints restore each intentionally malformed synthetic schema after refusal.
  const schemaFingerprint=input();
  for (const ddl of [
    'ALTER TABLE staff_accounts ADD COLUMN unexpected TEXT',
    'ALTER TABLE staff_owner_capabilities ADD COLUMN unexpected TEXT',
    'ALTER TABLE submissions ADD COLUMN unexpected TEXT',
    'ALTER TABLE staff_credential_overrides ADD COLUMN unexpected TEXT',
    'CREATE TABLE unrelated_cascade (email TEXT REFERENCES staff_owner_capabilities(email) ON DELETE CASCADE)',
    'CREATE TABLE unrelated_account_reference (version TEXT REFERENCES staff_accounts(credential_version) ON UPDATE CASCADE)',
    'CREATE TABLE staff_admin_permissions (email TEXT, operational_workspaces INTEGER, survey_results INTEGER)',
    'CREATE VIEW staff_admin_permissions AS SELECT email, 1 AS operational_workspaces, 1 AS survey_results FROM staff_accounts',
  ]) {
    db.exec('SAVEPOINT malformed');
    try { db.exec(ddl); rejected(schemaFingerprint); }
    finally { db.exec('ROLLBACK TO malformed; RELEASE malformed'); }
  }
  db.exec("CREATE TRIGGER forbidden AFTER UPDATE ON staff_accounts BEGIN SELECT 1; END"); rejected(); db.exec('DROP TRIGGER forbidden');
  // Force the final audit write to fail after account/capability changes; transaction must roll all back.
  const failing = new Proxy(db, { get(target,key) { if(key === 'prepare') return sql => { if(sql.startsWith('INSERT INTO submissions')) throw new Error('synthetic audit failure'); return target.prepare(sql); }; const v=target[key]; return typeof v==='function'?v.bind(target):v; } });
  const beforeFailure=state(); assert.throws(()=>prepareAdministratorInvitation(failing,input(),process.env), /synthetic audit failure/); assert.equal(state(),beforeFailure);
  const oldSession=encodeSession({email,name:'Abigail Kabirou',role:'admin',credentialVersion:'old-version',passwordHash:''});
  const now=Date.now(), result=prepareAdministratorInvitation(db,input(),process.env,now);
  assert.equal(Date.parse(result.expiresAt)-now,86400000);
  assert.equal(db.prepare('SELECT * FROM staff_owner_capabilities WHERE email = ?').get(email),undefined);
  assert.equal(activateStaffAccount(oldToken,'synthetic-password-123!'),false);
  assert.equal(decodeSession(oldSession),null);
  assert.throws(()=>prepareAdministratorInvitation(db,input(),process.env),/refused/);
  assert.equal(activateStaffAccount(result.token,'synthetic-password-123!'),true);
  assert.equal(activateStaffAccount(result.token,'synthetic-password-123!'),false);
  const user=currentStaffUsers().find(u=>u.email===email);
  assert.equal(user.allStaffAccess,false);
  const session=encodeSession(user), decoded=decodeSession(session);
  assert.equal(decoded.allStaffAccess,false); assert.equal(canEnterOperationalWorkspaces(decoded),true); assert.equal(canViewResearchResults(decoded),true);
  assert.equal(staffSessionDestination(decoded,'/vendors'),'/vendors');
  db.prepare('DELETE FROM staff_admin_permissions WHERE email = ?').run(email);
  const revoked=decodeSession(session); assert.equal(canEnterOperationalWorkspaces(revoked),false);assert.equal(canViewResearchResults(revoked),false);
  assert.equal(staffSessionDestination(revoked,'/vendors'),'/admin');
  // Owner identity still requires owner MFA even if independent grants are present.
  db.prepare('INSERT INTO staff_owner_capabilities VALUES (?, 1)').run(email);
  assert.throws(()=>encodeSession(currentStaffUsers().find(u=>u.email===email)),/MFA verification/);
  assert.equal(decodeSession(session),null);
  assert.deepEqual(db.prepare('SELECT * FROM staff_credential_overrides').all(),master);
  assert.ok(!JSON.stringify(db.prepare('SELECT data FROM submissions').all()).includes(result.token));
  assert.equal(listStaffAccounts().filter(u=>u.email===email).length,1);
  console.log('PASS: stale/protected/UAT/roster/malformed-schema/inbound-FK rejection, atomic rollback, owner removal, single use/24h, session revocation, independent permission revocation, owner MFA, master preservation');
} finally { db.close(); rmSync(directory,{recursive:true,force:true}); }
