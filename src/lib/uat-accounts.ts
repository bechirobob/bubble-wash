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
export function currentUatUsers(database?: Database, now = Date.now()): StaffUser[] {
  // An unsafe or disabled environment cannot authenticate temporary identities.
  try { assertUatEnvironment(); } catch { return []; }
  const db = database ?? getDatabase();
  const accounts = rows(db);
  // Authorization uses the deadline itself, not this audit housekeeping. Even
  // without a scheduler, the first post-deadline request is denied immediately.
  const expired = accounts.filter(a => a.status === "active" && now >= a.expiresAt);
  if (expired.length && !db.readonly) db.transaction(() => {
    for (const a of expired) {
      const changed = db.prepare("UPDATE staff_uat_accounts SET status='expired', password_hash='', credential_version=? WHERE username=? AND status='active'").run(randomUUID(), a.username).changes;
      if (changed) audit(db, a.username, "expired", "system:deadline", a.startsAt, a.expiresAt);
    }
  }).immediate();
  return accounts.filter(a => a.status === "active" && usernamePattern.test(a.username) &&
    Number.isSafeInteger(a.startsAt) && Number.isSafeInteger(a.expiresAt) && a.expiresAt - a.startsAt === UAT_WINDOW_MS &&
    now >= a.startsAt && now < a.expiresAt && validPasswordHash(a.passwordHash) && !matchesKnownDemoPassword(a.passwordHash) &&
    ["admin", "vendor", "driver", "support"].includes(a.role) && (!(a.role === "vendor" || a.role === "driver") || Boolean(a.entityId)))
    .map(a => ({ name: a.name, email: a.username, username: a.username, role: a.role, entityId: a.entityId || undefined,
      passwordHash: a.passwordHash, credentialVersion: a.credentialVersion, temporaryAccess: true,
      accessStartsAt: a.startsAt, accessExpiresAt: a.expiresAt, allStaffAccess: false }));
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

export const UAT_COHORT_ACCOUNT_LIMIT = 20;
type UatActor = { email: string; role: string; temporaryAccess?: boolean };
function uatAdministrator(actor: UatActor, database: Database) {
  assertUatEnvironment();
  if (actor.role !== "admin" || !actor.temporaryAccess) throw new Error("UAT administrator access is required.");
  const administrator = currentUatUsers(database).find(user => user.email === actor.email && user.role === "admin");
  if (!administrator?.temporaryAccess || !administrator.accessStartsAt || !administrator.accessExpiresAt) throw new Error("UAT administrator access is unavailable.");
  return administrator;
}
export function listUatTeam(actor: UatActor, database?: Database) {
  assertUatEnvironment();
  const db = database ?? getDatabase();
  const administrator = uatAdministrator(actor, db);
  const accounts = rows(db).filter(a => a.startsAt === administrator.accessStartsAt && a.expiresAt === administrator.accessExpiresAt);
  return { expiresAt: administrator.accessExpiresAt, limit: UAT_COHORT_ACCOUNT_LIMIT, remaining: Math.max(0, UAT_COHORT_ACCOUNT_LIMIT - accounts.length),
    accounts: accounts.filter(a => a.role !== "admin").map(({username,name,role,entityId,status}) => ({username,name,role,entityId,status})) };
}
export function createUatTeamAccount(input: Omit<UatAccountInput, "startsAt">, actor: UatActor, database?: Database) {
  assertUatEnvironment();
  if (!["vendor", "driver", "support"].includes(input.role)) throw new Error("Choose Vendor, Driver or Support test access.");
  const db = database ?? getDatabase();
  return db.transaction(() => {
    const administrator = uatAdministrator(actor, db);
    const count = rows(db).filter(a => a.startsAt === administrator.accessStartsAt && a.expiresAt === administrator.accessExpiresAt).length;
    if (count >= UAT_COHORT_ACCOUNT_LIMIT) throw new Error("This test group's account limit has been reached.");
    const account = createUatAccountAt({...input, startsAt: administrator.accessStartsAt!}, actor.email, db, administrator.accessStartsAt!);
    // A slow password hash or concurrent deadline must never create usable access
    // after the original reviewer window. The transaction rolls back on failure.
    if (Date.now() >= administrator.accessExpiresAt!) throw new Error("This test period has ended.");
    return account;
  }).immediate();
}
export function revokeUatTeamAccount(username: string, actor: UatActor, database?: Database) {
  assertUatEnvironment();
  const db = database ?? getDatabase();
  return db.transaction(() => {
    const administrator = uatAdministrator(actor, db);
    const target = rows(db).find(a => a.username === username.trim().toLowerCase() && a.role !== "admin" &&
      a.startsAt === administrator.accessStartsAt && a.expiresAt === administrator.accessExpiresAt);
    if (!target) throw new Error("Choose a staff test account from this test group.");
    revokeUatAccount(target.username, actor.email, db);
  }).immediate();
}
