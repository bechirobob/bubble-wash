import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createPasswordHash } from "../src/lib/passwords.ts";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "fresh-backup-synthetic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.sqlite");
  const db = new Database(source);
  for (const file of ["data-store.ts", "availability-store.ts", "operational-store.ts", "staff-accounts.ts"]) {
    const schema = readFileSync(new URL(`../src/lib/${file}`, import.meta.url), "utf8").match(/(?:db|database)\.exec\(`([\s\S]*?)`\)/)?.[1];
    assert.ok(schema && !schema.includes("${")); db.exec(schema);
  }
  db.prepare("INSERT INTO staff_accounts VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?)").run("owner@example.test", "Synthetic owner", "admin", "", createPasswordHash("Synthetic owner password 999!"), "v1", "active", "now");
  const key = randomBytes(32);
  const env = { ...process.env, NODE_ENV: "production", BUBBLEWASH_DISABLE_DEMO_LOGIN: "true", BUBBLEWASH_DATABASE_DRIVER: "sqlite", BUBBLEWASH_DATABASE_PATH: source, BUBBLEWASH_SESSION_SECRET: "synthetic-session-key-over-32-characters", BUBBLEWASH_BACKUP_ENCRYPTION_KEY: key.toString("base64"), BUBBLEWASH_BACKUP_DEFER_STATUS: "true", BUBBLEWASH_BACKUP_PRIMARY_DIR: path.join(root, "primary"), BUBBLEWASH_BACKUP_OFFSITE_DIR: path.join(root, "staging"), BUBBLEWASH_BACKUP_STATUS_PATH: path.join(root, "status.json") };
  const envFile = path.join(root, "env");
  writeFileSync(envFile, Object.entries(env).filter(([k]) => k.startsWith("BUBBLEWASH_") || k === "NODE_ENV").map(([k,v]) => `${k}=${v}`).join("\n"));
  const bin = path.join(root, "bin"); mkdirSync(bin);
  writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\ncat <<'STATE'\nLoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nWorkingDirectory=${process.cwd()}\nEnvironmentFiles=${envFile} (ignore_errors=no)\nEnvironment=\nSTATE\n`, { mode: 0o700 });
  env.PATH = `${bin}:${process.env.PATH}`;
  return { root, source, db, env, key };
}
function run(env) { return spawnSync(process.execPath, ["--experimental-strip-types", "scripts/backup-database.mjs", "--fresh-start"], { env, encoding: "utf8" }); }

test("fresh backup excludes deleted free-page payloads and preserves historical archives", (t) => {
  const f = fixture(t);
  const deleted = "SYNTHETIC_DELETED_CUSTOMER_PAYLOAD_".repeat(600);
  f.db.pragma("secure_delete = OFF");
  f.db.prepare("INSERT INTO submissions VALUES (?, ?, ?, ?)").run("old", "now", "test", JSON.stringify({ payload: deleted }));
  f.db.prepare("DELETE FROM submissions").run(); f.db.close();
  for (const dir of [f.env.BUBBLEWASH_BACKUP_PRIMARY_DIR, f.env.BUBBLEWASH_BACKUP_OFFSITE_DIR]) {
    mkdirSync(dir); const old = path.join(dir, "bubblewash-2020-01-01T00-00-00.000Z.sqlite.enc");
    writeFileSync(old, "historical"); utimesSync(old, new Date(0), new Date(0));
  }
  const sourceBefore = readFileSync(f.source);
  const result = run(f.env); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(f.source), sourceBefore);
  const proof = JSON.parse(result.stdout);
  const bytes = readFileSync(path.join(f.env.BUBBLEWASH_BACKUP_OFFSITE_DIR, proof.filename));
  const decipher = createDecipheriv("aes-256-gcm", f.key, bytes.subarray(9,21)); decipher.setAuthTag(bytes.subarray(21,37));
  const plain = Buffer.concat([decipher.update(bytes.subarray(37)), decipher.final()]);
  assert.equal(plain.includes(Buffer.from("SYNTHETIC_DELETED_CUSTOMER_PAYLOAD_")), false);
  for (const dir of [f.env.BUBBLEWASH_BACKUP_PRIMARY_DIR, f.env.BUBBLEWASH_BACKUP_OFFSITE_DIR]) {
    assert.equal(readdirSync(dir).length, 2);
    assert.equal(readFileSync(path.join(dir, "bubblewash-2020-01-01T00-00-00.000Z.sqlite.enc"), "utf8"), "historical");
  }
  assert.equal(existsSync(f.env.BUBBLEWASH_BACKUP_STATUS_PATH), false);
  assert.equal(existsSync(`${f.env.BUBBLEWASH_BACKUP_STATUS_PATH}.${proof.filename}.pending`), true);
});

test("fresh backup refuses remaining operational data without an archive", (t) => {
  const f = fixture(t); f.db.prepare("INSERT INTO submissions VALUES (?, ?, ?, ?)").run("old", "now", "test", "{}"); f.db.close();
  const result = run(f.env); assert.notEqual(result.status, 0); assert.match(result.stderr, /records remain/);
  assert.equal(existsSync(f.env.BUBBLEWASH_BACKUP_PRIMARY_DIR), false);
});

test("fresh backup cannot publish ready status directly", (t) => {
  const f = fixture(t); f.db.close(); f.env.BUBBLEWASH_BACKUP_DEFER_STATUS = "false";
  const result = run(f.env); assert.notEqual(result.status, 0); assert.match(result.stderr, /deferred status/);
  assert.equal(existsSync(f.env.BUBBLEWASH_BACKUP_PRIMARY_DIR), false);
});

for (const [label, mutate, message] of [
  ["active runtime", (f) => { const file = path.join(f.root, "bin/systemctl"); writeFileSync(file, readFileSync(file, "utf8").replace("ActiveState=inactive", "ActiveState=active")); }, /not fully stopped/],
  ["unknown table", (f) => f.db.exec("CREATE TABLE unexpected(id TEXT)"), /unreviewed table/],
  ["missing admin", (f) => f.db.prepare("DELETE FROM staff_accounts").run(), /no effective admin/],
  ["nonadmin account", (f) => f.db.exec("INSERT INTO staff_accounts SELECT 'worker@example.test', name, 'vendor', 'synthetic-vendor', password_hash, credential_version, status, token_hash, token_expires_at, updated_at FROM staff_accounts WHERE role='admin'"), /records remain/],
]) test(`fresh backup rejects ${label} preserving readiness`, (t) => {
  const f = fixture(t); mutate(f); f.db.close();
  writeFileSync(f.env.BUBBLEWASH_BACKUP_STATUS_PATH, "existing readiness bytes");
  const result = run(f.env); assert.notEqual(result.status, 0); assert.match(result.stderr, message);
  assert.equal(existsSync(f.env.BUBBLEWASH_BACKUP_PRIMARY_DIR), false);
  assert.equal(readFileSync(f.env.BUBBLEWASH_BACKUP_STATUS_PATH, "utf8"), "existing readiness bytes");
});
