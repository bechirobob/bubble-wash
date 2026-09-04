import "server-only";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { getDatabase, appendSubmissionRecord } from "./data-store.ts";
import { createPasswordHash } from "./passwords.ts";
import type { StaffUser, StaffRole } from "./auth.ts";
export type StaffAccount = StaffUser & { status: "invited" | "active" | "suspended"; updatedAt: string };
function db() {
  const database = getDatabase();
  database.exec(`CREATE TABLE IF NOT EXISTS staff_accounts (email TEXT PRIMARY KEY COLLATE NOCASE, name TEXT NOT NULL, role TEXT NOT NULL, entity_id TEXT NOT NULL, password_hash TEXT NOT NULL, credential_version TEXT NOT NULL, status TEXT NOT NULL, token_hash TEXT NOT NULL, token_expires_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  return database;
}
export function listStaffAccounts() {
  return db().prepare("SELECT email, name, role, entity_id AS entityId, password_hash AS passwordHash, credential_version AS credentialVersion, status, updated_at AS updatedAt FROM staff_accounts ORDER BY name").all() as StaffAccount[];
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
