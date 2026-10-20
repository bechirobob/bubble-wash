const fixtureOrigin = 'http://localhost:3100';
const mutations = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Emulate only the TLS edge's write origin, never browser subresource headers.
// In particular, forcing Origin on script GETs is rejected by Chromium routing.
export function fixtureRequestPolicy(url, method, headers) {
  const target = new URL(url);
  if (target.origin !== fixtureOrigin) return null;
  if (!mutations.has(method) || !target.pathname.startsWith('/api/')) return {};
  if (headers.origin !== fixtureOrigin) return {};
  return { headers: { ...headers, origin: 'https://localhost:3100' } };
}
