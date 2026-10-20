// Test-only preloader. Production server code is unchanged; synthetic journeys
// must never reach payment, notification, mapping or other external services.
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
export function assertLoopback(host) {
  if (!loopback.has(String(host).toLowerCase())) throw new Error(`Browser fixture blocked external egress: ${host}`);
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof options === 'object' && options !== null) {
    if (options.path) throw new Error('Browser fixture blocked socket-path egress');
    assertLoopback(options.host ?? 'localhost');
  } else {
    if (typeof options === 'string' && !/^\d+$/.test(options)) throw new Error('Browser fixture blocked socket-path egress');
    assertLoopback(typeof args[1] === 'string' ? args[1] : 'localhost');
  }
  return Reflect.apply(connect, this, args);
};
// Guard the HTTP destination before any configured local proxy transforms it.
for (const client of [http, https]) {
  for (const method of ['request', 'get']) {
    const original = client[method];
    client[method] = function (input, ...args) {
      const options = typeof input === 'string' || input instanceof URL ? new URL(input) : input;
      assertLoopback(options.hostname ?? options.host ?? 'localhost');
      if (options.socketPath) throw new Error('Browser fixture blocked socket-path egress');
      const overrides = args[0];
      if (overrides && typeof overrides === 'object') {
        if (overrides.hostname || overrides.host) assertLoopback(overrides.hostname ?? overrides.host);
        if (overrides.socketPath) throw new Error('Browser fixture blocked socket-path egress');
      }
      return Reflect.apply(original, this, [input, ...args]);
    };
  }
}
const fetch = globalThis.fetch;
globalThis.fetch = function (input, ...args) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assertLoopback(url.hostname);
  return fetch(input, ...args);
};
syncBuiltinESMExports();
