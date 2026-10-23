import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { bookingReferenceForOrder, allocateBookingReference, submissionDataWithoutLabels } from '../src/lib/booking-references.ts';
import { allocateVendorCode, vendorCodeForId, formatVendorCode } from '../src/lib/vendor-codes.ts';
import { bookingReferenceSchemaState, migrateBookingReferences } from '../src/lib/booking-reference-schema.ts';

const root = process.cwd();
const temporary = mkdtempSync(path.join(tmpdir(), 'bubblewash-label-domain-'));
process.env.BUBBLEWASH_DATABASE_PATH = path.join(temporary, 'application.sqlite');
process.env.BUBBLEWASH_SESSION_SECRET = 'synthetic-local-session-secret-with-no-live-purpose';
process.env.NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED = 'false';
process.env.RESEND_API_KEY = '';
process.env.PAYSTACK_SECRET_KEY = '';
process.chdir(temporary);
globalThis.fetch = async () => { throw new Error('Network forbidden in synthetic tests'); };
const store = await import('../src/lib/data-store.ts');
const operational = await import('../src/lib/operational-store.ts');
const availability = await import('../src/lib/availability-store.ts');
const { initializeStaffAccountsSchema } = await import('../src/lib/staff-accounts.ts');
const db = operational.operationalDatabase();
initializeStaffAccountsSchema(db);
const emptyBase = db.serialize();
const payload = { submissionType: 'pickup-booking', name: 'Synthetic', email: 'test@example.invalid' };
const record = (id, data = payload) => ({ id, createdAt: '2026-10-23T00:00:00.000Z', source: 'synthetic', data });
function snapshot(database) {
  return database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('booking_references','vendor_codes','sqlite_sequence') ORDER BY name").all()
    .map(({ name }) => [name, database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
}
function cloneDatabase(bytes) {
  const file = path.join(temporary, `${randomUUID()}.sqlite`);
  writeFileSync(file, bytes);
  return new Database(file);
}
function legacyFixture() {
  const database = cloneDatabase(emptyBase);
  database.exec('DROP TABLE booking_references; DROP TABLE vendor_codes;');
  return database;
}
after(() => { db.close(); process.chdir(root); rmSync(temporary, { recursive: true, force: true }); });

test('new booking mapping, delivery proof, idempotency and outbox share one transaction', () => {
  let queued;
  const first = operational.saveBookingOnce(record('internal-new'), 'request-new', value => {
    queued = value;
    store.enqueueNotification({ id: 'notification-new', dedupeKey: 'dedupe-new', channel: 'email', target: 'customer', payload: value.data });
  });
  assert.equal(first.bookingReference, 'BW-001');
  assert.equal(first.id, 'internal-new');
  assert.equal(queued.data.bookingReference, 'BW-001');
  assert.equal(store.findSubmissionRecordById(first.id).data.bookingReference, 'BW-001');
  assert.equal(db.prepare('SELECT count(*) n FROM notification_outbox').get().n, 1);
  const second = operational.saveBookingOnce(record('other-random-id'), 'request-new', () => assert.fail('No duplicate enqueue'));
  assert.deepEqual(second, { ...first, replayed: true });
  assert.throws(() => operational.saveBookingOnce(record('changed', { ...payload, name: 'Changed' }), 'request-new', () => {}), /request changed/);
  const before = db.serialize();
  assert.throws(() => operational.saveBookingOnce(record('failed'), 'request-fail', value => {
    store.enqueueNotification({ id: 'rollback-notification', dedupeKey: 'rollback-dedupe', channel: 'email', target: 'customer', payload: value.data });
    throw new Error('Synthetic queue failure');
  }), /queue failure/);
  assert.deepEqual(db.serialize(), before);
  const third = operational.saveBookingOnce(record('next'), 'request-next', () => {});
  assert.equal(third.bookingReference, 'BW-002');
});

test('submitted labels are discarded without changing idempotency and direct roots cannot bypass allocation', () => {
  const replay = operational.saveBookingOnce(record('ignored-id', { ...payload, bookingReference: 'BW-999', vendorCode: 'ZZZ' }), 'request-new', () => assert.fail());
  assert.equal(replay.bookingReference, 'BW-001');
  const direct = store.appendSubmissionRecord(record('direct', { ...payload, bookingReference: 'BW-888', vendorCode: 'ZZZ' }));
  assert.equal(direct.data.bookingReference, 'BW-003');
  assert.equal('vendorCode' in direct.data, false);
  const before = db.prepare('SELECT count(*) n FROM booking_references').get().n;
  const linked = store.appendSubmissionRecord(record('checkout', { submissionType: 'checkout-request', orderId: 'direct', paymentReference: 'BW-PAY-unchanged', bookingReference: 'BW-999', vendorCode: 'ZZZ' }));
  assert.equal('bookingReference' in linked.data, false);
  assert.equal(db.prepare('SELECT count(*) n FROM booking_references').get().n, before);
  assert.equal(store.findCheckoutByPaymentReference('BW-PAY-unchanged').id, 'checkout');
  assert.equal(operational.readOrderPage(0, 100, 'BW-003').records.some(row => row.id === 'direct'), true);
});

test('historical root, spoofed persisted label and old replay stay unlabelled and unchanged', () => {
  const historical = record('BW-1234567812344234', { ...payload, bookingReference: 'BW-444', vendorCode: 'ZZZ' });
  const raw = JSON.stringify(historical.data);
  db.prepare('INSERT INTO submissions VALUES (?, ?, ?, ?)').run(historical.id, historical.createdAt, historical.source, raw);
  const hash = createHash('sha256').update(JSON.stringify(Object.entries(submissionDataWithoutLabels(historical.data)).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
  db.prepare('INSERT INTO booking_requests VALUES (?, ?, ?, ?)').run('legacy-key', hash, historical.id, historical.createdAt);
  const before = db.prepare('SELECT count(*) n FROM booking_references').get().n;
  assert.equal(operational.saveBookingOnce(record('new-random'), 'legacy-key', () => assert.fail()).bookingReference, null);
  for (const result of [store.findSubmissionRecordById(historical.id), store.readSubmissionRecordsForOrder(historical.id)[0], store.readSubmissionRecords().find(row => row.id === historical.id)]) {
    assert.equal(result.data.bookingReference, null);
    assert.equal('vendorCode' in result.data, false);
  }
  assert.equal(db.prepare('SELECT data FROM submissions WHERE id=?').get(historical.id).data, raw);
  assert.equal(db.prepare('SELECT count(*) n FROM booking_references').get().n, before);
});

test('new vendor gets fixed unique code, rename retains it, old vendor stays null', () => {
  const input = { vendorName: 'Synthetic Vendor', vendorId: 'vendor-first', capacityRemaining: 1, availabilityStatus: 'available', updatedBy: 'synthetic' };
  assert.equal(availability.upsertVendorAvailability(input).vendorCode, 'SYN');
  assert.equal(availability.upsertVendorAvailability({ ...input, vendorName: 'Renamed', vendorCode: 'ZZZ' }).vendorCode, 'SYN');
  assert.equal(availability.upsertVendorAvailability({ ...input, vendorId: 'vendor-second' }).vendorCode, 'SYA');
  db.prepare("INSERT INTO vendor_availability SELECT 'legacy-vendor',vendor_name,service_zones,service_types,capacity_remaining,availability_status,next_available_at,updated_by,notes,updated_at FROM vendor_availability WHERE vendor_id='vendor-first'").run();
  assert.equal(availability.upsertVendorAvailability({ ...input, vendorId: 'legacy-vendor' }).vendorCode, null);
  assert.equal(availability.listVendorAvailability().find(value => value.vendorId === 'vendor-first').vendorCode, 'SYN');
  store.appendSubmissionRecord(record('vendor-event', { submissionType: 'admin-operation', orderId: 'direct', vendorId: 'vendor-first', vendorCode: 'ZZZ' }));
  assert.equal(store.findSubmissionRecordById('vendor-event').data.vendorCode, 'SYN');
});

test('migration is additive, repeatable, no backfill, preserves current owner/MFA/outbox/data', () => {
  const legacy = legacyFixture();
  try {
    legacy.prepare('INSERT INTO submissions VALUES (?, ?, ?, ?)').run('legacy', 'time', 'test', JSON.stringify(payload));
    legacy.prepare("INSERT INTO staff_accounts VALUES ('owner@example.invalid','Owner','admin','','synthetic-hash','version','active','','','time')").run();
    legacy.exec("CREATE TABLE staff_owner_capabilities (email TEXT PRIMARY KEY COLLATE NOCASE REFERENCES staff_accounts(email), all_staff_access INTEGER NOT NULL CHECK (all_staff_access = 1)); INSERT INTO staff_owner_capabilities VALUES ('owner@example.invalid',1)");
    legacy.prepare("INSERT INTO admin_mfa_settings VALUES ('owner@example.invalid','synthetic-encrypted','enrolled',NULL,NULL,'time','time')").run();
    const before = snapshot(legacy);
    assert.equal(store.databaseReadiness(legacy, [initializeStaffAccountsSchema]), false);
    assert.equal(store.databaseReadiness(legacy, [initializeStaffAccountsSchema], { allowMissingBookingReferences: true }), true);
    migrateBookingReferences(legacy);
    migrateBookingReferences(legacy);
    assert.deepEqual(snapshot(legacy), before);
    assert.equal(bookingReferenceSchemaState(legacy), 'ready');
    assert.equal(store.databaseReadiness(legacy, [initializeStaffAccountsSchema]), true);
    assert.equal(bookingReferenceForOrder(legacy, 'legacy'), null);
    assert.equal(legacy.prepare('SELECT count(*) n FROM booking_references').get().n, 0);
    assert.equal(legacy.prepare('SELECT count(*) n FROM vendor_codes').get().n, 0);
    assert.equal(legacy.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger'").get().n, 0, 'Owner-enrollment trigger guard remains compatible');
  } finally { legacy.close(); }
});

test('partial/mutated schema is rejected, failed outer migration is not cached', () => {
  const legacy = legacyFixture();
  try {
    assert.throws(() => legacy.transaction(() => { migrateBookingReferences(legacy); throw new Error('rollback'); }).immediate());
    assert.equal(bookingReferenceSchemaState(legacy), 'absent');
    migrateBookingReferences(legacy);
    assert.equal(bookingReferenceSchemaState(legacy), 'ready');
    legacy.exec('DROP TABLE vendor_codes');
    const before = legacy.serialize();
    assert.equal(store.databaseReadiness(legacy), false);
    assert.throws(() => migrateBookingReferences(legacy), /partial or changed/);
    assert.deepEqual(legacy.serialize(), before);
  } finally { legacy.close(); }
  const ready = cloneDatabase(emptyBase);
  try {
    ready.exec('CREATE INDEX unexpected_label_index ON booking_references(order_id)');
    assert.equal(bookingReferenceSchemaState(ready), 'invalid');
    assert.equal(store.databaseReadiness(ready), false);
  } finally { ready.close(); }
});

test('readiness and missing-map lookup are read-only', () => {
  const legacy = legacyFixture();
  try {
    legacy.pragma('query_only = ON');
    const before = legacy.serialize();
    assert.equal(bookingReferenceForOrder(legacy, 'legacy'), null);
    assert.equal(vendorCodeForId(legacy, 'legacy'), null);
    assert.equal(store.databaseReadiness(legacy), false);
    assert.deepEqual(legacy.serialize(), before);
  } finally { legacy.close(); }
});

test('mapping and high water survive root deletion, process reopen, and code-space exhaustion fails atomically', () => {
  const database = cloneDatabase(emptyBase);
  try {
    database.transaction(() => allocateBookingReference(database, 'deleted-root')).immediate();
    database.exec("INSERT INTO submissions VALUES ('deleted-root','time',NULL,'{}'); DELETE FROM submissions");
    assert.equal(database.transaction(() => allocateBookingReference(database, 'next-root')).immediate(), 'BW-002');
    const reopened = cloneDatabase(database.serialize());
    assert.equal(reopened.transaction(() => allocateBookingReference(reopened, 'after-reopen')).immediate(), 'BW-003');
    reopened.close();
    database.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES ('vendor_codes',17575)").run();
    assert.equal(database.transaction(() => allocateVendorCode(database, 'last', 'Zzz Laundry')).immediate(), 'ZZZ');
    const before = database.serialize();
    assert.throws(() => database.transaction(() => allocateVendorCode(database, 'exhausted', 'Zzz Laundry')).immediate(), /exhausted/);
    assert.deepEqual(database.serialize(), before);
    assert.equal(formatVendorCode(26), 'AAZ'); assert.equal(formatVendorCode(27), 'ABA');
  } finally { database.close(); }
});

test('explicit CLI inventory is read-only and migration leaves old rows unlabelled', () => {
  const file = path.join(temporary, 'cli.sqlite');
  const legacy = new Database(file);
  const base = legacyFixture();
  try {
    for (const { sql } of base.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name <> 'sqlite_sequence' ORDER BY type DESC, name").all()) legacy.exec(sql);
    legacy.prepare('INSERT INTO submissions VALUES (?, ?, ?, ?)').run('historical', 'time', 'test', JSON.stringify(payload));
  } finally { legacy.close(); base.close(); }
  const run = extra => spawnSync(process.execPath, ['--conditions=react-server','--experimental-strip-types',path.join(root,'scripts/migrate-booking-references.mjs'), ...extra, '--database',file], { encoding: 'utf8', cwd: temporary, timeout: 10000 });
  const before = new Database(file, { readonly:true }); const rows = snapshot(before); before.close();
  const inventory = run(['--inventory']); assert.equal(inventory.status, 0, inventory.stderr); assert.equal(JSON.parse(inventory.stdout).schema, 'absent');
  const migrated = run([]); assert.equal(migrated.status, 0, migrated.stderr);
  const verify = new Database(file, { readonly:true });
  try { assert.deepEqual(snapshot(verify), rows); assert.equal(bookingReferenceForOrder(verify, 'historical'), null); assert.equal(bookingReferenceSchemaState(verify), 'ready'); } finally { verify.close(); }
});

test('ordinary existing-store startup never installs missing maps', () => {
  const file = path.join(temporary, 'existing-no-maps.sqlite');
  const fixture = legacyFixture();
  writeFileSync(file, fixture.serialize()); fixture.close();
  const code = `import {getDatabase} from ${JSON.stringify(new URL('../src/lib/data-store.ts',import.meta.url).href)}; const db=getDatabase(); console.log(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('booking_references','vendor_codes')").get().n); db.close();`;
  const result = spawnSync(process.execPath,['--conditions=react-server','--experimental-strip-types','--input-type=module','-e',code],{cwd:temporary,env:{...process.env,BUBBLEWASH_DATABASE_PATH:file},encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr); assert.equal(result.stdout.trim(),'0');
});

test('supported migration order is labels then outbox; reverse-order refusal changes no rows', () => {
  const file = path.join(temporary, 'migration-order.sqlite');
  const fixture = legacyFixture(); writeFileSync(file, fixture.serialize()); fixture.close();
  const run = name => spawnSync(process.execPath,['--conditions=react-server','--experimental-strip-types',path.join(root,'scripts',name),'--database',file],{cwd:temporary,encoding:'utf8',timeout:10000});
  const inspect = () => { const value = new Database(file,{readonly:true}); try {return {schema:value.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),rows:snapshot(value)};} finally {value.close();} };
  const before=inspect();
  assert.notEqual(run('migrate-notification-outbox.mjs').status,0);
  assert.deepEqual(inspect(),before);
  for (const name of ['migrate-booking-references.mjs','migrate-notification-outbox.mjs']) { const result=run(name);assert.equal(result.status,0,result.stderr); }
  const db = new Database(file,{readonly:true});
  try { assert.equal(store.databaseReadiness(db,[initializeStaffAccountsSchema]),true);assert.deepEqual(snapshot(db),before.rows); } finally {db.close();}
});

for (const mode of ['complete','absent','partial','extra-index','invalid-vendor-code']) {
  test(`owner enrollment retains exact map boundary: ${mode}`, () => {
    const fixture=cloneDatabase(emptyBase);
    const file=fixture.name;
    if (mode==='absent') fixture.exec('DROP TABLE booking_references; DROP TABLE vendor_codes');
    if (mode==='partial') fixture.exec('DROP TABLE vendor_codes');
    if (mode==='extra-index') fixture.exec('CREATE INDEX unexpected_map_index ON booking_references(order_id)');
    if (mode==='invalid-vendor-code') fixture.exec("PRAGMA ignore_check_constraints=ON; INSERT INTO vendor_codes(sequence,vendor_id,code) VALUES (1,'bad','zZ1'); PRAGMA ignore_check_constraints=OFF");
    const before=fixture.serialize(); fixture.close();
    const result=spawnSync(process.execPath,['--conditions=react-server','--experimental-strip-types',path.join(root,'tests/owner-enrollment-preservation.fixture.mjs')],{cwd:temporary,env:{PATH:process.env.PATH,NODE_ENV:'production',NODE_NO_WARNINGS:'1',BUBBLEWASH_DATABASE_PATH:file,BUBBLEWASH_DISABLE_DEMO_LOGIN:'true'},encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout.trim(),['complete','absent'].includes(mode)?'ENROLLED':'REJECTED');
    if (!['complete','absent'].includes(mode)) {const verified=new Database(file);assert.deepEqual(verified.serialize(),before);verified.close();}
  });
}


test('linked event display projection resolves authoritative labels without rewriting audit data', () => {
  const events = [
    record('linked-payment-display', { submissionType: 'payment-update', orderId: 'direct', paymentReference: 'BANK-UNCHANGED', bookingReference: 'BW-999' }),
    record('linked-legacy-display', { submissionType: 'payment-update', orderId: 'BW-1234567812344234', bookingReference: 'BW-999' }),
    record('linked-unknown-display', { submissionType: 'support-ticket-action', orderId: 'unknown-private-order', ticketId: 'CASE-LEGACY-REFERENCE', bookingReference: 'BW-999' }),
  ];
  // Persisted spoofed labels are ignored on every read, without a write-side backfill.
  for (const event of events) db.prepare('INSERT INTO submissions VALUES (?, ?, ?, ?)').run(event.id, event.createdAt, event.source, JSON.stringify(event.data));
  const before = db.serialize();
  for (const event of events) {
    for (const projected of [store.findSubmissionRecordById(event.id), store.readSubmissionRecords().find(row => row.id === event.id), store.readSubmissionRecordsForOrder(event.data.orderId).find(row => row.id === event.id)]) {
      assert.equal(projected.id, event.id);
      assert.equal(projected.data.orderId, event.data.orderId);
      assert.equal(projected.data.bookingReference, event.id === 'linked-payment-display' ? 'BW-003' : null);
      assert.equal(projected.data.paymentReference, event.data.paymentReference);
      assert.equal(projected.data.ticketId, event.data.ticketId);
    }
  }
  assert.deepEqual(db.serialize(), before, 'display lookups do not change stored rows, labels, sequence, owner or audit state');
});
