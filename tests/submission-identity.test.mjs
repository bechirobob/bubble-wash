import assert from 'node:assert/strict';
import test from 'node:test';
import { submissionIdentity } from '../src/lib/submission-identity.ts';
test('private submission identity remains nonnumeric with all-numeric random input', () => {
  assert.equal(submissionIdentity('12345678-1234-4234-8234-123456789012'), 'BW-R1234567812344234');
  assert.equal(submissionIdentity('abcdef01-2345-4678-9abc-def012345678'), 'BW-RABCDEF0123454678');
  assert.match(submissionIdentity('12345678-1234-4234-8234-123456789012'), /^BW-[A-Z0-9]{8,32}$/);
  assert.doesNotMatch(submissionIdentity('12345678-1234-4234-8234-123456789012'), /^BW-\d+$/);
  for (const value of ['', 'BW-001', 'a'.repeat(31), 'z'.repeat(32)]) assert.throws(() => submissionIdentity(value));
});
