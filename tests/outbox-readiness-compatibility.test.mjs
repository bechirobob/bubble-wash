// Synthetic, local-only proposal tests. Do not run against a deployed database.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import Database from 'better-sqlite3';
import { addNotificationOutboxColumns, NOTIFICATION_OUTBOX_LEASE_INDEX_SQL, notificationOutboxSchemaSnapshot } from '../src/lib/notification-outbox-schema.ts';

const directory = mkdtempSync(path.join(os.tmpdir(), 'bubblewash-exact-outbox-'));
const previousCwd = process.cwd();
process.env.BUBBLEWASH_DATABASE_PATH = path.join(directory, 'synthetic.sqlite');
process.chdir(directory); // Never import legacy JSONL from a real or candidate data directory.
globalThis.fetch = async () => { throw new Error('Network is forbidden in synthetic schema tests'); };
const store = await import('../src/lib/data-store.ts');
const { initializeStaffAccountsSchema } = await import('../src/lib/staff-accounts.ts');
const database = store.getDatabase();
initializeStaffAccountsSchema(database);
const legacyObjects = database.prepare('SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type DESC, name').all();
const originalOutboxSql = legacyObjects.find(({name}) => name === 'notification_outbox').sql;
// Independent golden DDL: these tests must fail if production helper DDL drifts.
const additions = [
  ['delivery_state', "TEXT NOT NULL DEFAULT 'queued'"],
  ['lease_token', 'TEXT'], ['lease_expires_at', 'TEXT'],
  ['lease_attempt_started', 'INTEGER NOT NULL DEFAULT 0'],
  ['first_attempt_at', 'TEXT'], ['provider_request', 'TEXT'],
  ['provider_idempotency_key', 'TEXT'], ['provider_account_hash', 'TEXT'],
];
const leaseIndex = 'CREATE INDEX idx_notification_outbox_lease ON notification_outbox(delivery_state, lease_expires_at, next_attempt_at)';
function fixture(change = (sql) => sql) {
  const db = new Database(':memory:');
  for (const {name, sql} of legacyObjects) db.exec(change(sql, name));
  return db;
}
function migrate(db, definitions = additions, index = true) {
  for (const [name, definition] of definitions) db.exec(`ALTER TABLE notification_outbox ADD COLUMN ${name} ${definition}`);
  if (index) db.exec(leaseIndex);
}
function check(db) { return store.databaseReadiness(db, [initializeStaffAccountsSchema]); }
function withFixture(action, change) {
  const db = fixture(change);
  try { action(db); } finally { db.close(); }
}
// SQLite read-only readers may change shared-memory read-mark/lock metadata.
// Check persistent database/WAL bytes, plus exact schema and rows above.
function fingerprint() {
  return Object.fromEntries(readdirSync(directory).filter(name => !name.endsWith('-shm')).sort().map(name => [name, createHash('sha256').update(readFileSync(path.join(directory, name))).digest('hex')]));
}
function verifyReadOnlyProbe(expected) {
  const probe = store.openReadOnlyDatabase();
  try {
    const before = fingerprint();
    const schema = probe.prepare('SELECT * FROM sqlite_master ORDER BY type, name').all();
    const rows = probe.prepare('SELECT * FROM notification_outbox ORDER BY id').all();
    const changes = probe.prepare('SELECT total_changes() AS n').get().n;
    assert.equal(probe.readonly, true);
    assert.equal(check(probe), expected);
    assert.equal(check(probe), expected);
    assert.deepEqual(probe.prepare('SELECT * FROM sqlite_master ORDER BY type, name').all(), schema);
    assert.deepEqual(probe.prepare('SELECT * FROM notification_outbox ORDER BY id').all(), rows);
    assert.equal(probe.prepare('SELECT total_changes() AS n').get().n, changes);
    assert.deepEqual(fingerprint(), before, 'Database and WAL bytes unchanged by readiness (SQLite reader-lock SHM metadata excluded)');
  } finally { probe.close(); }
}
after(() => { database.close(); process.chdir(previousCwd); rmSync(directory, {recursive:true, force:true}); });

test('exact legacy and exact known additive schema are accepted', () => {
  withFixture(db => { assert.equal(check(db), true); migrate(db); assert.equal(check(db), true); });
});

test('shared deterministic DDL exactly matches independent golden additive DDL', () => {
  withFixture(golden => {
    withFixture(shared => {
      migrate(golden);
      addNotificationOutboxColumns(shared);
      shared.exec(NOTIFICATION_OUTBOX_LEASE_INDEX_SQL);
      assert.equal(notificationOutboxSchemaSnapshot(shared), notificationOutboxSchemaSnapshot(golden));
    });
  });
});

test('runtime migration preserves accounts, orders, original rows and conservative legacy states; readiness stays read-only', () => {
  const time = '2026-10-23T00:00:00.000Z';
  database.prepare('INSERT INTO staff_accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('synthetic@example.invalid', 'Synthetic Sentinel', 'admin', '', 'synthetic-not-a-credential', 'sentinel-version', 'active', '', '', time);
  database.prepare('INSERT INTO submissions VALUES (?, ?, ?, ?)').run('order-sentinel', time, 'synthetic-test', '{"orderId":"sentinel","status":"confirmed"}');
  const insert = database.prepare('INSERT INTO notification_outbox VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const status of ['pending', 'failed', 'sent', 'skipped']) {
    insert.run(`legacy-${status}`, `dedupe-${status}`, 'email', 'customer', '{"synthetic":true}', status, status === 'pending' ? 0 : 1, time, status === 'sent' ? 'synthetic-provider-id' : null, 'prior-error', time, time, status === 'sent' ? time : null);
  }
  const before = database.prepare('SELECT * FROM notification_outbox ORDER BY id').all();
  const account = database.prepare('SELECT * FROM staff_accounts').all();
  const order = database.prepare('SELECT * FROM submissions').all();
  verifyReadOnlyProbe(true);
  database.exec("CREATE TRIGGER synthetic_migration_failure BEFORE UPDATE ON notification_outbox BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END");
  const blockedSchema = notificationOutboxSchemaSnapshot(database);
  assert.throws(() => store.readNotification('legacy-pending'), /synthetic migration failure/);
  assert.equal(notificationOutboxSchemaSnapshot(database), blockedSchema, 'Failed runtime migration rolls back all additive DDL');
  assert.deepEqual(database.prepare('SELECT * FROM notification_outbox ORDER BY id').all(), before, 'Failed migration preserves every original row');
  database.exec('DROP TRIGGER synthetic_migration_failure');
  store.readNotification('legacy-pending');
  const after = database.prepare('SELECT * FROM notification_outbox ORDER BY id').all();
  assert.equal(after.length, before.length);
  for (const prior of before) {
    const row = after.find(({id}) => id === prior.id);
    for (const key of Object.keys(prior).filter(key => !['status', 'last_error'].includes(key))) assert.equal(row[key], prior[key], key);
    const uncertain = ['pending','failed'].includes(prior.status);
    assert.equal(row.status, uncertain ? 'failed' : prior.status);
    assert.equal(row.delivery_state, uncertain ? 'manual_review' : prior.status === 'sent' ? 'accepted' : 'skipped');
    if (uncertain) assert.match(row.last_error, /Legacy outbox row/);
    else assert.equal(row.last_error, prior.last_error);
  }
  assert.deepEqual(database.prepare('SELECT * FROM staff_accounts').all(), account);
  assert.deepEqual(database.prepare('SELECT * FROM submissions').all(), order);
  verifyReadOnlyProbe(true);
  store.readNotification('legacy-sent');
  assert.deepEqual(database.prepare('SELECT * FROM notification_outbox ORDER BY id').all(), after, 'Second initialization is idempotent');
  database.exec('DROP INDEX idx_notification_outbox_lease');
  verifyReadOnlyProbe(false);
  database.exec(leaseIndex);
});

test('rejects every one of the 254 incomplete subsets of the eight additive columns', () => {
  for (let mask = 1; mask < (1 << additions.length) - 1; mask++) {
    withFixture(db => {
      migrate(db, additions.filter((_, index) => mask & (1 << index)), false);
      assert.equal(check(db), false, `Partial migration bitmask ${mask}`);
      // A lease index is possible for some partial subsets, but never sufficient.
      if ((mask & 1) && (mask & 4)) {
        db.exec(leaseIndex);
        assert.equal(check(db), false, `Partial migration plus lease index bitmask ${mask}`);
      }
    });
  }
});

for (let count = 1; count < additions.length; count++) {
  test(`rejects partial migration with first ${count} added columns`, () => {
    withFixture(db => { migrate(db, additions.slice(0, count), false); assert.equal(check(db), false); });
  });
}
for (let missing = 0; missing < additions.length; missing++) {
  test(`rejects incomplete migration missing ${additions[missing][0]}`, () => {
    withFixture(db => { migrate(db, additions.filter((_, index) => index !== missing), false); assert.equal(check(db), false); });
  });
}
for (const [name] of additions) {
  test(`rejects wrong type for ${name}`, () => {
    withFixture(db => {
      migrate(db, additions.map(([key, definition]) => [key, key === name ? definition.replace(/TEXT|INTEGER/, 'BLOB') : definition]));
      assert.equal(check(db), false);
    });
  });
}
for (const [name, definition] of [
  ['delivery_state', "TEXT NOT NULL DEFAULT 'accepted'"],
  ['delivery_state', "TEXT DEFAULT 'queued'"],
  ['delivery_state', 'TEXT NOT NULL'],
  ['delivery_state', "TEXT NOT NULL DEFAULT 'queued' CHECK (delivery_state IN ('queued', 'accepted'))"],
  ['lease_attempt_started', 'INTEGER NOT NULL DEFAULT 1'],
  ['lease_attempt_started', 'INTEGER DEFAULT 0'],
  ['lease_attempt_started', 'INTEGER NOT NULL'],
  ['provider_request', "TEXT DEFAULT '{}'"],
]) {
  test(`rejects changed nullability/default/constraint: ${name} ${definition}`, () => {
    withFixture(db => {
      migrate(db, additions.map(([key, value]) => [key, key === name ? definition : value]));
      assert.equal(check(db), false);
    });
  });
}
for (const migrated of [false, true]) {
  for (const drift of ['extra-column', 'missing-due-index', 'changed-due-index', 'extra-index', 'extra-trigger']) {
    test(`rejects ${drift} in ${migrated ? 'additive' : 'legacy'} schema`, () => {
      withFixture(db => {
        if (migrated) migrate(db);
        if (drift === 'extra-column') db.exec('ALTER TABLE notification_outbox ADD COLUMN unreviewed TEXT');
        if (drift === 'missing-due-index') db.exec('DROP INDEX idx_notification_outbox_due');
        if (drift === 'changed-due-index') db.exec('DROP INDEX idx_notification_outbox_due; CREATE INDEX idx_notification_outbox_due ON notification_outbox(next_attempt_at, status)');
        if (drift === 'extra-index') db.exec('CREATE INDEX unreviewed_outbox_index ON notification_outbox(provider_id)');
        if (drift === 'extra-trigger') db.exec('CREATE TRIGGER unreviewed_outbox_trigger AFTER INSERT ON notification_outbox BEGIN SELECT 1; END');
        assert.equal(check(db), false);
      });
    });
  }
}
for (const drift of ['missing-lease-index', 'changed-lease-index', 'partial-lease-index', 'reordered-additions']) {
  test(`rejects ${drift}`, () => {
    withFixture(db => {
      migrate(db, drift === 'reordered-additions' ? [...additions].reverse() : additions, false);
      if (drift === 'changed-lease-index') db.exec('CREATE INDEX idx_notification_outbox_lease ON notification_outbox(lease_expires_at, delivery_state, next_attempt_at)');
      if (drift === 'partial-lease-index') db.exec("CREATE INDEX idx_notification_outbox_lease ON notification_outbox(delivery_state, lease_expires_at, next_attempt_at) WHERE delivery_state = 'queued'");
      if (drift === 'reordered-additions') db.exec(leaseIndex);
      assert.equal(check(db), false);
    });
  });
}
for (const [label, original, replacement] of [
  ['primary key', 'id TEXT PRIMARY KEY', 'id TEXT'],
  ['dedupe uniqueness', 'dedupe_key TEXT NOT NULL UNIQUE', 'dedupe_key TEXT NOT NULL'],
  ['channel constraint', "CHECK (channel IN ('email', 'whatsapp'))", ''],
  ['target constraint', "CHECK (target IN ('customer', 'operations'))", ''],
  ['JSON constraint', 'CHECK (json_valid(payload))', ''],
  ['status constraint', "CHECK (status IN ('pending', 'sent', 'failed', 'skipped'))", ''],
  ['legacy default', "DEFAULT 'pending'", "DEFAULT 'sent'"],
  ['legacy type', 'attempts INTEGER', 'attempts TEXT'],
]) {
  test(`rejects weakened/changed legacy ${label} in both variants`, () => {
    withFixture(db => {
      assert.equal(check(db), false); migrate(db); assert.equal(check(db), false);
    }, (sql, name) => name === 'notification_outbox' ? sql.replace(original, replacement) : sql);
  });
}

test('keeps strict core/staff table and index checks for both accepted outbox variants', () => {
  for (const migrated of [false,true]) {
    for (const drift of [
      'DROP TABLE privacy_requests',
      'DROP INDEX idx_driver_live_locations_captured_at',
      'ALTER TABLE driver_live_locations RENAME COLUMN latitude TO old_latitude',
      'ALTER TABLE staff_accounts ADD COLUMN unexpected TEXT',
      'DROP TABLE staff_accounts',
    ]) withFixture(db => { if (migrated) migrate(db); db.exec(drift); assert.equal(check(db), false, drift); });
    withFixture(db => { if (migrated) migrate(db); assert.equal(check(db), false); },
      (sql, name) => name === 'submissions' ? sql.replace('CHECK (json_valid(data))', '') : sql);
  }
});

test('retains original allowance for unrelated optional tables; never weakens required tables', () => {
  withFixture(db => {
    db.exec('CREATE TABLE optional_synthetic_extension (id TEXT PRIMARY KEY)');
    assert.equal(check(db), true); migrate(db); assert.equal(check(db), true);
  });
});

test('does not normalize alternate but semantically similar base DDL', () => {
  assert.ok(originalOutboxSql.includes('\n'));
  withFixture(db => { assert.equal(check(db), false); migrate(db); assert.equal(check(db), false); },
    (sql, name) => name === 'notification_outbox' ? sql.replace(/\s+/g, ' ') : sql);
});

// Reuse the established readiness fixture to exercise the real GET handler for
// anonymous, maintenance-token and admin-session callers after additive DDL.
test('migrated schema keeps the readiness route green without writes for all three access modes', () => {
  const routeDirectory = mkdtempSync(path.join(os.tmpdir(), 'bubblewash-exact-outbox-route-'));
  try {
    const run = mode => {
      const result = spawnSync(process.execPath, ['--conditions=react-server', '--experimental-strip-types',
        '--experimental-loader=./tests/alias-loader.mjs', 'tests/readiness-readonly.fixture.mjs', routeDirectory, mode, 'complete'],
        {cwd: previousCwd, env: {PATH:process.env.PATH, HOME:routeDirectory, NODE_NO_WARNINGS:'1'}, encoding:'utf8', timeout:30000});
      assert.equal(result.status, 0, result.stderr);
    };
    run('seed');
    const file = path.join(routeDirectory, 'database.sqlite');
    const db = new Database(file);
    try {
      addNotificationOutboxColumns(db); db.exec(NOTIFICATION_OUTBOX_LEASE_INDEX_SQL);
    } finally { db.close(); }
    const before = createHash('sha256').update(readFileSync(file)).digest('hex');
    run('check');
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), before);
  } finally { rmSync(routeDirectory, {recursive:true, force:true}); }
});
