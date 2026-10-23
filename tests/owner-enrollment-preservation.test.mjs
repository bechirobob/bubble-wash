import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
const root = resolve(import.meta.dirname, '..');
const source = readFileSync(join(root, 'src/lib/data-store.ts'), 'utf8');
const core = source.match(/function initializeDatabaseSchema\([^)]*\) \{\s*db\.exec\(`([\s\S]*?)`\);\s*\}/)[1];
const staff = readFileSync(join(root, 'src/lib/staff-accounts.ts'), 'utf8').match(/function initializeStaffAccountsSchema\([^)]*\) \{\s*database\.exec\(`([\s\S]*?)`\);\s*\}/)[1];
function snapshot(db) {
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
  const tables = db.prepare('PRAGMA main.table_list').all().filter(t => t.schema === 'main' && t.name !== 'sqlite_schema');
  const rows = Object.fromEntries(tables.map(t => [t.name, db.prepare(`SELECT ${t.wr ? '*' : 'rowid,*'} FROM "${t.name.replaceAll('"','""')}"`).all()]));
  return { schema, rows, userVersion: db.pragma('user_version', { simple: true }), applicationId: db.pragma('application_id', { simple: true }), schemaVersion: db.pragma('schema_version', { simple: true }) };
}
for (const scenario of ['success', 'missing-file', 'missing-staff', 'missing-core', 'wrong-staff', 'wrong-capability', 'trigger', 'collision', 'audit-rollback', 'legacy-jsonl']) {
  test(`owner-only transaction preserves unrelated state: ${scenario}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'bw-owner-only-'));
    const file = join(directory, 'existing.sqlite');
    let db;
    try {
      if (scenario !== 'missing-file') {
        db = new Database(file); db.pragma('journal_mode = WAL'); db.exec(core); db.exec(staff);
        db.prepare('INSERT INTO driver_live_locations VALUES (?, ?, ?, ?, ?, ?, ?)').run('old-driver', 'old-order', 5.6, -0.1, 20, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z');
        db.prepare('INSERT INTO submissions VALUES (?, ?, ?, ?)').run('original-audit', '2026-01-01', 'staff-account-administration', '{"submissionType":"staff-account-action","actionType":"preserve"}');
        db.prepare('INSERT INTO staff_accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('existing@example.invalid', 'Existing', 'support', '', 'preserved-hash', 'preserved-version', 'active', '', '', '2026-01-01');
        if (scenario === 'missing-staff') db.exec('DROP TABLE staff_accounts');
        if (scenario === 'missing-core') db.exec('DROP TABLE privacy_requests');
        if (scenario === 'wrong-staff') db.exec('ALTER TABLE staff_accounts RENAME COLUMN token_hash TO old_token_hash');
        if (scenario === 'wrong-capability') db.exec('CREATE TABLE staff_owner_capabilities (email TEXT, all_staff_access INTEGER)');
        if (scenario === 'trigger') db.exec('CREATE TRIGGER forbidden_owner_side_effect AFTER INSERT ON staff_accounts BEGIN DELETE FROM driver_live_locations; END');
        if (scenario === 'collision') db.prepare('UPDATE staff_accounts SET email = ?').run('new-owner@example.invalid');
        if (scenario === 'audit-rollback') db.exec('CREATE UNIQUE INDEX synthetic_audit_conflict ON submissions(source)');
        if (scenario === 'legacy-jsonl') { mkdirSync(join(directory, 'data')); writeFileSync(join(directory, 'data/submissions.jsonl'), '{"id":"must-not-import"}\n'); }
      }
      const before = db ? snapshot(db) : null;
      const run = () => spawnSync(process.execPath, ['--conditions=react-server', '--experimental-strip-types', join(root, 'tests/owner-enrollment-preservation.fixture.mjs')], {
        cwd: directory, env: { PATH: process.env.PATH, HOME: directory, NODE_NO_WARNINGS: '1', NODE_ENV: 'production', BUBBLEWASH_DATABASE_PATH: file, BUBBLEWASH_DISABLE_DEMO_LOGIN: 'true' }, encoding: 'utf8', timeout: 10000,
      });
      const result = run(); assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), scenario === 'success' ? 'ENROLLED' : 'REJECTED');
      if (scenario === 'missing-file') { assert.equal(existsSync(file), false); return; }
      const after = snapshot(db);
      if (scenario !== 'success') { assert.deepEqual(after, before, 'Rejected transaction leaves complete schema/rows/metadata identical'); return; }
      const addedSchema = after.schema.filter(row => !before.schema.some(prior => JSON.stringify(row) === JSON.stringify(prior)));
      assert.deepEqual(addedSchema.map(row => [row.type, row.name]).sort(), [['index', 'sqlite_autoindex_staff_owner_capabilities_1'], ['table', 'staff_owner_capabilities']]);
      assert.equal(after.schemaVersion, before.schemaVersion + 1);
      assert.equal(after.userVersion, before.userVersion); assert.equal(after.applicationId, before.applicationId);
      for (const [table, rows] of Object.entries(before.rows)) {
        if (!['staff_accounts', 'submissions'].includes(table)) assert.deepEqual(after.rows[table], rows, table);
        else {
          assert.equal(after.rows[table].length, rows.length + 1);
          for (const row of rows) assert.ok(after.rows[table].some(value => JSON.stringify(value) === JSON.stringify(row)), `preserve every existing ${table} row`);
        }
      }
      const owner = db.prepare('SELECT * FROM staff_accounts WHERE email = ?').get('new-owner@example.invalid');
      assert.equal(owner.role, 'admin'); assert.equal(owner.entity_id, ''); assert.equal(owner.status, 'invited'); assert.equal(owner.password_hash, ''); assert.match(owner.token_hash, /^[a-f0-9]{64}$/);
      assert.deepEqual(db.prepare('SELECT * FROM staff_owner_capabilities').all(), [{ email: 'new-owner@example.invalid', all_staff_access: 1 }]);
      const audit = JSON.parse(db.prepare('SELECT data FROM submissions WHERE id != ?').get('original-audit').data);
      assert.deepEqual(audit, { submissionType: 'staff-account-action', staffEmail: 'new-owner@example.invalid', actionType: 'Invite additional owner without changing existing accounts', submittedByEmail: 'synthetic-actor' });
      assert.equal(run().stdout.trim(), 'REJECTED'); assert.deepEqual(snapshot(db), after, 'Duplicate retry is read-only and does not reset');
    } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}
