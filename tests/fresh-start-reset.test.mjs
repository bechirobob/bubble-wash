import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCipheriv, randomBytes } from "node:crypto";
import { inspectFreshReset, applyFreshReset, verifyStoppedRuntime, deletedTables } from "../scripts/reset-fresh-start.mjs";
import { createPasswordHash, verifyPasswordHash } from "../src/lib/passwords.ts";
import { resolveStaffUsers } from "../src/lib/staff-identity.ts";
import { productionReadinessErrors } from "../src/lib/security.ts";

const password = "Synthetic owner password only!984";
const hash = createPasswordHash(password);
const totp = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
function fixture(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), "bubblewash-reset-synthetic-"));
  const dbPath = path.join(cwd, "synthetic.sqlite");
  const db = new Database(dbPath);
  t.after(() => db.close());
  db.pragma("foreign_keys = ON");
  for (const file of ["data-store.ts", "availability-store.ts", "operational-store.ts", "staff-accounts.ts"]) {
    const source = readFileSync(new URL(`../src/lib/${file}`, import.meta.url), "utf8");
    const schema = source.match(/(?:db|database)\.exec\(`([\s\S]*?)`\)/)?.[1];
    assert.ok(schema && !schema.includes("${"));
    db.exec(schema);
  }
  for (const file of ["payments/initialize", "customer/recover"]) {
    const source = readFileSync(new URL(`../src/app/api/${file}/route.ts`, import.meta.url), "utf8");
    const schema = source.match(/db\.exec\("(CREATE TABLE IF NOT EXISTS [^"]+)"\)/)?.[1];
    assert.ok(schema);
    db.exec(schema);
  }
  db.prepare("INSERT INTO payment_initialization_locks VALUES (?, ?)").run("synthetic-order", "now");
  db.prepare("INSERT INTO customer_recovery VALUES (?, ?, ?, NULL)").run("synthetic-customer-token-hash", "customer@example.test", "2099-01-01");
  const env = { NODE_ENV: "production", BUBBLEWASH_DISABLE_DEMO_LOGIN: "true", BUBBLEWASH_DATABASE_DRIVER: "sqlite", BUBBLEWASH_DATABASE_PATH: dbPath,
    BUBBLEWASH_SESSION_SECRET: "synthetic-session-only-32-chars-minimum", BUBBLEWASH_MFA_ENCRYPTION_KEY: randomBytes(32).toString("base64"), BUBBLEWASH_ADMIN_MFA_REQUIRED: "true", NEXT_PUBLIC_BUBBLEWASH_ADMIN_MFA_REQUIRED: "true",
    BUBBLEWASH_CONFIRM_FRESH_RESET: "DELETE_ALL_NONADMIN_OPERATIONAL_DATA_WITHOUT_NEW_BACKUP" };
  const addStaff = (email, role = "admin", status = "active", passwordHash = hash) => db.prepare("INSERT INTO staff_accounts VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?)").run(email, "Synthetic test", role, role === "admin" ? "" : "synthetic-roster", passwordHash, `version-${email}`, status, "2026-10-20T00:00:00Z");
  addStaff("owner@example.test");
  addStaff("worker@example.test", "vendor");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(env.BUBBLEWASH_MFA_ENCRYPTION_KEY, "base64"), nonce);
  const encrypted = Buffer.concat([cipher.update(totp), cipher.final()]);
  const secret = ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
  db.prepare("INSERT INTO admin_mfa_settings VALUES (?, ?, 'enrolled', NULL, NULL, ?, ?)").run("owner@example.test", secret, "now", "now");
  db.prepare("INSERT INTO admin_mfa_recovery_codes VALUES (?, ?, ?, NULL)").run("owner@example.test", "synthetic-recovery-hash", "now");
  db.prepare("INSERT INTO mfa_replay_guard VALUES (?, ?, ?)").run("owner@example.test", 123, "now");
  db.prepare("INSERT INTO submissions VALUES (?, ?, ?, ?)").run("synthetic-order", "now", "test", '{"submissionType":"pickup-booking","name":"Synthetic Customer"}');
  db.prepare("INSERT INTO payment_verifications VALUES (?, ?, NULL, ?, ?, ?, ?)").run("synthetic-payment", "success", 100, "GHS", "synthetic-order", "now");
  db.prepare("INSERT INTO notification_outbox VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)").run("test", "test", "email", "customer", '{"synthetic":true}', "pending", 0, "now", "now", "now");
  return { db, env, cwd, addStaff };
}
function managed(db) { return db.prepare("SELECT email, name, role, entity_id AS entityId, password_hash AS passwordHash, credential_version AS credentialVersion, status FROM staff_accounts").all(); }

test("fresh reset deletes operations/nonadmins/customer recovery/payment locks and preserves usable admin password, encrypted MFA and security rows", (t) => {
  const { db, env, cwd } = fixture(t);
  const before = inspectFreshReset(db, env, cwd);
  const mfaBefore = db.prepare("SELECT * FROM admin_mfa_settings").all();
  let checks = 0;
  const result = applyFreshReset(db, env, cwd, before.fingerprint, () => checks++);
  assert.equal(checks, 2);
  assert.equal(result.requiresPostRestartVerification, true);
  for (const table of deletedTables) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  assert.equal(managed(db).length, 1);
  assert.equal(verifyPasswordHash(password, managed(db)[0].passwordHash), true);
  assert.deepEqual(db.prepare("SELECT * FROM admin_mfa_settings").all(), mfaBefore);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM admin_mfa_recovery_codes").get().n, 1);
  assert.equal(db.prepare("SELECT timestep FROM mfa_replay_guard").get().timestep, 123);
  assert.equal(inspectFreshReset(db, env, cwd).ownerAccessConfigured, true);
  // Even a still-configured old worker environment cannot resurrect the account.
  const legacy = { ...env, BUBBLEWASH_VENDOR_EMAIL: "worker@example.test", BUBBLEWASH_VENDOR_PASSWORD_HASH: hash, BUBBLEWASH_VENDOR_ENTITY_ID: "synthetic-roster" };
  assert.equal(resolveStaffUsers(legacy, null, managed(db)).some((u) => u.role !== "admin"), false);
});

test("managed admin readiness works with empty worker roster, and blocks missing effective owner", (t) => {
  const { db, env } = fixture(t);
  Object.assign(env, { BUBBLEWASH_PUBLIC_URL: "https://example.test", BUBBLEWASH_BACKUP_ENCRYPTION_KEY: randomBytes(32).toString("base64"), BUBBLEWASH_BACKUP_PRIMARY_DIR: "/synthetic/primary", BUBBLEWASH_BACKUP_OFFSITE_DIR: "/synthetic/offsite", BUBBLEWASH_BACKUP_STATUS_PATH: "/synthetic/status", BUBBLEWASH_TRUST_EDGE_HEADERS: "true" });
  db.prepare("DELETE FROM staff_accounts WHERE role != 'admin'").run();
  assert.deepEqual(productionReadinessErrors(env, resolveStaffUsers(env, null, managed(db))), []);
  assert.match(productionReadinessErrors(env, [])[0], /effective active admin/);
});

for (const [name, mutate, expected] of [
  ["suspended managed admin shadows environment admin", (f) => { f.db.prepare("UPDATE staff_accounts SET status = 'suspended' WHERE role='admin'").run(); f.env.BUBBLEWASH_ADMIN_EMAIL = "owner@example.test"; f.env.BUBBLEWASH_ADMIN_PASSWORD_HASH = hash; }, /no effective admin/],
  ["suspended managed admin shadows override", (f) => { f.db.prepare("UPDATE staff_accounts SET status='suspended' WHERE role='admin'").run(); f.db.prepare("INSERT INTO staff_credential_overrides VALUES ('admin', ?, ?, ?, ?)").run("owner@example.test", hash, "override-v", "now"); }, /no effective admin/],
  ["malformed admin hash", (f) => f.db.prepare("UPDATE staff_accounts SET password_hash='scrypt$salt$not-a-hash' WHERE role='admin'").run(), /no effective admin/],
  ["known demo admin hash", (f) => f.db.prepare("UPDATE staff_accounts SET password_hash=? WHERE role='admin'").run(createPasswordHash("Admin123!")), /no effective admin/],
  ["disabled staff access", (f) => { f.env.BUBBLEWASH_STAFF_AUTH_DISABLED = "true"; }, /no effective admin/],
  ["malformed but decodable MFA key", (f) => { f.env.BUBBLEWASH_MFA_ENCRYPTION_KEY += "!"; }, /no effective admin/],
  ["wrong MFA decryption key", (f) => { f.env.BUBBLEWASH_MFA_ENCRYPTION_KEY = randomBytes(32).toString("base64"); }, /no effective admin/],
  ["legacy credentials present", (f) => { f.env.BUBBLEWASH_DRIVER_EMAIL = "legacy@example.test"; }, /legacy worker/],
  ["nonproduction demo fallback", (f) => { f.env.NODE_ENV = "development"; }, /production mode/],
  ["legacy import file", (f) => { mkdirSync(path.join(f.cwd, "data")); writeFileSync(path.join(f.cwd, "data/submissions.jsonl"), "{}"); }, /repopulate/],
  ["unknown table", (f) => f.db.exec("CREATE TABLE unreviewed(id TEXT)"), /unreviewed table/],
  ["unknown trigger", (f) => f.db.exec("CREATE TRIGGER unsafe AFTER DELETE ON submissions BEGIN DELETE FROM staff_accounts; END"), /trigger/],
]) test(`fresh reset fails closed: ${name}`, (t) => {
  const f = fixture(t); mutate(f);
  assert.throws(() => inspectFreshReset(f.db, f.env, f.cwd), expected);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM submissions").get().n, 1);
});

test("stale inventory, missing confirmation and lifecycle failures never delete data", (t) => {
  const { db, env, cwd } = fixture(t);
  const before = inspectFreshReset(db, env, cwd);
  assert.throws(() => applyFreshReset(db, { ...env, BUBBLEWASH_CONFIRM_FRESH_RESET: "" }, cwd, before.fingerprint, () => {}), /confirmation/);
  assert.throws(() => applyFreshReset(db, env, cwd, before.fingerprint, () => { throw Error("service still active"); }), /service still active/);
  db.prepare("UPDATE submissions SET source='changed'").run();
  assert.throws(() => applyFreshReset(db, env, cwd, before.fingerprint, () => {}), /changed after review/);
  let calls = 0;
  assert.throws(() => applyFreshReset(db, env, cwd, inspectFreshReset(db, env, cwd).fingerprint, () => { if (++calls === 2) throw Error("runtime restarted"); }), /runtime restarted/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM submissions").get().n, 1);
  assert.equal(managed(db).length, 2);
});

test("reset refuses accidental revival of an admin shadowed by a deleted worker", (t) => {
  const { db, env, cwd } = fixture(t);
  env.BUBBLEWASH_ADMIN_EMAIL = "worker@example.test";
  env.BUBBLEWASH_ADMIN_PASSWORD_HASH = hash;
  const plan = inspectFreshReset(db, env, cwd);
  assert.throws(() => applyFreshReset(db, env, cwd, plan.fingerprint, () => {}), /effective admin identities changed/);
  assert.equal(managed(db).length, 2);
});

test("runtime precondition checks actual unit state, working directory and service environment", (t) => {
  const { cwd, env } = fixture(t);
  const envFile = path.join(cwd, "synthetic.env");
  writeFileSync(envFile, Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n"));
  const stopped = `LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nWorkingDirectory=${cwd}\nEnvironmentFiles=${envFile} (ignore_errors=no)\n`;
  const calls = [];
  verifyStoppedRuntime(cwd, (command, args) => { calls.push([command, args]); return stopped; }, env);
  assert.equal(calls.length, 3);
  assert.ok(calls[0][1].includes("--user"));
  assert.equal(calls[1][1].includes("--user"), false);
  for (const response of [stopped.replace("inactive", "active"), stopped.replace("MainPID=0", "MainPID=123"), stopped.replace("loaded", "not-found"), stopped.replace(`WorkingDirectory=${cwd}`, "WorkingDirectory=/tmp")]) {
    assert.throws(() => verifyStoppedRuntime(cwd, () => response, env));
  }
  assert.throws(() => verifyStoppedRuntime(cwd, () => { throw Error("no systemd"); }, env), /cannot verify/);
  writeFileSync(envFile, "BUBBLEWASH_DRIVER_EMAIL=stale@example.test\n");
  assert.throws(() => verifyStoppedRuntime(cwd, () => stopped, env), /environment do not match/);
});

test("CLI inventory opens existing database read-only and never discloses authentication material", (t) => {
  const { db, env, cwd } = fixture(t);
  const before = readFileSync(env.BUBBLEWASH_DATABASE_PATH);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/reset-fresh-start.mjs", import.meta.url))], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(output.counts.submissions, 1);
  assert.equal(output.ownerAccessConfigured, true);
  assert.equal(result.stdout.includes(hash), false);
  assert.equal(result.stdout.includes("owner@example.test"), false);
  assert.deepEqual(readFileSync(env.BUBBLEWASH_DATABASE_PATH), before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM submissions").get().n, 1);
});
