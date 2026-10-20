import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureRequestPolicy } from './browser/request-policy.mjs';

test('browser fixture leaves scripts and read requests completely unchanged', () => {
  const headers = { accept: '*/*', 'x-forwarded-for': '192.0.2.1' };
  for (const path of ['/_next/static/chunks/app.js', '/api/orders', '/login?next=%2Fadmin']) {
    assert.deepEqual(fixtureRequestPolicy(`http://localhost:3100${path}`, 'GET', headers), {});
  }
  assert.deepEqual(headers, { accept: '*/*', 'x-forwarded-for': '192.0.2.1' });
});
test('browser fixture translates only same-origin API mutations for TLS edge emulation', () => {
  const headers = { origin: 'http://localhost:3100', 'content-type': 'application/json', cookie: 'synthetic=session', 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '192.0.2.1' };
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.deepEqual(fixtureRequestPolicy('http://localhost:3100/api/login', method, headers), {
      headers: { ...headers, origin: 'https://localhost:3100' },
    });
  }
  assert.equal(headers.origin, 'http://localhost:3100');
  for (const origin of ['https://example.invalid', 'http://localhost:3101', undefined]) {
    assert.deepEqual(fixtureRequestPolicy('http://localhost:3100/api/login', 'POST', { origin }), {});
  }
  assert.deepEqual(fixtureRequestPolicy('http://localhost:3100/login', 'POST', headers), {});
});
test('browser fixture blocks external destinations and other local ports', () => {
  for (const url of ['https://example.invalid/api/login', 'http://localhost:3101/api/login', 'https://localhost:3100/api/login', 'http://127.0.0.1:3100/api/login']) {
    assert.equal(fixtureRequestPolicy(url, 'POST', { origin: 'http://localhost:3100' }), null);
  }
});
