import { test, expect, expectCustomerFailure } from './customer-error-fixture.mjs';

test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  expectCustomerFailure(page, { kind: 'response', path: '/api/customer/order', method: 'GET', status: 401 });
  await page.route('**/*', route => {
    const request = route.request();
    return new URL(request.url()).origin === 'http://localhost:3100' && request.method() === 'GET' ? route.continue() : route.abort();
  });
});
const tracking = (status) => ({ ok: true, tracking: { id: 'synthetic', bookingReference: 'BW-901', createdAt: '2026-11-01', status, nextStep: 'Synthetic next step', area: 'Osu' } });
const order = { orderId: 'synthetic', customer: 'Synthetic customer', createdAt: '2026-11-01', status: 'Received', nextStep: 'Confirm pickup', area: 'Osu', plan: 'Weekly', service: 'Wash', timeline: [] };

test('mobile menu Escape restores focus and route history leaves it closed', async ({ page }) => {
  await page.goto('/services');
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  if (!(await menu.isVisible())) { await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible(); return; }
  await menu.click();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Track order', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Track order', exact: true }).click();
  await expect(page).toHaveURL(/\/track$/);
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await page.goBack();
  await expect(page).toHaveURL(/\/services$/);
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
});

test('private tracking link can retry in memory without exposing token in page or storage', async ({ page }, testInfo) => {
  let calls = 0;
  expectCustomerFailure(page, { kind: 'requestfailed', path: '/api/track', method: 'GET' });
  await page.route('**/api/track?*', route => ++calls === 1 ? route.abort('connectionreset') : route.fulfill({ json: tracking('Clean and ready') }));
  await page.goto('/track#tracking=synthetic-private-token');
  const retry = page.getByRole('button', { name: 'Try tracking again' });
  await expect(retry).toBeVisible();
  await expect(page).toHaveURL(/\/track$/);
  await expect(page.locator('body')).not.toContainText('synthetic-private-token');
  expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).not.toContain('synthetic-private-token');
  await page.screenshot({ path: testInfo.outputPath("tracking-retry.png"), fullPage: true });
  await retry.click();
  await expect(page.locator('.trackingResult')).toContainText('Clean and ready');
  expect(calls).toBe(2);
  await page.screenshot({ path: testInfo.outputPath('tracking-result.png'), fullPage: true });
});

test('new tracking lookup wins over delayed automatic response', async ({ page }) => {
  let release, started = false, finished = false;
  const held = new Promise(resolve => { release = resolve; });
  expectCustomerFailure(page, { kind: 'requestfailed', path: '/api/track', method: 'GET' });
  await page.route('**/api/track?*', async route => {
    if (new URL(route.request().url()).searchParams.get('trackingToken') === 'old-synthetic') {
      started = true; await held;
      await route.fulfill({ json: tracking('Old result') }).catch(() => {}); finished = true;
    } else await route.fulfill({ json: tracking('Newest result') });
  });
  await page.goto('/track#tracking=old-synthetic');
  await expect.poll(() => started).toBe(true);
  await page.locator('[name="trackingId"]').fill('new-synthetic');
  // A deliberate new submit supersedes the pending automatic lookup.
  await page.locator('.trackingLayout form').evaluate(form => form.requestSubmit());
  await expect(page.locator('.trackingResult')).toContainText('Newest result');
  release();
  await expect.poll(() => finished).toBe(true);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('.trackingResult')).not.toContainText('Old result');
});

test('recovery is verified once and a lost response never replays the token', async ({ page }) => {
  expectCustomerFailure(page, { kind: 'requestfailed', path: '/api/customer/recover', method: 'POST' });
  const bodies = []; let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/customer/recover', async route => {
    const body = route.request().postDataJSON(); bodies.push(body);
    if (body.token) { await held; return route.abort('connectionreset'); }
    return route.fulfill({ json: { ok: true, message: 'If this address matches, a recovery link will arrive.' } });
  });
  await page.goto('/manage#recovery=synthetic-once');
  await expect.poll(() => bodies.length).toBe(1);
  await expect(page.locator('.manageAccessForm button')).toBeDisabled();
  await expect(page).toHaveURL(/\/manage$/);
  release();
  await expect(page.locator('.manageAccessForm').getByRole('status')).toContainText('couldn’t verify');
  await expect(page.locator('.manageAccessForm button')).toBeEnabled();
  const recovery = page.locator('details.invoicePanel');
  await recovery.locator('summary').click();
  await recovery.locator('[name="email"]').fill('synthetic@example.invalid');
  await recovery.getByRole('button', { name: 'Send recovery link' }).click();
  await expect(recovery.getByRole('status')).toContainText('If this address matches');
  expect(bodies).toEqual([{ token: 'synthetic-once' }, { email: 'synthetic@example.invalid' }]);
});

test('successful recovery opens the verified order without exposing its token', async ({ page }, testInfo) => {
  let calls = 0;
  await page.route('**/api/customer/recover', route => { calls++; return route.fulfill({ json: { ok: true, order, references: [] } }); });
  await page.goto('/manage#recovery=synthetic-success');
  await expect(page.locator('.customerOrderSummary')).toContainText('Synthetic customer');
  await expect(page).toHaveURL(/\/manage$/);
  expect(calls).toBe(1);
  await page.locator('details.invoicePanel summary').click();
  await page.screenshot({ path: testInfo.outputPath('recovered-order-expanded.png'), fullPage: true });
});

test('stalled one-shot recovery times out and unlocks access without replay', async ({ page }) => {
  let calls = 0;
  expectCustomerFailure(page, { kind: 'requestfailed', path: '/api/customer/recover', method: 'POST' });
  await page.route('**/api/customer/recover', () => { calls++; /* Intentionally no response. */ });
  await page.goto('/manage#recovery=synthetic-stalled');
  await expect.poll(() => calls).toBe(1);
  await expect(page.locator('.manageAccessForm button')).toBeDisabled();
  await expect(page.locator('.manageAccessForm button')).toBeEnabled({ timeout: 20000 });
  await expect(page.locator('.manageAccessForm').getByRole('status')).toContainText('couldn’t verify');
  expect(calls).toBe(1);
});

test('expired recovery link shows failure and leaves fresh recovery available', async ({ page }) => {
  expectCustomerFailure(page, { kind: 'response', path: '/api/customer/recover', method: 'POST', status: 410 });
  await page.route('**/api/customer/recover', route => route.fulfill({ status: 410, json: { ok: false, error: 'This recovery link has expired.' } }));
  await page.goto('/manage#recovery=synthetic-expired');
  await expect(page.locator('.manageAccessForm').getByRole('status')).toContainText('expired');
  await page.locator('details.invoicePanel summary').click();
  await expect(page.getByRole('button', { name: 'Send recovery link' })).toBeEnabled();
});

test('stalled tracking times out into a usable retry', async ({ page }) => {
  let calls = 0;
  expectCustomerFailure(page, { kind: 'requestfailed', path: '/api/track', method: 'GET' });
  await page.route('**/api/track?*', route => { if (++calls > 1) return route.fulfill({ json: tracking('Recovered result') }); });
  await page.goto('/track#tracking=synthetic-stalled');
  await expect(page.getByRole('button', { name: 'Try tracking again' })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'Try tracking again' }).click();
  await expect(page.locator('.trackingResult')).toContainText('Recovered result');
  expect(calls).toBe(2);
});
