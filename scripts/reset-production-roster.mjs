import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";

const rosterTables = [
  "assignment_capacity_reservations",
  "vendor_declines",
  "vendor_availability",
  "driver_availability",
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

const databasePath = process.env.BUBBLEWASH_DATABASE_PATH;
const backupStatusPath = process.env.BUBBLEWASH_BACKUP_STATUS_PATH;
const resetId = process.env.BUBBLEWASH_PRODUCTION_ROSTER_RESET_ID;
const resetConfirmation = process.env.BUBBLEWASH_ALLOW_PRODUCTION_ROSTER_RESET;
const maximumBackupAgeMs = 30 * 60_000;

function fail(message) {
  throw new Error(`Production roster reset refused: ${message}`);
}

for (const [name, value] of Object.entries({
  BUBBLEWASH_DATABASE_PATH: databasePath,
  BUBBLEWASH_BACKUP_STATUS_PATH: backupStatusPath,
})) {
  if (!value || !path.isAbsolute(value)) fail(`${name} must be an absolute path.`);
}
if (!resetId || !/^production-roster-reset-\d{4}-\d{2}-\d{2}$/.test(resetId)) {
  fail("BUBBLEWASH_PRODUCTION_ROSTER_RESET_ID must identify the dated roster reset.");
}
if (resetConfirmation !== resetId) fail("the explicit roster-reset confirmation does not match the reset ID.");

const backupStatus = JSON.parse(readFileSync(backupStatusPath, "utf8"));
for (const field of ["createdAt", "restoreVerifiedAt", "offsiteStoredAt", "filename", "sha256"]) {
  if (typeof backupStatus[field] !== "string" || !backupStatus[field]) fail(`backup proof is missing ${field}.`);
}
if (backupStatus.ok !== true) fail("the latest encrypted backup is not healthy.");
if (!/^bubblewash-\d{4}-\d{2}-\d{2}T.*\.sqlite\.enc$/.test(backupStatus.filename)) {
  fail("the latest encrypted-backup filename is invalid.");
}
if (!/^[0-9a-f]{64}$/.test(backupStatus.sha256)) fail("the latest encrypted-backup hash is invalid.");
const proofTimes = [backupStatus.createdAt, backupStatus.restoreVerifiedAt, backupStatus.offsiteStoredAt]
  .map((value) => Date.parse(value));
if (proofTimes.some((value) => !Number.isFinite(value))) fail("the backup proof contains an invalid timestamp.");
const now = Date.now();
if (proofTimes.some((value) => value > now + 60_000)) fail("the backup proof contains a future timestamp.");
if (now - Math.min(...proofTimes) > maximumBackupAgeMs) fail("the encrypted off-site backup is older than 30 minutes.");

const database = new Database(databasePath);
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");
database.pragma("busy_timeout = 5000");
database.exec(`
  CREATE TABLE IF NOT EXISTS production_roster_resets (
    reset_id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL,
    backup_filename TEXT NOT NULL,
    backup_sha256 TEXT NOT NULL,
    before_counts TEXT NOT NULL CHECK (json_valid(before_counts)),
    after_counts TEXT NOT NULL CHECK (json_valid(after_counts)),
    preserved_counts TEXT NOT NULL CHECK (json_valid(preserved_counts))
  );
`);

function quickCheck() {
  const rows = database.pragma("quick_check");
  if (rows.length !== 1 || rows[0]?.quick_check !== "ok") fail("SQLite quick_check did not pass.");
}

function countsFor(tables) {
  return Object.fromEntries(tables.map((table) => {
    const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
    return [table, Number(row.total)];
  }));
}

try {
  quickCheck();
  const existing = database.prepare("SELECT applied_at, before_counts FROM production_roster_resets WHERE reset_id = ?").get(resetId);
  if (existing) {
    console.log(JSON.stringify({
      ok: true,
      alreadyApplied: true,
      resetId,
      appliedAt: existing.applied_at,
      before: JSON.parse(existing.before_counts),
      after: countsFor(rosterTables),
      preserved: countsFor(preservedTables),
    }));
    process.exit(0);
  }

  const reset = database.transaction(() => {
    const before = countsFor(rosterTables);
    const preserved = countsFor(preservedTables);
    for (const table of rosterTables) database.prepare(`DELETE FROM ${table}`).run();
    const after = countsFor(rosterTables);
    if (Object.values(after).some((count) => count !== 0)) fail("one or more roster tables are not empty after deletion.");
    const preservedAfter = countsFor(preservedTables);
    if (JSON.stringify(preservedAfter) !== JSON.stringify(preserved)) fail("a preserved production table changed during the roster reset.");

    const appliedAt = new Date().toISOString();
    database.prepare(`
      INSERT INTO production_roster_resets (
        reset_id, applied_at, backup_filename, backup_sha256, before_counts, after_counts, preserved_counts
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      resetId,
      appliedAt,
      backupStatus.filename,
      backupStatus.sha256,
      JSON.stringify(before),
      JSON.stringify(after),
      JSON.stringify(preserved),
    );
    return { appliedAt, before, after, preserved };
  });

  const result = reset.immediate();
  quickCheck();
  database.pragma("wal_checkpoint(TRUNCATE)");
  console.log(JSON.stringify({ ok: true, alreadyApplied: false, resetId, backup: backupStatus.filename, ...result }));
} finally {
  database.close();
}
