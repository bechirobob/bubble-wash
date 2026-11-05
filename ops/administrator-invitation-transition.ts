/** Narrow shared transition; callers must supply deployment guards and a precommit handshake. */
import type Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { databaseReadiness, readStaffCredentialOverride } from '../src/lib/data-store.ts';

import { initializeStaffAccountsSchema } from '../src/lib/staff-accounts.ts';

const ownerCapabilityDdl = `CREATE TABLE IF NOT EXISTS staff_owner_capabilities (email TEXT PRIMARY KEY COLLATE NOCASE REFERENCES staff_accounts(email), all_staff_access INTEGER NOT NULL CHECK (all_staff_access = 1))`;
const target = { email: 'abigail@bubblewash.co', name: 'Abigail Kabirou' };
export const administratorPermissionsDdl = `CREATE TABLE staff_admin_permissions (email TEXT PRIMARY KEY COLLATE NOCASE REFERENCES staff_accounts(email), operational_workspaces INTEGER NOT NULL CHECK (operational_workspaces IN (0, 1)), survey_results INTEGER NOT NULL CHECK (survey_results IN (0, 1)))`;
function requireValue(value: unknown): asserts value { if (!value) throw new Error('Administrator transition refused; no access changed.'); }
function snapshot(database: Database.Database) {
  const row = database.prepare('SELECT * FROM staff_accounts WHERE email = ?').get(target.email) as Record<string, string> | undefined;
  const owner = database.prepare('SELECT * FROM staff_owner_capabilities WHERE email = ?').get(target.email);
  const present = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'staff_admin_permissions'").get() as { sql: string } | undefined;
  if (present) requireValue(present.sql === administratorPermissionsDdl);
  const permissions = present ? database.prepare('SELECT * FROM staff_admin_permissions WHERE email = ?').get(target.email) : undefined;
  return { row, owner, permissions };
}
export function administratorTransitionFingerprint(database: Database.Database) {
  return createHash('sha256').update(JSON.stringify(snapshot(database))).digest('hex');
}
export function prepareAdministratorInvitation(database: Database.Database, input: {
  expectedFingerprint: string; actor: string; confirmedEmail: string;
  approved: boolean; operationalWorkspaces: boolean; surveyResults: boolean;
}, env: NodeJS.ProcessEnv, now = Date.now(), beforeCommit: (result: { token: string; expiresAt: string }) => void = () => {}) {
  // Separate explicit grant decisions, not an owner flag or a new generic admin enrollment API.
  requireValue(input.approved === true && input.confirmedEmail === target.email && input.actor.trim() &&
    input.actor.trim().toLowerCase() !== target.email && input.operationalWorkspaces === true && input.surveyResults === true &&
    /^[a-f0-9]{64}$/.test(input.expectedFingerprint) && Number.isSafeInteger(now));
  requireValue(env.BUBBLEWASH_UAT_ENABLED !== 'true');
  return database.transaction(() => {
    assertAdministratorTransitionState(database, env, now);
    requireValue(administratorTransitionFingerprint(database) === input.expectedFingerprint);
    // The old token is replaced, the credential version rotates, and owner capability is removed
    // in the same transaction as the narrow capability grant and audit. No master identity writes.
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'staff_admin_permissions'").get()) database.exec(administratorPermissionsDdl);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now + 86400000).toISOString();
    const updatedAt = new Date(now).toISOString();
    requireValue(database.prepare('DELETE FROM staff_owner_capabilities WHERE email = ? AND all_staff_access = 1').run(target.email).changes === 1);
    database.prepare('INSERT INTO staff_admin_permissions VALUES (?, 1, 1)').run(target.email);
    requireValue(database.prepare("UPDATE staff_accounts SET credential_version = ?, token_hash = ?, token_expires_at = ?, updated_at = ? WHERE email = ? AND status = 'invited'")
      .run(randomUUID(), createHash('sha256').update(token).digest('hex'), expiresAt, updatedAt, target.email).changes === 1);
    database.prepare('INSERT INTO submissions (id, created_at, source, data) VALUES (?, ?, ?, ?)').run(`BW-${randomUUID()}`, updatedAt, 'staff-account-administration',
      JSON.stringify({ submissionType: 'staff-account-action', staffEmail: target.email, submittedByEmail: input.actor,
        actionType: 'Replace expired owner invitation with non-owner administrator invitation', operationalWorkspaceAccess: true, surveyResultsAccess: true, ownerCapabilityRemoved: true }));
    const result = { token, expiresAt };
    beforeCommit(result); // Sealing and the guarded host handshake must succeed before SQLite commit.
    return result;
  }).immediate();
}

export function assertAdministratorTransitionState(database: Database.Database, env: NodeJS.ProcessEnv, now = Date.now()) {
  requireValue(env.BUBBLEWASH_UAT_ENABLED !== "true" && Number.isSafeInteger(now));
    requireValue(!database.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('trigger','view')").get());
    requireValue(databaseReadiness(database, [initializeStaffAccountsSchema, reference => reference.exec(ownerCapabilityDdl)], { allowMissingBookingReferences: true }));
    const foreignKeyViolations = database.pragma('foreign_key_check');
    requireValue(Array.isArray(foreignKeyViolations) && foreignKeyViolations.length === 0);
    // Extra tables may exist, but must not cascade this operation into unrelated records.
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    for (const table of tables) {
      const links = database.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(table.name) as { table: string }[];
      for (const link of links) {
        if (['staff_accounts', 'staff_owner_capabilities', 'staff_admin_permissions', 'submissions'].includes(link.table.toLowerCase())) {
          requireValue(link.table.toLowerCase() === 'staff_accounts' && ['staff_owner_capabilities', 'staff_admin_permissions'].includes(table.name));
        }
      }
    }
    const reserved = [readStaffCredentialOverride('admin', database)?.login,
      ...['ADMIN', 'VENDOR', 'DRIVER', 'SUPPORT'].map(role => env[`BUBBLEWASH_${role}_EMAIL`])];
    requireValue(!reserved.some(email => email?.trim().toLowerCase() === target.email));
    requireValue(!database.prepare(`SELECT 1 FROM submissions WHERE json_extract(data, '$.submissionType') IN ('staff-onboarding', 'vendor-application', 'driver-onboarding') AND (lower(trim(json_extract(data, '$.email'))) = ? OR lower(trim(json_extract(data, '$.staffEmail'))) = ?)`).get(target.email, target.email));
    // An expired unclaimed invitation must not silently inherit or replace MFA state.
    requireValue(!database.prepare('SELECT 1 FROM admin_mfa_settings WHERE admin_email = ?').get(target.email));
    requireValue(!database.prepare('SELECT 1 FROM admin_mfa_recovery_codes WHERE admin_email = ?').get(target.email));
    requireValue(!database.prepare('SELECT 1 FROM mfa_replay_guard WHERE subject = ? COLLATE NOCASE').get(target.email));
    const before = snapshot(database);
    const row = before.row;
    requireValue(row && row.email === target.email && row.name === target.name && row.role === 'admin' &&
      row.status === 'invited' && row.entity_id === '' && row.password_hash === '' &&
      /^[a-f0-9]{64}$/.test(row.token_hash) && Date.parse(row.token_expires_at) <= now &&
      row.credential_version && !before.permissions);
    requireValue(before.owner && (before.owner as { all_staff_access: number }).all_staff_access === 1);
}
