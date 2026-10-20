import http from 'node:http';

export function fixtureEdgeHeaders(method, pathname, headers, origin = 'http://localhost:3100') {
  const forwarded = { ...headers };
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && pathname.startsWith('/api/') && headers.origin === origin) {
    forwarded.origin = origin.replace(/^http:/, 'https:');
  }
  return forwarded;
}

// Loopback-only synthetic TLS-edge emulation. Never used by the application.
// Browser headers remain native; the production same-origin guard stays unchanged.
export function createFixtureEdge({ upstreamPort = 3101, origin = 'http://localhost:3100' } = {}) {
  const expected = new URL(origin);
  if (expected.hostname !== 'localhost' || expected.protocol !== 'http:') throw new Error('Fixture edge must use localhost HTTP');
  return http.createServer((request, response) => {
    const target = new URL(request.url, origin);
    if (request.headers.host !== expected.host || target.origin !== origin) {
      response.writeHead(403).end('Fixture host rejected');
      return;
    }
    const upstream = http.request({ hostname: 'localhost', port: upstreamPort, method: request.method,
      path: `${target.pathname}${target.search}`, headers: fixtureEdgeHeaders(request.method, target.pathname, request.headers, origin) }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('Fixture upstream unavailable'); });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  });
}
