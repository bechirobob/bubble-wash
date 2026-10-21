import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const filename = "bubblewash-2026-08-26T01-15-00.000Z.sqlite.enc";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "bubblewash-finalize-test-"));
  const stagingDir = path.join(root, "staging");
  const statusPath = path.join(root, "runtime", "backup-status.json");
  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(path.dirname(statusPath), { recursive: true });
  const encrypted = Buffer.from("encrypted-backup-fixture");
  writeFileSync(path.join(stagingDir, filename), encrypted);
  const pending = {
    ok: true,
    createdAt: "2026-08-26T01:15:00.000Z",
    restoreVerifiedAt: "2026-08-26T01:15:01.000Z",
    filename,
    sha256: createHash("sha256").update(encrypted).digest("hex"),
  };
  const pendingPath = `${statusPath}.${filename}.pending`;
  writeFileSync(pendingPath, JSON.stringify(pending));
  const receiptPath = path.join(root, "offhost-release.json");
  const receipt = { schema: "becore-encrypted-backup-release/v2", repository: "bechirobob/bubble-wash", storageRepository: "bechirobob/becore-backups", storage: "private-github-release", encrypted: true, restoreTested: true, downloadVerified: true, filename, sha256: pending.sha256, size: encrypted.length, storageRepositoryId: 123, storageSha: "a".repeat(40), sourceSha: "b".repeat(40), verifiedAt: "2026-08-26T01:15:02.000Z" };
  writeFileSync(receiptPath, JSON.stringify(receipt));
  return { root, stagingDir, statusPath, pendingPath, receiptPath, receipt };
}

test("finalizes readiness only after the workflow confirms off-host storage", () => {
  const files = fixture();
  try {
    const result = spawnSync(process.execPath, ["scripts/finalize-backup.mjs", filename, files.receiptPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        BUBBLEWASH_BACKUP_STATUS_PATH: files.statusPath,
        BUBBLEWASH_BACKUP_OFFSITE_DIR: files.stagingDir,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(readFileSync(files.statusPath, "utf8"));
    assert.equal(status.ok, true);
    assert.equal(status.filename, filename);
    assert.match(status.offsiteStoredAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(existsSync(files.pendingPath), false);
  } finally {
    rmSync(files.root, { recursive: true, force: true });
  }
});

test("rejects a staged file that no longer matches the restore proof", () => {
  const files = fixture();
  try {
    writeFileSync(path.join(files.stagingDir, filename), "tampered");
    const result = spawnSync(process.execPath, ["scripts/finalize-backup.mjs", filename, files.receiptPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        BUBBLEWASH_BACKUP_STATUS_PATH: files.statusPath,
        BUBBLEWASH_BACKUP_OFFSITE_DIR: files.stagingDir,
      },
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(files.statusPath), false);
    assert.equal(existsSync(files.pendingPath), true);
  } finally {
    rmSync(files.root, { recursive: true, force: true });
  }
});

for (const [label, change] of [
  ["wrong repository", (r) => { r.repository = "other/project"; }],
  ["wrong digest", (r) => { r.sha256 = "a".repeat(64); }],
  ["wrong size", (r) => { r.size++; }],
  ["missing download proof", (r) => { r.downloadVerified = false; }],
  ["stale receipt", (r) => { r.verifiedAt = "2026-01-01T00:00:00Z"; }],
  ["wrong destination", (r) => { r.storageRepository = "other/backups"; }],
]) test(`refuses ${label} without changing readiness or pending proof`, () => {
  const files = fixture();
  try {
    change(files.receipt);
    writeFileSync(files.receiptPath, JSON.stringify(files.receipt));
    const result = spawnSync(process.execPath, ["scripts/finalize-backup.mjs", filename, files.receiptPath], {
      encoding: "utf8", env: { ...process.env, BUBBLEWASH_BACKUP_STATUS_PATH: files.statusPath, BUBBLEWASH_BACKUP_OFFSITE_DIR: files.stagingDir },
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(files.statusPath), false);
    assert.equal(existsSync(files.pendingPath), true);
  } finally { rmSync(files.root, { recursive: true, force: true }); }
});

test("second-resolution transport receipt cannot make readiness older than restore verification", () => {
  const files = fixture();
  try {
    const pending = JSON.parse(readFileSync(files.pendingPath, "utf8"));
    pending.restoreVerifiedAt = "2026-08-26T01:15:02.600Z";
    writeFileSync(files.pendingPath, JSON.stringify(pending));
    const result = spawnSync(process.execPath, ["scripts/finalize-backup.mjs", filename, files.receiptPath], {
      encoding: "utf8", env: { ...process.env, BUBBLEWASH_BACKUP_STATUS_PATH: files.statusPath, BUBBLEWASH_BACKUP_OFFSITE_DIR: files.stagingDir },
    });
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(readFileSync(files.statusPath, "utf8"));
    assert.ok(Date.parse(status.offsiteStoredAt) >= Date.parse(status.restoreVerifiedAt));
  } finally { rmSync(files.root, { recursive: true, force: true }); }
});

for (const value of [undefined, "relative.json", "/nonexistent/synthetic-receipt.json"]) test(`missing/unusable receipt ${value} preserves existing readiness`, () => {
  const files = fixture();
  try {
    writeFileSync(files.statusPath, "existing readiness bytes");
    const result = spawnSync(process.execPath, ["scripts/finalize-backup.mjs", filename, ...(value ? [value] : [])], {
      encoding: "utf8", env: { ...process.env, BUBBLEWASH_BACKUP_STATUS_PATH: files.statusPath, BUBBLEWASH_BACKUP_OFFSITE_DIR: files.stagingDir },
    });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(files.statusPath, "utf8"), "existing readiness bytes");
    assert.ok(existsSync(files.pendingPath));
  } finally { rmSync(files.root, { recursive: true, force: true }); }
});
