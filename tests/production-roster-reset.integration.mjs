import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "bubblewash-roster-reset-"));
const databasePath = path.join(fixtureDir, "bubblewash.sqlite");
const backupStatusPath = path.join(fixtureDir, "backup-status.json");
const resetId = "production-roster-reset-2026-08-29";

const rosterTables = [
  "vendor_availability",
  "driver_availability",
  "vendor_declines",
  "assignment_capacity_reservations",
];
const preservedTables = [
  "submissions",
  "early_access_signups",
  "privacy_requests",
  "notification_outbox",
  "staff_credential_overrides",
  "admin_mfa_settings",
  "admin_mfa_recovery_codes",
  "admin_recovery_tokens",
  "mfa_replay_guard",
  "production_resets",
];

try {
  const database = new Database(databasePath);
  for (const table of [...rosterTables, ...preservedTables]) {
    database.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
    database.prepare(`INSERT INTO ${table} VALUES ('fixture')`).run();
  }
  database.close();

  const timestamp = new Date().toISOString();
  writeFileSync(backupStatusPath, JSON.stringify({
    ok: true,
    createdAt: timestamp,
    restoreVerifiedAt: timestamp,
    offsiteStoredAt: timestamp,
    filename: "bubblewash-2026-08-29T18-00-00-000Z.sqlite.enc",
    sha256: "b".repeat(64),
  }));
  const environment = {
    ...process.env,
    BUBBLEWASH_DATABASE_PATH: databasePath,
    BUBBLEWASH_BACKUP_STATUS_PATH: backupStatusPath,
    BUBBLEWASH_PRODUCTION_ROSTER_RESET_ID: resetId,
    BUBBLEWASH_ALLOW_PRODUCTION_ROSTER_RESET: resetId,
  };
  const refused = spawnSync(process.execPath, ["scripts/reset-production-roster.mjs"], {
    cwd: process.cwd(),
    env: { ...environment, BUBBLEWASH_ALLOW_PRODUCTION_ROSTER_RESET: "not-approved" },
    encoding: "utf8",
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /explicit roster-reset confirmation/);
  const runReset = () => JSON.parse(execFileSync(process.execPath, ["scripts/reset-production-roster.mjs"], {
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
  verify.prepare("INSERT INTO vendor_availability VALUES ('real-vendor-after-reset')").run();
  assert.ok(preservedTables.every((table) => verify.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total === 1));
  verify.close();
  const second = runReset();
  assert.equal(second.alreadyApplied, true);
  assert.equal(second.after.vendor_availability, 1, "a retry must not delete post-reset vendors");

  console.log(JSON.stringify({ ok: true, checks: 11 }));
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}
