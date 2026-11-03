// Exact fixture allowances affect network events only, never uncaught JS errors.
export function classifyCustomerEvent(event, expected = []) {
  if (event.kind === 'pageerror') return 'unexpected';
  if (event.kind === 'console') return 'diagnostic';
  if (event.kind === 'requestfailed' && event.resource === 'script') {
    return 'unexpected';
  }
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
