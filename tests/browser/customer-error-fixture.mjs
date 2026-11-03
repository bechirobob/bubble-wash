import { test as base, expect } from '@playwright/test';
import { boundedCustomerText, classifyCustomerEvent } from './customer-error-policy.mjs';

const collectors = new WeakMap();
export function expectCustomerFailure(page, rule) {
  const state = collectors.get(page);
  if (!state) throw new Error('Customer diagnostics fixture is not installed');
  state.expected.push(rule);
}

export const test = base.extend({
  page: async ({ page }, runTest, testInfo) => {
    const state = { expected: [], events: [], unexpected: 0, total: 0 };
    collectors.set(page, state);
    function record(event) {
      const category = classifyCustomerEvent(event, state.expected);
      state.total++;
      if (category === 'unexpected') state.unexpected++;
      if (state.events.length < 60) state.events.push({ ...event, category });
    }
    function requestInfo(request) {
      const url = new URL(request.url());
      const headers = request.headers();
      return { path: url.pathname, method: request.method(), resource: request.resourceType(), external: url.origin !== 'http://localhost:3100', navigation: request.isNavigationRequest(), rscQuery: url.searchParams.has('_rsc'), rscHeader: headers.rsc ?? '', prefetchHeader: headers['next-router-prefetch'] ?? '' };
    }
    const pageError = error => record({ kind: 'pageerror', message: boundedCustomerText(error.message) });
    const consoleError = message => { if (message.type() === 'error' || message.type() === 'warning') record({ kind: 'console', level: message.type(), message: boundedCustomerText(message.text()) }); };
    const response = response => { if (response.status() >= 400) record({ kind: 'response', ...requestInfo(response.request()), status: response.status() }); };
    const failed = request => record({ kind: 'requestfailed', ...requestInfo(request), failure: boundedCustomerText(request.failure()?.errorText || 'unknown') });
    page.on('pageerror', pageError); page.on('console', consoleError); page.on('response', response); page.on('requestfailed', failed);
    try { await runTest(page); }
    finally {
      page.off('pageerror', pageError); page.off('console', consoleError); page.off('response', response); page.off('requestfailed', failed);
      console.log('CUSTOMER_BROWSER_DIAGNOSTICS ' + JSON.stringify({ test: testInfo.title, project: testInfo.project.name, total: state.total, unexpected: state.unexpected, truncated: state.total > state.events.length, events: state.events }));
      collectors.delete(page);
      expect(state.unexpected, 'No unexpected customer page/runtime/network errors; see bounded CUSTOMER_BROWSER_DIAGNOSTICS').toBe(0);
    }
  },
});
export { expect };
