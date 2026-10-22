import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureRequestPolicy } from './browser/request-policy.mjs';

test('browser fixture routing never overrides any browser request headers', () => {
  for (const path of ['/_next/static/chunks/app.js', '/api/orders', '/api/login', '/login?next=%2Fadmin']) {
    assert.deepEqual(fixtureRequestPolicy(`http://localhost:3100${path}`), {});
  }
});
test('browser fixture blocks external destinations and other local ports', () => {
  for (const url of ['https://example.invalid/api/login', 'http://localhost:3101/api/login', 'https://localhost:3100/api/login', 'http://127.0.0.1:3100/api/login']) {
    assert.equal(fixtureRequestPolicy(url), null);
  }
});
