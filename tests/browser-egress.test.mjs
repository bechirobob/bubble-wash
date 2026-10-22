import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { assertLoopback } from './browser/block-egress.mjs';

test('browser fixture rejects external hostnames and direct IPs before connection', () => {
  for (const host of ['api.paystack.co', 'api.resend.com', '1.1.1.1', 'localhost.example.com', '::ffff:192.0.2.1']) {
    assert.throws(() => assertLoopback(host), /blocked external egress/);
    assert.throws(() => net.connect({ host, port: 443 }), /blocked external egress/);
    assert.throws(() => tls.connect({ host, port: 443 }), /blocked external egress/);
    assert.throws(() => fetch(`https://${host.includes(':') ? `[${host}]` : host}/`), /blocked external egress/);
  }
  assert.throws(() => net.connect('/tmp/synthetic-socket'), /blocked socket-path/);
});
test('HTTP and HTTPS cannot bypass the socket guard via a local proxy', () => {
  for (const client of [http, https]) {
    for (const method of ['get', 'request']) assert.throws(() => client[method](`${client === http ? 'http' : 'https'}://example.invalid`), /blocked external egress/);
  }
});
test('browser fixture permits only loopback', async () => {
  for (const host of ['localhost', '127.0.0.1', '::1', '[::1]']) assert.doesNotThrow(() => assertLoopback(host));
  const server = http.createServer((_request, response) => response.end('synthetic'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text(), 'synthetic'); }
  finally { await new Promise(resolve => server.close(resolve)); }
});
