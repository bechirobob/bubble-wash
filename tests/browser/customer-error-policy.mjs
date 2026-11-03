const publicPrefetchPaths = new Set(['/', '/services', '/book', '/track', '/manage', '/early-access', '/privacy', '/terms', '/refund-policy', '/install', '/staff']);

// Exact fixture allowances affect network events only, never uncaught JS errors.
export function classifyCustomerEvent(event, expected = []) {
  if (event.kind === 'pageerror') return 'unexpected';
  if (event.kind === 'console') return 'diagnostic';
  if (event.kind === 'requestfailed' && event.resource === 'script') {
    return 'unexpected';
  }
  // Next 16.4.2 marks speculative RSC requests with these headers. A cancelled
  // prefetch is recorded as cancelled, never as a successful page/API load.
  if (event.kind === 'requestfailed' && !event.external && !event.navigation &&
      event.method === 'GET' && event.resource === 'fetch' && publicPrefetchPaths.has(event.path) &&
      event.rscQuery === true && event.rscHeader === '1' && ['1', '2', '3'].includes(event.prefetchHeader) &&
      event.failure === 'net::ERR_ABORTED') return 'cancelled-next-prefetch';
  if (!event.external && expected.some(rule => rule.kind === event.kind && rule.path === event.path && rule.method === event.method && (event.kind !== 'response' || rule.status === event.status))) return 'expected-fixture';
  if (event.kind === 'requestfailed' && event.external) return 'blocked-external';
  return 'unexpected';
}

export function boundedCustomerText(value) {
  return String(value).replace(/(?:https?:\/\/|\/)[^\s)"']+/g, value => {
    try {
      const absolute = /^https?:/.test(value);
      const url = new URL(value, 'http://fixture.invalid');
      return (absolute ? url.origin : '') + url.pathname;
    } catch { return '[url]'; }
  }).slice(0, 300);
}
