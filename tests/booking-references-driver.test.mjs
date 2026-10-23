import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { bookingReferenceSchema, allocateBookingReference } from '../src/lib/booking-references.ts';

test('application SQLite driver allocates inside the booking transaction and preserves a retry', () => {
  const db = new Database(':memory:');
  db.exec(bookingReferenceSchema);
  db.exec('CREATE TABLE bookings (id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE)');
  const save = db.transaction(id => {
    const reference = allocateBookingReference(db,id);
    db.prepare('INSERT INTO bookings VALUES (?,?) ON CONFLICT(id) DO NOTHING').run(id,reference);
    return reference;
  });
  assert.equal(save.immediate('internal-a'),'BW-001');
  assert.equal(save.immediate('internal-a'),'BW-001');
  assert.equal(save.immediate('internal-b'),'BW-002');
  const fail = db.transaction(() => {
    allocateBookingReference(db,'internal-c');
    throw new Error('Synthetic booking failure');
  });
  assert.throws(()=>fail.immediate());
  assert.equal(db.prepare('SELECT count(*) n FROM booking_references').get().n,2);
  assert.equal(save.immediate('internal-d'),'BW-003');
  assert.equal(db.prepare('SELECT id FROM bookings WHERE reference=?').get('BW-003').id,'internal-d');
  db.close();
});
