import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
test('inventory reports aggregates without changing bytes or disclosing identities', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bubble-inventory-'));
  try {
    const file = join(dir, 'fixture.sqlite'); const db = new Database(file);
    db.exec("CREATE TABLE staff_accounts (email TEXT, role TEXT); INSERT INTO staff_accounts VALUES ('private@example.invalid','admin'),('worker@example.invalid','driver'); CREATE TABLE submissions (data TEXT); INSERT INTO submissions VALUES ('private-record');"); db.close();
    const before = readFileSync(file); const output = execFileSync('python3', ['scripts/inventory-stale-data.py', file], { encoding: 'utf8' });
    const report = JSON.parse(output); assert.equal(report.readOnly, true); assert.equal(report.integrityOk, true); assert.equal(report.resetExecuted, false); assert.equal(report.tableCounts.submissions, 1); assert.equal(report.staffRoleCounts.admin, 1); assert.equal(report.staffRoleCounts.driver, 1); assert.doesNotMatch(output, /private-record|example.invalid/); assert.deepEqual(readFileSync(file), before);
    assert.notEqual(spawnSync('python3', ['scripts/inventory-stale-data.py', join(dir, 'missing.sqlite')]).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("obsolete shell-sourced production inventory workflow is not available", () => {
  assert.equal(existsSync(".github/workflows/readonly-inventory.yml"), false);
});
