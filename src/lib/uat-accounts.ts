import "server-only";
import { randomUUID } from "node:crypto";
import { getDatabase } from "./data-store.ts";
import { createPasswordHash, validPasswordHash, matchesKnownDemoPassword } from "./passwords.ts";
import { assertUatEnvironment } from "./uat-environment.ts";
import type { StaffRole, StaffUser } from "./staff-identity.ts";

type Database = ReturnType<typeof getDatabase>;
export const UAT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const usernamePattern = /^[a-z][a-z0-9._-]{2,63}$/;
type UatAccount = { username: string; name: string; role: StaffRole; entityId: string; passwordHash: string; credentialVersion: string; startsAt: number; expiresAt: number; status: string };

// Separate, opt-in UAT schema: never alter production identities or owner tables.
export function initializeUatAccountsSchema(database: Database) {
  assertUatEnvironment();
  database.exec(`CREATE TABLE IF NOT EXISTS staff_uat_accounts (username TEXT PRIMARY KEY COLLATE NOCASE, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','vendor','driver','support')), entity_id TEXT NOT NULL, password_hash TEXT NOT NULL, credential_version TEXT NOT NULL, starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK (expires_at - starts_at = 604800000), status TEXT NOT NULL CHECK (status IN ('active','revoked','expired')), created_at INTEGER NOT NULL)`);
  database.exec(`CREATE TABLE IF NOT EXISTS staff_uat_audit (id TEXT PRIMARY KEY, username TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, occurred_at INTEGER NOT NULL, starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
}
function audit(database: Database, username: string, action: string, actor: string, startsAt: number, expiresAt: number) {
  database.prepare("INSERT INTO staff_uat_audit VALUES (?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), username, action, actor, Date.now(), startsAt, expiresAt);
}
function rows(database: Database): UatAccount[] {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='staff_uat_accounts'").get()) return [];
  return database.prepare("SELECT username, name, role, entity_id AS entityId, password_hash AS passwordHash, credential_version AS credentialVersion, starts_at AS startsAt, expires_at AS expiresAt, status FROM staff_uat_accounts").all() as UatAccount[];
}
// Extension grants leave the original issuance record and seven-day CHECK intact.
// A grant is tied to the exact credential version and cannot revive an account.
function effectiveDeadline(database: Database, account: UatAccount): number {
  if (account.status !== "active" || !database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='staff_uat_extensions'").get()) return account.expiresAt;
  const grant = database.prepare("SELECT starts_at, original_expires_at, expires_at, credential_version FROM staff_uat_extensions WHERE username=?").get(account.username) as {starts_at:number; original_expires_at:number; expires_at:number; credential_version:string} | undefined;
  return grant && grant.credential_version === account.credentialVersion && grant.starts_at === account.startsAt &&
    grant.original_expires_at === account.expiresAt && Number.isSafeInteger(grant.expires_at) &&
    grant.expires_at === account.expiresAt + UAT_WINDOW_MS ? grant.expires_at : account.expiresAt;
}

// Operator-only, explicit one-week extension. No HTTP route and no credential reset.
// expectedUsernames must enumerate the complete active cohort observed by the operator.
export function extendUatCohort(input: {startsAt:number; originalExpiresAt:number; expiresAt:number; expectedUsernames:string[]; operationId:string}, actor:string, database?:Database) {
  assertUatEnvironment();
  const db = database ?? getDatabase();
  const now = Date.now();
  if (!Number.isSafeInteger(input.startsAt) || !Number.isSafeInteger(input.originalExpiresAt) || !Number.isSafeInteger(input.expiresAt) ||
      input.originalExpiresAt - input.startsAt !== UAT_WINDOW_MS || input.expiresAt - input.originalExpiresAt !== UAT_WINDOW_MS ||
      now < input.startsAt || now >= input.originalExpiresAt || !actor.trim() || actor.length > 160 ||
      !/^[a-zA-Z0-9-]{8,80}$/.test(input.operationId) || !Array.isArray(input.expectedUsernames) ||
      !input.expectedUsernames.length || input.expectedUsernames.some(name => typeof name !== "string" || !usernamePattern.test(name)) ||
      new Set(input.expectedUsernames).size !== input.expectedUsernames.length) throw new Error("Invalid approved UAT extension.");
  return db.transaction(() => {
    const active = rows(db).filter(a => a.status === "active" && a.startsAt === input.startsAt && a.expiresAt === input.originalExpiresAt);
    if (JSON.stringify(active.map(a => a.username).sort()) !== JSON.stringify([...input.expectedUsernames].sort()) ||
        !active.some(a => a.role === "admin") || active.some(a => !validPasswordHash(a.passwordHash) || matchesKnownDemoPassword(a.passwordHash))) throw new Error("UAT cohort changed; inspect before extending.");
    db.exec("CREATE TABLE IF NOT EXISTS staff_uat_extensions (username TEXT PRIMARY KEY COLLATE NOCASE, credential_version TEXT NOT NULL, starts_at INTEGER NOT NULL, original_expires_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK (expires_at - original_expires_at = 604800000), operation_id TEXT NOT NULL, created_at INTEGER NOT NULL)");
    let applied = 0;
    for (const account of active) {
      const existing = db.prepare("SELECT * FROM staff_uat_extensions WHERE username=?").get(account.username) as {credential_version:string; starts_at:number; original_expires_at:number; expires_at:number; operation_id:string} | undefined;
      if (existing) {
        if (existing.credential_version !== account.credentialVersion || existing.starts_at !== account.startsAt || existing.original_expires_at !== account.expiresAt || existing.expires_at !== input.expiresAt || existing.operation_id !== input.operationId) throw new Error("Conflicting UAT extension; no changes applied.");
        continue;
      }
      db.prepare("INSERT INTO staff_uat_extensions VALUES (?,?,?,?,?,?,?)").run(account.username, account.credentialVersion, account.startsAt, account.expiresAt, input.expiresAt, input.operationId, now);
      audit(db, account.username, "extended-seven-days", actor, account.startsAt, input.expiresAt);
      applied++;
    }
    if (Date.now() >= input.originalExpiresAt) throw new Error("Original UAT period ended during extension.");
    return {extended:applied, total:active.length, expiresAt:input.expiresAt};
  }).immediate();
}

export function currentUatUsers(database?: Database, now = Date.now()): StaffUser[] {
  // An unsafe or disabled environment cannot authenticate temporary identities.
  try { assertUatEnvironment(); } catch { return []; }
  const db = database ?? getDatabase();
  const accounts = rows(db);
  // Authorization uses the deadline itself, not this audit housekeeping. Even
  // without a scheduler, the first post-deadline request is denied immediately.
  const expired = accounts.filter(a => a.status === "active" && now >= effectiveDeadline(db, a));
  if (expired.length && !db.readonly) db.transaction(() => {
    for (const a of expired) {
      const changed = db.prepare("UPDATE staff_uat_accounts SET status='expired', password_hash='', credential_version=? WHERE username=? AND status='active'").run(randomUUID(), a.username).changes;
      if (changed) audit(db, a.username, "expired", "system:deadline", a.startsAt, effectiveDeadline(db, a));
    }
  }).immediate();
  return accounts.filter(a => a.status === "active" && usernamePattern.test(a.username) &&
    Number.isSafeInteger(a.startsAt) && Number.isSafeInteger(a.expiresAt) && a.expiresAt - a.startsAt === UAT_WINDOW_MS &&
    now >= a.startsAt && now < effectiveDeadline(db, a) && validPasswordHash(a.passwordHash) && !matchesKnownDemoPassword(a.passwordHash) &&
    ["admin", "vendor", "driver", "support"].includes(a.role) && (!(a.role === "vendor" || a.role === "driver") || Boolean(a.entityId)))
    .map(a => ({ name: a.name, email: a.username, username: a.username, role: a.role, entityId: a.entityId || undefined,
      passwordHash: a.passwordHash, credentialVersion: a.credentialVersion, temporaryAccess: true,
      accessStartsAt: a.startsAt, accessExpiresAt: effectiveDeadline(db, a), allStaffAccess: false }));
}

// Operator-only local provisioning primitive. No HTTP endpoint, email, token or
// actual tester identity is created by installing this code. Passwords are hashed
// before storage and must be supplied privately, never through argv or checked-in files.
type UatAccountInput = { username: string; name: string; role: StaffRole; entityId?: string; password: string; startsAt: number };
export function createUatAccount(input: UatAccountInput, actor: string, database?: Database) {
  return createUatAccountAt(input, actor, database, Date.now());
}
function createUatAccountAt(input: UatAccountInput, actor: string, database: Database | undefined, now: number) {
  assertUatEnvironment();
  const db = database ?? getDatabase();
  const username = input.username.trim().toLowerCase();
  const name = input.name.trim();
  const entityId = input.entityId?.trim() ?? "";
  if (!usernamePattern.test(username) || !name || name.length > 100 || !actor.trim() || actor.length > 160 ||
      !["admin", "vendor", "driver", "support"].includes(input.role) || input.password.length < 14 || input.password.length > 200 ||
      !Number.isSafeInteger(input.startsAt) || input.startsAt < now || !Number.isSafeInteger(input.startsAt + UAT_WINDOW_MS)) throw new Error("Invalid temporary test account configuration.");
  if ((input.role === "vendor" || input.role === "driver") && !entityId) throw new Error("A synthetic roster binding is required.");
  if ((input.role === "admin" || input.role === "support") && entityId) throw new Error("This test role cannot have a roster binding.");
  const passwordHash = createPasswordHash(input.password);
  if (matchesKnownDemoPassword(passwordHash)) throw new Error("Choose a unique test password.");
  initializeUatAccountsSchema(db);
  const expiresAt = input.startsAt + UAT_WINDOW_MS;
  db.transaction(() => {
    if (input.role === "vendor" && !db.prepare("SELECT 1 FROM vendor_availability WHERE vendor_id=?").get(entityId) ||
        input.role === "driver" && !db.prepare("SELECT 1 FROM driver_availability WHERE driver_id=?").get(entityId)) throw new Error("Choose an existing synthetic roster record.");
    // No upsert/reset path: existing or revoked usernames cannot be resurrected
    // or silently extended. A later approved cohort uses a distinct identity.
    db.prepare("INSERT INTO staff_uat_accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)").run(username, name, input.role, entityId, passwordHash, randomUUID(), input.startsAt, expiresAt, Date.now());
    audit(db, username, "created", actor, input.startsAt, expiresAt);
  }).immediate();
  return { username, role: input.role, startsAt: input.startsAt, expiresAt };
}
export function revokeUatAccount(username: string, actor: string, database?: Database) {
  assertUatEnvironment();
  const db = database ?? getDatabase();
  if (!actor.trim() || actor.length > 160) throw new Error("An audit actor is required.");
  return db.transaction(() => {
    const account = rows(db).find(a => a.username === username.trim().toLowerCase());
    if (!account) throw new Error("Temporary test account not found.");
    if (account.status === "revoked") return;
    db.prepare("UPDATE staff_uat_accounts SET status='revoked', password_hash='', credential_version=? WHERE username=?").run(randomUUID(), account.username);
    audit(db, account.username, "revoked", actor, account.startsAt, account.expiresAt);
  }).immediate();
}

// The reviewer window starts at this explicit issuance transaction, never when a
// document draft is prepared. All four role identities succeed or none are issued.
export function issueUatCohort(accounts: Omit<UatAccountInput, "startsAt">[], actor: string, database?: Database) {
  assertUatEnvironment();
  if (!Array.isArray(accounts) || accounts.length !== 4 ||
      ["admin", "vendor", "driver", "support"].some(role => accounts.filter(a => a.role === role).length !== 1)) throw new Error("Issue exactly the four approved UAT roles together.");
  const db = database ?? getDatabase();
  return db.transaction(() => {
    const issuedAt = Date.now();
    const issued = accounts.map(account => createUatAccountAt({ ...account, startsAt: issuedAt }, actor, db, issuedAt));
    return { issuedAt, expiresAt: issuedAt + UAT_WINDOW_MS, accounts: issued };
  }).immediate();
}

export class UatAccountInputError extends Error {}
export const UAT_COHORT_ACCOUNT_LIMIT = 20;
type UatActor = { email: string; role: string; temporaryAccess?: boolean };
function uatAdministrator(actor: UatActor, database: Database) {
  assertUatEnvironment();
  if (actor.role !== "admin" || !actor.temporaryAccess) throw new Error("UAT administrator access is required.");
  const administrator = currentUatUsers(database).find(user => user.email === actor.email && user.role === "admin");
  if (!administrator?.temporaryAccess || !administrator.accessStartsAt || !administrator.accessExpiresAt) throw new Error("UAT administrator access is unavailable.");
  const original = rows(database).find(a => a.username === administrator.email)!;
  return {...administrator, cohortExpiresAt: original.expiresAt};
}
export function listUatTeam(actor: UatActor, database?: Database) {
  assertUatEnvironment();
  const db = database ?? getDatabase();
  const administrator = uatAdministrator(actor, db);
  const accounts = rows(db).filter(a => a.startsAt === administrator.accessStartsAt && a.expiresAt === administrator.cohortExpiresAt);
  return { expiresAt: administrator.accessExpiresAt, limit: UAT_COHORT_ACCOUNT_LIMIT, remaining: Math.max(0, UAT_COHORT_ACCOUNT_LIMIT - accounts.length),
    accounts: accounts.filter(a => a.role !== "admin").map(({username,name,role,entityId,status}) => ({username,name,role,entityId,status})),
    roster: [
      ...(db.prepare("SELECT 1 FROM sqlite_master WHERE name='vendor_availability'").get()
        ? (db.prepare("SELECT vendor_id AS id, vendor_name AS name FROM vendor_availability ORDER BY vendor_name, vendor_id").all() as {id:string;name:string}[]).map(record => ({...record, role: "vendor"})) : []),
      ...(db.prepare("SELECT 1 FROM sqlite_master WHERE name='driver_availability'").get()
        ? (db.prepare("SELECT driver_id AS id, driver_name AS name FROM driver_availability ORDER BY driver_name, driver_id").all() as {id:string;name:string}[]).map(record => ({...record, role: "driver"})) : []),
    ] };
}
export function createUatTeamAccount(input: Omit<UatAccountInput, "startsAt">, actor: UatActor, database?: Database) {
  assertUatEnvironment();
  if (!["vendor", "driver", "support"].includes(input.role)) throw new UatAccountInputError("Choose Vendor, Driver or Support test access.");
  const db = database ?? getDatabase();
  return db.transaction(() => {
    const administrator = uatAdministrator(actor, db);
    if (Date.now() >= administrator.cohortExpiresAt) throw new UatAccountInputError("This test group is closed to new users.");
    const count = rows(db).filter(a => a.startsAt === administrator.accessStartsAt && a.expiresAt === administrator.cohortExpiresAt).length;
    if (count >= UAT_COHORT_ACCOUNT_LIMIT) throw new UatAccountInputError("This test group's account limit has been reached, including revoked users.");
    const username = input.username.trim().toLowerCase();
    if (!usernamePattern.test(username)) throw new UatAccountInputError("Use 3–64 lowercase letters, numbers, dots, underscores or hyphens. Start with a letter.");
    if (!input.name.trim() || input.name.trim().length > 100) throw new UatAccountInputError("Enter a name of 1–100 characters.");
    if (input.password.length < 14 || input.password.length > 200) throw new UatAccountInputError("Use a unique password of 14–200 characters.");
    if (rows(db).some(account => account.username === username)) throw new UatAccountInputError("That username is already used. Choose a new one; revoked usernames cannot be reused.");
    const entityId = input.entityId?.trim() ?? "";
    if (input.role === "support" && entityId) throw new UatAccountInputError("Support users do not need a staff record.");
    if (input.role === "vendor" && !db.prepare("SELECT 1 FROM vendor_availability WHERE vendor_id=?").get(entityId)) throw new UatAccountInputError("Choose an existing vendor from the staff list.");
    if (input.role === "driver" && !db.prepare("SELECT 1 FROM driver_availability WHERE driver_id=?").get(entityId)) throw new UatAccountInputError("Choose an existing driver from the staff list.");
    const account = createUatAccountAt({...input, startsAt: administrator.accessStartsAt!}, actor.email, db, administrator.accessStartsAt!);
    // A slow password hash or concurrent deadline must never create usable access
    // after the original reviewer window. The transaction rolls back on failure.
    if (Date.now() >= administrator.cohortExpiresAt) throw new Error("This test period has ended.");
    return account;
  }).immediate();
}
export function revokeUatTeamAccount(username: string, actor: UatActor, database?: Database) {
  assertUatEnvironment();
  const db = database ?? getDatabase();
  return db.transaction(() => {
    const administrator = uatAdministrator(actor, db);
    const target = rows(db).find(a => a.username === username.trim().toLowerCase() && a.role !== "admin" &&
      a.startsAt === administrator.accessStartsAt && a.expiresAt === administrator.cohortExpiresAt);
    if (!target) throw new Error("Choose a staff test account from this test group.");
    revokeUatAccount(target.username, actor.email, db);
  }).immediate();
}
