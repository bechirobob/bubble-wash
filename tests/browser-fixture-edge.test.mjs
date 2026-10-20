import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
    response.end(JSON.stringify({ headers: request.headers, body }));
  });
  await new Promise(resolve => upstream.listen(0, 'localhost', resolve));
  const edge = createFixtureEdge({ upstreamPort: upstream.address().port });
  await new Promise(resolve => edge.listen(0, 'localhost', resolve));
  try {
    const url = `http://localhost:${edge.address().port}`;
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
    'set-cookie': ['synthetic=cookie; HttpOnly; Secure; SameSite=Lax'],
    'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
  };
  const expected = {
    ...headers,
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
