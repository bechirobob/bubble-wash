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
  return { root, stagingDir, statusPath, pendingPath };
}

test("finalizes readiness only after the workflow confirms off-host storage", () => {
  const files = fixture();
  try {
    const result = spawnSync(process.execPath, ["scripts/finalize-backup.mjs", filename], {
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
    const result = spawnSync(process.execPath, ["scripts/finalize-backup.mjs", filename], {
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
