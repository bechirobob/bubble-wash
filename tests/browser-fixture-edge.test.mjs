import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { securityHeaders } from '../src/lib/security-headers.js';
import { createFixtureEdge, fixtureEdgeHeaders, fixtureEdgeResponseHeaders } from './browser/fixture-edge.mjs';

test('fixture edge changes only exact same-origin API mutation Origin', () => {
  const headers = { host: 'localhost:3100', origin: 'http://localhost:3100', cookie: 'synthetic=session', 'x-forwarded-for': '192.0.2.1' };
  assert.deepEqual(fixtureEdgeHeaders('POST', '/api/login', headers), { ...headers, origin: 'https://localhost:3100' });
  for (const [method, path, origin] of [['GET', '/_next/static/a.js', headers.origin], ['POST', '/login', headers.origin], ['POST', '/api/login', 'https://example.invalid'], ['POST', '/api/login', undefined]]) {
    const input = { ...headers, origin };
    assert.deepEqual(fixtureEdgeHeaders(method, path, input), input);
  }
  assert.equal(headers.origin, 'http://localhost:3100');
});
test('fixture edge forwards real HTTP bodies, Host, cookies and response cookies without exposing credentials', async () => {
  const upstream = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    response.setHeader('set-cookie', 'synthetic=cookie; HttpOnly; Path=/');
    if (['/admin', '/vendors', '/drivers', '/support'].includes(request.url)) response.setHeader('x-fixture-staff-cookie-received', 'upstream-untrusted');
    response.end(JSON.stringify({ headers: request.headers, body }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const edge = createFixtureEdge({ upstreamPort: upstream.address().port });
  await new Promise(resolve => edge.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${edge.address().port}`;
    async function send(path, options = {}) {
      return new Promise((resolve, reject) => {
        const request = http.request(`${url}${path}`, options, async response => {
          let body = ''; for await (const chunk of response) body += chunk;
          resolve({ status: response.statusCode, headers: response.headers, json: () => JSON.parse(body) });
        });
        request.on('error', reject); request.end(options.body);
      });
    }
    const response = await send('/api/login', { method: 'POST', headers: { host: 'localhost:3100', origin: 'http://localhost:3100', cookie: 'synthetic=session', 'content-type': 'application/json' }, body: '{"fixture":true}' });
    assert.equal(response.status, 200);
    assert.equal(response.headers['set-cookie'][0], 'synthetic=cookie; HttpOnly; Path=/');
    const received = await response.json();
    assert.equal(received.headers.host, 'localhost:3100');
    assert.equal(received.headers.origin, 'https://localhost:3100');
    assert.equal(received.headers.cookie, 'synthetic=session');
    assert.equal(received.body, '{"fixture":true}');
    for (const path of ['/admin', '/vendors', '/drivers', '/support']) {
      const withCookie = await send(path, { headers: { host: 'localhost:3100', cookie: 'bubblewash_staff_session=fixture-only' } });
      assert.equal(withCookie.headers['x-fixture-staff-cookie-received'], 'true');
      const withoutCookie = await send(path, { headers: { host: 'localhost:3100', cookie: 'unrelated=fixture-only' } });
      assert.equal(withoutCookie.headers['x-fixture-staff-cookie-received'], 'false');
    }
    assert.equal(response.headers['x-fixture-staff-cookie-received'], undefined, 'No cookie diagnostic on API responses');
    const cross = await (await send('/api/login', { method: 'POST', headers: { host: 'localhost:3100', origin: 'https://example.invalid' } })).json();
    assert.equal(cross.headers.origin, 'https://example.invalid');
    assert.equal((await send('/', { headers: { host: 'wrong.invalid' } })).status, 403);
  } finally {
    edge.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => edge.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  }
});

test('HTTP fixture edge removes only HTTPS transport directives, preserving application security headers', () => {
  const headers = {
    'content-security-policy': "default-src 'self'; upgrade-insecure-requests; script-src 'self'; form-action 'self'; frame-ancestors 'none'; block-all-mixed-content",
    'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
    'content-security-policy-report-only': 'upgrade-insecure-requests',
    'set-cookie': ['bubblewash_staff_session=cookie; HttpOnly; Secure; SameSite=Lax'],
    'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
  };
  const expected = {
    ...headers,
    'set-cookie': ['bubblewash_staff_session=cookie; HttpOnly; SameSite=Lax'],
    'content-security-policy': "default-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; block-all-mixed-content",
  };
  delete expected['strict-transport-security'];
  assert.deepEqual(fixtureEdgeResponseHeaders(headers), expected);
  assert.match(headers['content-security-policy'], /upgrade-insecure-requests/);
  assert.ok(headers['strict-transport-security']);
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const production = Object.fromEntries(securityHeaders().map(header => [header.key.toLowerCase(), header.value]));
    assert.match(production['content-security-policy'], /upgrade-insecure-requests/);
    assert.ok(production['strict-transport-security']);
    const filtered = fixtureEdgeResponseHeaders(production);
    for (const [key, value] of Object.entries(production)) {
      if (!['content-security-policy', 'strict-transport-security'].includes(key)) assert.deepEqual(filtered[key], value);
    }
    assert.deepEqual(filtered['content-security-policy'].split(';').map(value => value.trim()), production['content-security-policy'].split(';').map(value => value.trim()).filter(value => value !== 'upgrade-insecure-requests'));
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  }
});

test('HTTP fixture removes only standalone Secure cookie attribute; production cookie remains Secure', () => {
  const cookies = ['bubblewash_staff_session=Secure; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=28800', 'bubblewash_staff_session=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT; sEcUrE; SameSite=Strict', 'secure=x; Securely=yes; Secure'];
  assert.deepEqual(fixtureEdgeResponseHeaders({ 'Set-Cookie': cookies })['Set-Cookie'], [
    'bubblewash_staff_session=Secure; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800',
    'bubblewash_staff_session=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Strict',
    'secure=x; Securely=yes; Secure',
  ]);
  assert.equal(fixtureEdgeResponseHeaders({ 'set-cookie': cookies[0] })['set-cookie'], 'bubblewash_staff_session=Secure; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800');
  assert.match(readFileSync(new URL('../src/lib/auth.ts', import.meta.url), 'utf8'), /secure: process.env.NODE_ENV === "production"/);
  assert.match(cookies[0], /; Secure;/);
});

test('staff presentation edge preserves redirects and Origin while rejecting all writes', async () => {
  const received = [];
  const upstream = http.createServer((request, response) => {
    received.push({ method: request.method, host: request.headers.host, origin: request.headers.origin });
    if (request.url === '/') response.writeHead(307, { Location: '/staff' }).end();
    else response.end('staff presentation');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const edge = createFixtureEdge({ upstreamPort: upstream.address().port, origin: 'http://localhost:3102', staffPresentation: true });
  await new Promise(resolve => edge.listen(0, '127.0.0.1', resolve));
  try {
    async function send(path, method = 'GET', host = 'localhost:3102') {
      return new Promise((resolve, reject) => {
        const request = http.request(`http://127.0.0.1:${edge.address().port}${path}`, { method, headers: { host, origin: 'http://localhost:3102' } }, async response => {
          let body = ''; for await (const chunk of response) body += chunk;
          resolve({ status: response.statusCode, headers: response.headers, body });
        });
        request.on('error', reject); request.end();
      });
    }
    const redirect = await send('/');
    assert.equal(redirect.status, 307); assert.equal(redirect.headers.location, '/staff');
    assert.equal((await send(redirect.headers.location)).body, 'staff presentation');
    assert.deepEqual(received, Array(2).fill({ method: 'GET', host: 'staff.bubblewash.co', origin: 'http://localhost:3102' }));
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      const rejected = await send('/api/login', method);
      assert.equal(rejected.status, 405); assert.equal(rejected.headers.allow, 'GET');
    }
    assert.equal((await send('/', 'GET', 'wrong.invalid')).status, 403);
    assert.equal(received.length, 2, 'Rejected requests never reach the runtime');
  } finally {
    edge.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => edge.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  }
});


test('synthetic listeners pin IPv4 loopback without changing browser origins or environment isolation', () => {
  for (const name of ['start-fixture.mjs', 'start-results-fixture.mjs', 'start-worklist-fixture.mjs']) {
    const source = readFileSync(new URL(`./browser/${name}`, import.meta.url), 'utf8');
    assert.match(source, /'start', '-H', '127\.0\.0\.1'/);
    assert.match(source, /\.listen\(\d+, '127\.0\.0\.1'\)/);
    assert.doesNotMatch(source, /\.listen\(\d+, 'localhost'\)|'-H', 'localhost'/);
    assert.match(source, /BUBBLEWASH_PUBLIC_URL: 'http:\/\/localhost:/);
    assert.match(source, /for \(const key of Object\.keys\(process\.env\)\) delete process\.env\[key\]/);
  }
  const cookie = readFileSync(new URL('./browser/00-cookie-transport.spec.mjs', import.meta.url), 'utf8');
  assert.match(cookie, /server\.listen\(0, '127\.0\.0\.1', resolve\)/);
  assert.match(cookie, /const origin = `http:\/\/localhost:/);
});
