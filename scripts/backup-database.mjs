import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const source = process.env.BUBBLEWASH_DATABASE_PATH;
const primaryDir = process.env.BUBBLEWASH_BACKUP_PRIMARY_DIR;
const offsiteDir = process.env.BUBBLEWASH_BACKUP_OFFSITE_DIR;
const statusPath = process.env.BUBBLEWASH_BACKUP_STATUS_PATH;
const key = Buffer.from(process.env.BUBBLEWASH_BACKUP_ENCRYPTION_KEY ?? "", "base64");
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== "--fresh-start")) throw new Error("Usage: backup-database.mjs [--fresh-start]");
const freshStart = args[0] === "--fresh-start";
const deferStatus = process.env.BUBBLEWASH_BACKUP_DEFER_STATUS === "true";
const primaryRetentionDays = parseRetentionDays("BUBBLEWASH_BACKUP_PRIMARY_RETENTION_DAYS", 7);
const stagingRetentionDays = parseRetentionDays("BUBBLEWASH_BACKUP_STAGING_RETENTION_DAYS", 2);

for (const [name, value] of Object.entries({ BUBBLEWASH_DATABASE_PATH: source, BUBBLEWASH_BACKUP_PRIMARY_DIR: primaryDir, BUBBLEWASH_BACKUP_OFFSITE_DIR: offsiteDir, BUBBLEWASH_BACKUP_STATUS_PATH: statusPath })) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
}
if (key.length !== 32) throw new Error("BUBBLEWASH_BACKUP_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
if (!existsSync(source)) throw new Error(`Database does not exist: ${source}`);
if (path.resolve(primaryDir) === path.resolve(offsiteDir)) throw new Error("Primary and off-site backup directories must be different.");

if (freshStart && !deferStatus) throw new Error("Fresh-start backup requires deferred status until verified private off-host storage.");

const magic = Buffer.from("BWBACKUP1");
const stamp = new Date().toISOString().replaceAll(":", "-");
const filename = `bubblewash-${stamp}.sqlite.enc`;
const workDir = mkdtempSync(path.join(tmpdir(), "bubblewash-backup-"));
const plainPath = path.join(workDir, "snapshot.sqlite");
const restorePath = path.join(workDir, "restore-proof.sqlite");

function parseRetentionDays(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 365) throw new Error(`${name} must be an integer from 1 to 365.`);
  return value;
}

function encrypt(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([magic, iv, cipher.getAuthTag(), encrypted]);
}

function decrypt(encrypted) {
  if (!encrypted.subarray(0, magic.length).equals(magic)) throw new Error("Backup format marker is invalid.");
  const iv = encrypted.subarray(magic.length, magic.length + 12);
  const tag = encrypted.subarray(magic.length + 12, magic.length + 28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted.subarray(magic.length + 28)), decipher.final()]);
}

function verifyDatabase(file) {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (database.pragma("quick_check", { simple: true }) !== "ok") throw new Error("SQLite integrity check failed.");
  } finally {
    database.close();
  }
}

function prune(directory, retentionDays = 35) {
  const threshold = Date.now() - retentionDays * 24 * 60 * 60_000;
  for (const entry of readdirSync(directory)) {
    if (!/^bubblewash-\d{4}-\d{2}-\d{2}T.*\.sqlite\.enc$/.test(entry)) continue;
    const file = path.join(directory, entry);
    if (statSync(file).mtimeMs < threshold) unlinkSync(file);
  }
}

try {
  const live = new Database(source, { readonly: true, fileMustExist: true });
  try {
    if (freshStart) {
      const { inspectFreshReset, deletedTables, verifyStoppedRuntime } = await import("./reset-fresh-start.mjs");
      verifyStoppedRuntime(process.cwd());
      const inventory = inspectFreshReset(live, process.env, process.cwd());
      if ([...deletedTables, "staff_accounts"].some((table) => inventory.counts[table] > 0)) {
        throw new Error("Fresh-start backup refused: operational or nonadmin records remain.");
      }
    }
    await live.backup(plainPath);
  } finally {
    live.close();
  }
  if (freshStart) {
    // Compact only the disposable snapshot. Never alter the live database or
    // copy deleted SQLite free-page contents into the new encrypted archive.
    const snapshot = new Database(plainPath, { fileMustExist: true });
    try { snapshot.exec("VACUUM"); } finally { snapshot.close(); }
    const { inspectFreshReset, deletedTables, verifyStoppedRuntime } = await import("./reset-fresh-start.mjs");
    verifyStoppedRuntime(process.cwd());
    const snapshotDb = new Database(plainPath, { readonly: true, fileMustExist: true });
    try {
      const inventory = inspectFreshReset(snapshotDb, { ...process.env, BUBBLEWASH_DATABASE_PATH: plainPath }, process.cwd());
      if ([...deletedTables, "staff_accounts"].some((table) => inventory.counts[table] > 0)) throw new Error("Fresh-start snapshot contains operational data.");
    } finally { snapshotDb.close(); }
  }
  verifyDatabase(plainPath);
  const encrypted = encrypt(readFileSync(plainPath));
  mkdirSync(primaryDir, { recursive: true });
  mkdirSync(offsiteDir, { recursive: true });
  const primaryPath = path.join(primaryDir, filename);
  const offsitePath = path.join(offsiteDir, filename);
  writeFileSync(primaryPath, encrypted, { flag: "wx", mode: 0o600 });
  writeFileSync(offsitePath, encrypted, { flag: "wx", mode: 0o600 });
  const primaryHash = createHash("sha256").update(readFileSync(primaryPath)).digest("hex");
  const offsiteHash = createHash("sha256").update(readFileSync(offsitePath)).digest("hex");
  if (primaryHash !== offsiteHash) throw new Error("Primary and off-site backup hashes do not match.");
  writeFileSync(restorePath, decrypt(readFileSync(offsitePath)), { flag: "wx", mode: 0o600 });
  verifyDatabase(restorePath);
  const result = { ok: true, createdAt: new Date().toISOString(), restoreVerifiedAt: new Date().toISOString(), filename, sha256: offsiteHash };
  mkdirSync(path.dirname(statusPath), { recursive: true });
  const destinationStatus = deferStatus ? `${statusPath}.${filename}.pending` : statusPath;
  const temporaryStatus = `${destinationStatus}.${process.pid}.tmp`;
  writeFileSync(temporaryStatus, JSON.stringify(result), { flag: "wx", mode: 0o600 });
  renameSync(temporaryStatus, destinationStatus);
  if (!freshStart) {
    prune(primaryDir, primaryRetentionDays);
    prune(offsiteDir, stagingRetentionDays);
  }
  console.log(JSON.stringify(result));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

