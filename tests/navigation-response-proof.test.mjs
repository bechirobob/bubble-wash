import test from 'node:test';
import assert from 'node:assert/strict';
import { provesCompletedNavigation } from './browser/navigation-response-proof.mjs';
const event = { kind: 'requestfailed', failure: 'net::ERR_ABORTED', method: 'GET', resource: 'fetch', external: false, navigation: false, rscQuery: true, rscHeader: '1', prefetchHeader: '' };
const receipt = { status: 200, complete: true, bytes: 42, failed: false, cancelled: false };
test('only a unique completed successful navigation body proves a transport-only abort', () => {
  assert.equal(provesCompletedNavigation(event, receipt, 1), true);
  for (const change of [{ status: 500 }, { complete: false }, { bytes: 0 }, { failed: true }, { cancelled: true }]) assert.equal(provesCompletedNavigation(event, { ...receipt, ...change }, 1), false);
  for (const count of [0, 2]) assert.equal(provesCompletedNavigation(event, receipt, count), false);
  assert.equal(provesCompletedNavigation(event, undefined, 1), false);
});
test('HTTP errors, JS errors, scripts, writes, external requests and real transport failures cannot be waived', () => {
  for (const change of [{ kind: 'response' }, { kind: 'pageerror' }, { resource: 'script' }, { method: 'POST' }, { external: true }, { navigation: true }, { rscQuery: false }, { rscHeader: '' }, { prefetchHeader: '1' }, { failure: 'net::ERR_CONNECTION_RESET' }]) assert.equal(provesCompletedNavigation({ ...event, ...change }, receipt, 1), false);
});
