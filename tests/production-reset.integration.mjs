import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "bubblewash-production-reset-"));
const databasePath = path.join(fixtureDir, "bubblewash.sqlite");
const backupStatusPath = path.join(fixtureDir, "backup-status.json");
const resetId = "production-launch-2026-08-29";

try {
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE submissions (id TEXT PRIMARY KEY);
    CREATE TABLE rate_limits (key TEXT PRIMARY KEY);
    CREATE TABLE workflow_action_claims (claim_key TEXT PRIMARY KEY);
    CREATE TABLE payment_verifications (reference TEXT PRIMARY KEY);
    CREATE TABLE driver_live_locations (driver_id TEXT PRIMARY KEY);
    CREATE TABLE early_access_signups (id TEXT PRIMARY KEY);
    CREATE TABLE privacy_requests (id TEXT PRIMARY KEY);
    CREATE TABLE notification_outbox (id TEXT PRIMARY KEY);
    CREATE TABLE delivery_proofs (order_id TEXT PRIMARY KEY);
    CREATE TABLE mfa_replay_guard (subject TEXT PRIMARY KEY);
    CREATE TABLE admin_mfa_settings (admin_email TEXT PRIMARY KEY);
    CREATE TABLE admin_mfa_recovery_codes (code_hash TEXT PRIMARY KEY);
    CREATE TABLE staff_credential_overrides (role TEXT PRIMARY KEY);
    CREATE TABLE admin_recovery_tokens (token_hash TEXT PRIMARY KEY);
  `);
  for (const table of [
    "submissions", "early_access_signups", "privacy_requests", "notification_outbox", "delivery_proofs",
  ]) database.prepare(`INSERT INTO ${table} VALUES ('fixture')`).run();
  database.prepare("INSERT INTO rate_limits VALUES ('fixture')").run();
  database.prepare("INSERT INTO workflow_action_claims VALUES ('fixture')").run();
  database.prepare("INSERT INTO payment_verifications VALUES ('fixture')").run();
  database.prepare("INSERT INTO driver_live_locations VALUES ('fixture')").run();
  database.prepare("INSERT INTO mfa_replay_guard VALUES ('fixture')").run();
  database.prepare("INSERT INTO admin_mfa_settings VALUES ('fixture')").run();
  database.prepare("INSERT INTO admin_mfa_recovery_codes VALUES ('fixture')").run();
  database.prepare("INSERT INTO staff_credential_overrides VALUES ('admin')").run();
  database.prepare("INSERT INTO admin_recovery_tokens VALUES ('fixture')").run();
  database.close();

  const timestamp = new Date().toISOString();
  writeFileSync(backupStatusPath, JSON.stringify({
    ok: true,
    createdAt: timestamp,
    restoreVerifiedAt: timestamp,
    offsiteStoredAt: timestamp,
    filename: "bubblewash-2026-08-29T12-00-00-000Z.sqlite.enc",
    sha256: "a".repeat(64),
  }));
  const environment = {
    ...process.env,
    BUBBLEWASH_DATABASE_PATH: databasePath,
    BUBBLEWASH_BACKUP_STATUS_PATH: backupStatusPath,
    BUBBLEWASH_PRODUCTION_RESET_ID: resetId,
    BUBBLEWASH_ALLOW_PRODUCTION_RESET: resetId,
  };
  const refused = spawnSync(process.execPath, ["scripts/reset-production-data.mjs"], {
    cwd: process.cwd(),
    env: { ...environment, BUBBLEWASH_ALLOW_PRODUCTION_RESET: "not-approved" },
    encoding: "utf8",
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /explicit reset confirmation/);
  const runReset = () => JSON.parse(execFileSync(process.execPath, ["scripts/reset-production-data.mjs"], {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
  }));

  const first = runReset();
  assert.equal(first.ok, true);
  assert.equal(first.alreadyApplied, false);
  assert.ok(Object.values(first.before).every((count) => count === 1));
  assert.ok(Object.values(first.after).every((count) => count === 0));
  assert.ok(Object.values(first.preserved).every((count) => count === 1));

  const verify = new Database(databasePath);
  verify.prepare("INSERT INTO submissions VALUES ('real-order-after-launch')").run();
  verify.close();
  const second = runReset();
  assert.equal(second.alreadyApplied, true);
  assert.equal(second.after.submissions, 1, "a retry must not delete post-launch records");

  console.log(JSON.stringify({ ok: true, checks: 10 }));
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}
