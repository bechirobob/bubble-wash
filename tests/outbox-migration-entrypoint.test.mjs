// Local synthetic databases only. Both entrypoints use this same regression.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import Database from 'better-sqlite3';

const root = path.resolve(import.meta.dirname, '..');
const directory = mkdtempSync(path.join(os.tmpdir(), 'bubblewash-narrow-migration-'));
const previousCwd = process.cwd();
process.env.BUBBLEWASH_DATABASE_PATH = path.join(directory, 'seed.sqlite');
process.chdir(directory);
globalThis.fetch = async () => { throw new Error('Network forbidden in synthetic migration tests'); };
const store = await import('../src/lib/data-store.ts');
const { initializeStaffAccountsSchema } = await import('../src/lib/staff-accounts.ts');
const seed = store.getDatabase();
initializeStaffAccountsSchema(seed);
const ddl = seed.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type DESC, name").all();
seed.close();
after(() => { process.chdir(previousCwd); rmSync(directory, { recursive: true, force: true }); });
let index = 0;
function fixture() {
  const file = path.join(directory, `fixture-${index++}.sqlite`);
  const db = new Database(file);
  for (const { sql } of ddl) db.exec(sql);
  const time = '2000-01-01T00:00:00.000Z';
  db.prepare('INSERT INTO driver_live_locations VALUES (?, ?, ?, ?, ?, ?, ?)').run('expired-sentinel', 'order-sentinel', 5.6, -0.1, 20, time, time);
  db.prepare('INSERT INTO staff_accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('synthetic@example.invalid', 'Synthetic Sentinel', 'admin', '', 'not-a-credential', 'version-sentinel', 'active', '', '', time);
  db.prepare('INSERT INTO submissions VALUES (?, ?, ?, ?)').run('order-sentinel', time, 'synthetic', '{"orderId":"sentinel","status":"confirmed"}');
  db.prepare('INSERT INTO rate_limits VALUES (?, ?, ?)').run('expired-rate-limit', 4, 0);
  db.exec('CREATE TABLE synthetic_optional_history (id TEXT PRIMARY KEY, evidence BLOB NOT NULL)');
  db.prepare('INSERT INTO synthetic_optional_history VALUES (?, ?)').run('sentinel', Buffer.from([0, 1, 255]));
  const insert = db.prepare('INSERT INTO notification_outbox VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const status of ['pending', 'failed', 'sent', 'skipped']) {
    insert.run(`legacy-${status}`, `dedupe-${status}`, 'email', 'customer', '{"synthetic":true}', status, status === 'pending' ? 0 : 1, time, status === 'sent' ? 'synthetic-provider-id' : null, 'prior-error', time, time, status === 'sent' ? time : null);
  }
  return { file, db };
}
function snapshot(db, excludeOutbox = false) {
  const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()
    .filter(row => !excludeOutbox || row.tbl_name !== 'notification_outbox');
  const rows = Object.fromEntries(schema.filter(row => row.type === 'table').map(({ name }) => {
    const quoted = '"' + name.replaceAll('"', '""') + '"';
    return [name, db.prepare(`SELECT rowid AS sqlite_rowid, * FROM ${quoted} ORDER BY rowid`).all()];
  }));
  return { schema, rows };
}
function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, ['--conditions=react-server', '--experimental-strip-types',
    '--import=data:text/javascript,globalThis.fetch=async()=>{throw new Error("Network forbidden")}',
    path.join(root, 'scripts/migrate-notification-outbox.mjs'), ...args], {
    cwd: directory, env: { PATH: process.env.PATH, HOME: directory, NODE_NO_WARNINGS: '1', ...extraEnv },
    encoding: 'utf8', timeout: 20000,
  });
}
function fileHash(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }

test('raw-handle entrypoint preserves expired locations and every non-outbox schema/row, quarantines uncertain rows, and is idempotent', () => {
  const { file, db } = fixture();
  try {
    const before = snapshot(db, true);
    const oldRows = db.prepare('SELECT rowid AS sqlite_rowid, * FROM notification_outbox ORDER BY id').all();
    const decoy = path.join(directory, 'must-not-initialize.sqlite');
    const result = run(['--database', file], { BUBBLEWASH_DATABASE_PATH: decoy });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
    assert.equal(existsSync(decoy), false, 'No default/env database initialization');
    assert.deepEqual(snapshot(db, true), before, 'All non-outbox data and schema, including expired locations, must remain exact');
    assert.equal(store.databaseReadiness(db, [initializeStaffAccountsSchema]), true);
    const migrated = db.prepare('SELECT rowid AS sqlite_rowid, * FROM notification_outbox ORDER BY id').all();
    assert.equal(migrated.length, oldRows.length);
    for (const prior of oldRows) {
      const row = migrated.find(value => value.id === prior.id);
      for (const key of Object.keys(prior).filter(key => !['status', 'last_error'].includes(key))) assert.deepEqual(row[key], prior[key], key);
      const uncertain = ['pending', 'failed'].includes(prior.status);
      assert.equal(row.status, uncertain ? 'failed' : prior.status);
      assert.equal(row.delivery_state, uncertain ? 'manual_review' : prior.status === 'sent' ? 'accepted' : 'skipped');
      if (uncertain) assert.match(row.last_error, /Legacy outbox row/);
      else assert.equal(row.last_error, prior.last_error);
    }
    const once = snapshot(db);
    const hash = fileHash(file);
    const second = run(['--database', file]);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(snapshot(db), once);
    assert.equal(fileHash(file), hash, 'Idempotent rerun does not rewrite database bytes');
  } finally { db.close(); }
});

for (const [name, sql] of [
  ['partial outbox', 'ALTER TABLE notification_outbox ADD COLUMN delivery_state TEXT'],
  ['outbox extra index', 'CREATE INDEX unexpected_outbox_index ON notification_outbox(id)'],
  ['outbox trigger', 'CREATE TRIGGER unexpected_outbox_trigger AFTER UPDATE ON notification_outbox BEGIN SELECT 1; END'],
  ['missing staff table', 'DROP TABLE staff_accounts'],
  ['missing original outbox index', 'DROP INDEX idx_notification_outbox_due'],
  ['non-outbox schema drift', 'ALTER TABLE driver_live_locations ADD COLUMN unexpected TEXT'],
]) {
  test(`entrypoint rejects ${name} without mutating any existing schema or data`, () => {
    const { file, db } = fixture();
    try {
      db.exec(sql);
      const before = snapshot(db);
      const hash = fileHash(file);
      const result = run(['--database', file]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /preflight failed/);
      assert.deepEqual(snapshot(db), before);
      assert.equal(fileHash(file), hash);
    } finally { db.close(); }
  });
}

test('entrypoint requires an explicit absolute existing file, not environment defaults or a newly created database', () => {
  const file = path.join(directory, 'missing.sqlite');
  for (const args of [[], ['--database', 'relative.sqlite'], ['--database', file], ['--database', file, '--unexpected']]) {
    const result = run(args, { BUBBLEWASH_DATABASE_PATH: file });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(file), false);
  }
});


test('postflight refuses an injected no-op migrator and leaves the exact legacy database unchanged', () => {
  const { file, db } = fixture();
  const loader = path.join(directory, 'synthetic-noop-loader.mjs');
  writeFileSync(loader, `export async function load(url, context, nextLoad) {
    const result = await nextLoad(url, context);
    if (!url.endsWith('/notification-outbox-schema.ts')) return result;
    const source = String(result.source);
    const start = source.indexOf('export function migrateNotificationOutbox(');
    if (start < 0) throw new Error('Synthetic fault injector could not locate migrator');
    return { ...result, source: source.slice(0, start) + 'export function migrateNotificationOutbox(db) { return db; }' };
  }`);
  try {
    const before = snapshot(db);
    const hash = fileHash(file);
    const result = run(['--database', file], { NODE_OPTIONS: `--experimental-loader=${loader}` });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Exact additive database schema\/integrity postflight failed/);
    assert.deepEqual(snapshot(db), before);
    assert.equal(fileHash(file), hash);
  } finally { db.close(); }
});
