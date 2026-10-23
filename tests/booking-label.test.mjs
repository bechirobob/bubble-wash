import assert from 'node:assert/strict';
import test from 'node:test';
import { bookingLabel } from '../src/lib/booking-label.ts';
test('visible labels never fall back to relationship keys', () => {
  for (const bookingReference of ['BW-001', 'BW-999', 'BW-1000', 'BW-9007199254740991']) assert.equal(bookingLabel({ bookingReference }), bookingReference);
  for (const bookingReference of [null, undefined, '', 'BW-000', 'BW-0001', 'BW-1', 'BW-ABC123456789ABCD', 'BW-9007199254740992']) assert.equal(bookingLabel({ bookingReference, orderId: 'BW-PRIVATEINTERNALKEY' }), 'Legacy test booking');
});
