import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { clientScopeKey } from '../src/lib/security.ts';

test('synthetic browser roles retain separate rate-limit scopes with local proxy emulation', async () => {
  const previous = process.env.BUBBLEWASH_TRUST_PROXY_HEADERS;
  try {
    process.env.BUBBLEWASH_TRUST_PROXY_HEADERS = 'true';
    const admin = new Headers({ 'x-forwarded-for': '192.0.2.1' });
    const vendor = new Headers({ 'x-forwarded-for': '192.0.2.2' });
    assert.equal(clientScopeKey(admin, 'login'), 'login:192.0.2.1');
    assert.equal(clientScopeKey(vendor, 'login'), 'login:192.0.2.2');
    process.env.BUBBLEWASH_TRUST_PROXY_HEADERS = 'false';
    assert.equal(clientScopeKey(admin, 'login'), 'login:local');
    const fixture = await readFile(new URL('./browser/start-fixture.mjs', import.meta.url), 'utf8');
    const journey = await readFile(new URL('./browser/staff-workflow.spec.mjs', import.meta.url), 'utf8');
    assert.match(fixture, /BUBBLEWASH_TRUST_PROXY_HEADERS: 'true'/);
    assert.doesNotMatch(journey, /request\.allHeaders\(\)|request\.headers\(\)/);
    const limiter = await readFile(new URL('../src/lib/rate-limit.ts', import.meta.url), 'utf8');
    assert.match(limiter, /return clientScopeKey\(headers, scope\)/);
  } finally {
    if (previous === undefined) delete process.env.BUBBLEWASH_TRUST_PROXY_HEADERS;
    else process.env.BUBBLEWASH_TRUST_PROXY_HEADERS = previous;
  }
});
