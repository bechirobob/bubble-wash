import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCustomerEvent, boundedCustomerText } from './browser/customer-error-policy.mjs';

test('fixture HTTP allowance matches exact path method and status only', () => {
  const expected = [{ kind: 'response', path: '/api/customer/recover', method: 'POST', status: 410 }];
  assert.equal(classifyCustomerEvent(expected[0], expected), 'expected-fixture');
  for (const change of [{ path: '/api/other' }, { method: 'GET' }, { status: 500 }, { external: true }]) assert.equal(classifyCustomerEvent({ ...expected[0], ...change }, expected), 'unexpected');
  assert.equal(classifyCustomerEvent({ kind: 'pageerror', message: 'Error in recovery' }, expected), 'unexpected');
});
test('expected transport failures never suppress a script failure or JS exception', () => {
  const rule = { kind: 'requestfailed', path: '/api/track', method: 'GET' };
  assert.equal(classifyCustomerEvent({ ...rule, resource: 'fetch', failure: 'net::ERR_FAILED' }, [rule]), 'expected-fixture');
  assert.equal(classifyCustomerEvent({ ...rule, resource: 'script', failure: 'net::ERR_FAILED' }, [rule]), 'unexpected');
  assert.equal(classifyCustomerEvent({ ...rule, resource: 'script', failure: 'net::ERR_ABORTED' }, [rule]), 'unexpected');
  assert.equal(classifyCustomerEvent({ kind: 'pageerror' }, [{ kind: 'pageerror' }]), 'unexpected');
});
test('console remains visible diagnostic and URL secrets are omitted with bounded text', () => {
  assert.equal(classifyCustomerEvent({ kind: 'console', message: 'error' }), 'diagnostic');
  assert.equal(boundedCustomerText('failed http://localhost:3100/track?token=private#secret'), 'failed http://localhost:3100/track');
  assert.equal(boundedCustomerText('failed /api/track?trackingToken=private#secret'), 'failed /api/track');
  assert.equal(boundedCustomerText('x'.repeat(1000)).length, 300);
});
