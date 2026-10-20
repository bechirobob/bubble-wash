import http from 'node:http';

export function fixtureEdgeHeaders(method, pathname, headers, origin = 'http://localhost:3100') {
  const forwarded = { ...headers };
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && pathname.startsWith('/api/') && headers.origin === origin) {
    forwarded.origin = origin.replace(/^http:/, 'https:');
  }
  return forwarded;
}

// Local HTTP cannot implement production HTTPS transport. WebKit correctly
// upgrades its localhost subresources under this directive, unlike Chromium.
// Remove only transport-upgrade instructions at this test edge, never in the app.
export function fixtureEdgeResponseHeaders(headers, cookieName = 'bubblewash_staff_session') {
  const result = { ...headers };
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === 'strict-transport-security') delete result[key];
    if (key.toLowerCase() === 'set-cookie') {
      // Synthetic HTTP only: WebKit does not accept Secure cookies on localhost.
      // Keep every other attribute and value byte-for-byte; production stays Secure.
      const filter = value => value.split(';')[0].split('=')[0] === cookieName
        ? value.split(';').filter((part, index) => index === 0 || part.trim().toLowerCase() !== 'secure').join(';')
        : value;
      result[key] = Array.isArray(result[key]) ? result[key].map(filter) : filter(result[key]);
    }
    if (key.toLowerCase() === 'content-security-policy') {
      const filter = value => value.split(';').filter(directive => directive.trim().toLowerCase() !== 'upgrade-insecure-requests').join(';');
      result[key] = Array.isArray(result[key]) ? result[key].map(filter) : filter(result[key]);
    }
  }
  return result;
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
      const headers = fixtureEdgeResponseHeaders(incoming.headers);
      // Metadata-only transport proof: WebKit's protocol may omit Cookie from
      // request.allHeaders(). Observe receipt here, never expose a token value.
      if (request.method === 'GET' && ['/admin', '/vendors', '/drivers', '/support'].includes(target.pathname)) {
        headers['x-fixture-staff-cookie-received'] = String(/(?:^|;\s*)bubblewash_staff_session=/.test(request.headers.cookie ?? ''));
      }
      response.writeHead(incoming.statusCode, headers);
      incoming.pipe(response);
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('Fixture upstream unavailable'); });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  });
}
