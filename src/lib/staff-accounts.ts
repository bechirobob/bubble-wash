import "server-only";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { getDatabase, appendSubmissionRecord, readStaffCredentialOverride } from "./data-store.ts";
import { createPasswordHash } from "./passwords.ts";
import type { StaffUser, StaffRole } from "./auth.ts";
export type StaffAccount = StaffUser & { status: "invited" | "active" | "suspended"; updatedAt: string };
function db() {
  const database = getDatabase();
  database.exec(`CREATE TABLE IF NOT EXISTS staff_accounts (email TEXT PRIMARY KEY COLLATE NOCASE, name TEXT NOT NULL, role TEXT NOT NULL, entity_id TEXT NOT NULL, password_hash TEXT NOT NULL, credential_version TEXT NOT NULL, status TEXT NOT NULL, token_hash TEXT NOT NULL, token_expires_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  return database;
}
export function listStaffAccounts() {
  const database = db();
  const hasCapabilities = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'staff_owner_capabilities'").get());
  const capability = hasCapabilities ? "EXISTS (SELECT 1 FROM staff_owner_capabilities c WHERE c.email = staff_accounts.email AND c.all_staff_access = 1)" : "0";
  return database.prepare(`SELECT email, name, role, entity_id AS entityId, password_hash AS passwordHash, credential_version AS credentialVersion, status, updated_at AS updatedAt, ${capability} AS allStaffAccess FROM staff_accounts ORDER BY name`).all().map((row) => ({ ...(row as StaffAccount), allStaffAccess: Boolean((row as StaffAccount).allStaffAccess) })) as StaffAccount[];
}
function audit(email: string, action: string, actor: string) {
  appendSubmissionRecord({ id: `BW-${randomUUID()}`, createdAt: new Date().toISOString(), source: "staff-account-administration", data: { submissionType: "staff-account-action", staffEmail: email, actionType: action, submittedByEmail: actor } });
}
export function inviteStaffAccount(input: { email: string; name: string; role: StaffRole; entityId: string }, actor: string) {
  const token = randomBytes(32).toString("base64url");
  db().transaction(() => {
    const existing = listStaffAccounts().find((a) => a.email.toLowerCase() === input.email.toLowerCase());
    if (existing && (existing.role !== input.role || (existing.entityId || "") !== input.entityId)) throw new Error("Reset must preserve the existing role and roster binding.");
    db().prepare(`INSERT INTO staff_accounts VALUES (@email, @name, @role, @entityId, '', @version, 'invited', @tokenHash, @expires, @now) ON CONFLICT(email) DO UPDATE SET name = excluded.name, credential_version = excluded.credential_version, password_hash = '', status = 'invited', token_hash = excluded.token_hash, token_expires_at = excluded.token_expires_at, updated_at = excluded.updated_at`).run({ ...input, version: randomUUID(), tokenHash: createHash("sha256").update(token).digest("hex"), expires: new Date(Date.now() + 86400000).toISOString(), now: new Date().toISOString() });
    audit(input.email, existing ? "Reset access and revoke sessions" : "Invite staff account", actor);
  }).immediate();
  return token;
}
export function assertOwnerEmailAvailable(email: string) {
    // Include inactive/malformed environment identities and every managed status.
    // Never shadow, upgrade, reset, or replace an existing identity.
    const reserved = [readStaffCredentialOverride()?.login,
      ...["ADMIN", "VENDOR", "DRIVER", "SUPPORT"].map((role) => process.env[`BUBBLEWASH_${role}_EMAIL`]),
      ...(process.env.NODE_ENV !== "production" && process.env.BUBBLEWASH_DISABLE_DEMO_LOGIN !== "true" ? ["admin", "vendor", "driver", "support"].map((role) => `${role}@bubblewash.local`) : []),
      ...listStaffAccounts().map((account) => account.email)];
    const rosterCollision = db().prepare(`SELECT 1 FROM submissions WHERE json_extract(data, '$.submissionType') IN ('staff-onboarding', 'vendor-application', 'driver-onboarding') AND lower(trim(json_extract(data, '$.email'))) = ? LIMIT 1`).get(email);
    if (rosterCollision) throw new Error("This email already belongs to a roster entry. No access was changed.");
    if (reserved.some((candidate) => candidate?.trim().toLowerCase() === email)) throw new Error("This email already belongs to an account. No access was changed.");
 }

export function inviteOwnerAccount(input: { email: string; name: string }, actor: string) {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 160 || !name || name.length > 100) throw new Error("Enter a valid individual email and name.");
  const token = randomBytes(32).toString("base64url");
  db().transaction(() => {
    assertOwnerEmailAvailable(email);
    db().prepare(`INSERT INTO staff_accounts (email, name, role, entity_id, password_hash, credential_version, status, token_hash, token_expires_at, updated_at) VALUES (?, ?, 'admin', '', '', ?, 'invited', ?, ?, ?)`).run(email, name, randomUUID(), createHash("sha256").update(token).digest("hex"), new Date(Date.now() + 3600000).toISOString(), new Date().toISOString());
    db().exec(`CREATE TABLE IF NOT EXISTS staff_owner_capabilities (email TEXT PRIMARY KEY COLLATE NOCASE REFERENCES staff_accounts(email), all_staff_access INTEGER NOT NULL CHECK (all_staff_access = 1))`);
    db().prepare("INSERT INTO staff_owner_capabilities (email, all_staff_access) VALUES (?, 1)").run(email);
    audit(email, "Invite additional owner without changing existing accounts", actor);
  }).immediate();
  return token;
}

export function suspendStaffAccount(email: string, actor: string) {
  return db().transaction(() => {
    const changed = db().prepare("UPDATE staff_accounts SET status = 'suspended', credential_version = ?, token_hash = '', updated_at = ? WHERE email = ?").run(randomUUID(), new Date().toISOString(), email).changes;
    if (!changed) throw new Error("Create an individual account before managing its access.");
    audit(email, "Suspend access and revoke sessions", actor);
  }).immediate();
}
export function activateStaffAccount(token: string, password: string) {
  const hash = createHash("sha256").update(token).digest("hex");
  const passwordHash = createPasswordHash(password);
  return db().transaction(() => {
    const account = db().prepare("SELECT email FROM staff_accounts WHERE token_hash = ? AND token_expires_at > ? AND status = 'invited'").get(hash, new Date().toISOString()) as { email: string } | undefined;
    if (!account) return false;
    db().prepare("UPDATE staff_accounts SET password_hash = ?, credential_version = ?, status = 'active', token_hash = '', token_expires_at = '', updated_at = ? WHERE email = ?").run(passwordHash, randomUUID(), new Date().toISOString(), account.email);
    audit(account.email, "Activate individual access", account.email);
    return true;
  }).immediate();
}
