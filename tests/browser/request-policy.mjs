// Browser routing is egress-only. Never replace Origin or other browser headers.
export function fixtureRequestPolicy(url) {
  return new URL(url).origin === 'http://localhost:3100' ? {} : null;
}
