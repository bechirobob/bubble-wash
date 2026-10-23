import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fixtureRequestPolicy } from './request-policy.mjs';
import { observePrefetches } from './prefetch-lifecycle.mjs';

const prefetches = new WeakMap();
async function beforeHardNavigation(page, label) {
  const tracker = prefetches.get(page);
  tracker.arm();
  tracker.setPhase(`settling before ${label}`);
  await expect.poll(() => tracker.settled(), { timeout: 15_000, message: `Existing RSC prefetches finish before ${label}` }).toBe(true);
  tracker.setPhase(label);
}
function safeError(message) {
  return message.replace(/https?:\/\/[^\s]+/g, value => {
    try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return '[URL]'; }
  });
}

const paths = { admin: '/admin?view=orders', vendor: '/vendors?view=jobs', driver: '/drivers?view=route', support: '/support?view=orders' };

async function evidence(page, testInfo, label) {
  console.log(`[${testInfo.project.name}] evidence: ${label}`);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath(`${label}.png`), fullPage: true, animations: 'disabled' });
}
async function save(page, label, endpoint = '/api/orders/advance') {
  console.log(`[${test.info().project.name}] save: ${label}`);
  await test.step(`Save ${label}`, async () => {
    const [response] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith(endpoint) && response.request().method() === 'POST', { timeout: 15_000 }),
      page.getByRole('button', { name: label, exact: true }).click(),
    ]);
    // Header success is not client completion. Let the app consume the body and
    // finish its refresh before the next navigation or action can abort that work.
    expect(response.ok(), `${label}: HTTP ${response.status()}`).toBeTruthy();
    if (endpoint === '/api/orders/invoice') {
      await expect(page.locator('.invoicePanel > [role="status"]')).toHaveText('Ledger entry recorded.');
      await expect(page.locator('.invoicePanel').getByRole('button', { name: label, exact: true })).toBeEnabled();
    } else {
      await expect(page.locator('.automationPanel [role="status"]')).toHaveText(/^Saved /);
      await expect(page.locator('.automationPanel button:disabled')).toHaveCount(0);
    }
    await expect(page.getByRole('button', { name: 'Working…', exact: true })).toHaveCount(0);
  });
}
async function form(page, action, values, submit, testInfo, label) {
  console.log(`[${testInfo.project.name}] form: ${action}`);
  await page.getByRole('button', { name: action, exact: true }).click();
  for (const [name, value] of Object.entries(values)) await page.locator(`.structuredActionForm [name="${name}"]`).fill(value);
  if (action === 'Mark ready for driver') {
    const quality = page.getByLabel('Quality check');
    await expect(quality).toHaveValue('Count, finish, and packaging checked');
    await expect(quality.locator('option:checked')).toHaveText('Checks complete');
    await expect(quality).toHaveAccessibleDescription('Check count, finish, and packaging. Record any exception in the dispatch note.');
  }
  await evidence(page, testInfo, label);
  await save(page, submit);
}

test('four-role saved workflow, responsive controls and stopped SLA', async ({ browser }, testInfo) => {
  const contexts = [];
  const pages = {};
  const external = [];
  const errors = [];
  const width = testInfo.project.use.viewport.width;
  const fixture = testInfo.project.name;
  const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  try {
    for (const [index, role] of Object.keys(paths).entries()) {
      const context = await browser.newContext({ viewport: testInfo.project.use.viewport, isMobile: testInfo.project.use.isMobile, hasTouch: testInfo.project.use.hasTouch, deviceScaleFactor: testInfo.project.use.deviceScaleFactor, baseURL: 'http://localhost:3100', extraHTTPHeaders: {
        'x-forwarded-for': `192.0.2.${index + (fixture.startsWith('webkit') ? 31 : width === 320 ? 1 : width === 390 ? 11 : 21)}`,
      } });
      // These manually created contexts do not inherit Playwright's page fixture timeouts.
      context.setDefaultTimeout(15_000);
      context.setDefaultNavigationTimeout(20_000);
      contexts.push(context);
      console.log(`[${fixture}] login: ${role}`);
      await context.route('**/*', route => {
        const request = route.request();
        const options = fixtureRequestPolicy(request.url());
        if (options === null) {
          const target = new URL(request.url());
          const blocked = `${target.origin}${target.pathname}`;
          external.push(blocked);
          console.error(`[${fixture}] blocked by fixture egress: ${blocked}`);
          return route.abort();
        }
        return route.continue(options);
      });
      const page = await context.newPage(); pages[role] = page;
      const tracker = observePrefetches(page, event => console.log(`[${fixture}] ${role} ${Date.now()} ${JSON.stringify(event)}`));
      prefetches.set(page, tracker);
      page.on('pageerror', error => {
        const message = safeError(error.message);
        errors.push(message);
        console.error(`[${fixture}] ${role} ${Date.now()} pageerror during ${tracker.phase()}: ${message}`);
      });
      page.on('requestfailed', request => {
        if (request.resourceType() === 'script') console.error(`[${fixture}] script request failed: ${new URL(request.url()).pathname} ${request.failure()?.errorText}`);
      });
      await page.goto(`/login?next=${encodeURIComponent(paths[role].split('?')[0])}`);
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
      await page.getByLabel('Staff username or email').fill(`${role}@example.invalid`);
      await page.getByLabel('Password', { exact: true }).fill(`synthetic-${role}-password-123`);
      await page.getByLabel('Password', { exact: true }).press('Tab');
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeFocused();
      expect(await page.getByRole('button', { name: 'Sign in', exact: true }).evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
      await beforeHardNavigation(page, `${role} submit login`);
      console.log(`[${fixture}] submit login: ${role}`);
      const [loginResponse] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/api/login') && response.request().method() === 'POST', { timeout: 15_000 }),
        page.keyboard.press('Enter'),
      ]);
      // Successful sign-in navigates immediately; do not read a discarded response body.
      if (!loginResponse.ok()) {
        const loginBody = await loginResponse.json();
        const safeErrors = new Set(['Same-origin staff action required.', 'Invalid Bubble Wash staff credentials.', 'Too many login attempts. Try again shortly.', 'Login cannot be reached.', 'Unable to sign in.', 'Admin sign-in is temporarily unavailable.']);
        const loginError = safeErrors.has(loginBody.error) ? loginBody.error : 'Unrecognized login error';
        throw new Error(`Login HTTP ${loginResponse.status()}: ${loginError}`);
      }
      await page.waitForURL(url => url.pathname === paths[role].split('?')[0]);
      const retained = (await context.cookies('http://localhost:3100')).some(cookie => cookie.name === 'bubblewash_staff_session' && cookie.httpOnly && cookie.sameSite === 'Lax');
      expect(retained, `${role} browser retained the HttpOnly SameSite session`).toBe(true);
      // A transient navigation URL is not proof of a usable session. Verify an
      // actual browser cookie-backed API request and a complete workspace reload.
      await expect.poll(() => page.evaluate(async () => (await fetch('/api/orders')).status), { message: `${role} browser session API roundtrip` }).toBe(200);
      await expect(page.getByRole('navigation', { name: `${role} workspace sections`, exact: true })).toBeVisible();
      await beforeHardNavigation(page, `${role} session reload`);
      const workspaceResponse = await page.reload({ waitUntil: 'load' });
      const sent = await workspaceResponse.headerValue('x-fixture-staff-cookie-received') === 'true';
      expect(sent, `${role} fixture server receives session cookie on workspace reload`).toBe(true);
      expect(workspaceResponse.status(), `${role} authenticated workspace reload`).toBe(200);
      await expect(page).toHaveURL(url => url.pathname === paths[role].split('?')[0]);
      await expect.poll(() => page.evaluate(async () => (await fetch('/api/orders')).status), { message: `${role} browser session survives workspace reload` }).toBe(200);
      await expect(page.getByRole('navigation', { name: `${role} workspace sections`, exact: true })).toBeVisible();
      console.log(`[${fixture}] ${role} session retained=${retained}, server received=${sent}`);
      await evidence(page, testInfo, `${role}-landing`);
    }
    const customer = await browser.newContext({ baseURL: 'http://localhost:3100', extraHTTPHeaders: { origin: 'http://localhost:3100' } }); contexts.push(customer);
    console.log(`[${fixture}] create synthetic booking`);
    const response = await customer.request.post('/api/submit', { timeout: 15_000, data: { submissionType: 'pickup-booking', idempotencyKey: randomUUID(), name: `Synthetic customer ${fixture}`, email: `customer${fixture}@example.invalid`, phone: '0200000000', company: `Synthetic account ${fixture}`, pickupAddress: 'Synthetic reception, Osu, Accra', pickupDate: date, pickupWindow: '8:00–10:00', plan: 'Weekly', businessType: 'Office or small team', laundryRhythm: 'About once a week', locationCount: '1 location', servicePriority: 'Standard scheduled service', paymentPreference: 'Invoice me', alertPreference: 'Call me', addons: [] } });
    expect(response.ok(), `Synthetic booking: HTTP ${response.status()}`).toBeTruthy();
    const booking = await response.json();
    const detail = async role => { console.log(`[${fixture}] order detail: ${role}`); await beforeHardNavigation(pages[role], `${role} order detail`); await pages[role].goto(`${paths[role]}&order=${booking.id}`); await expect(pages[role].getByRole('heading', { name: `Synthetic account ${fixture}`, exact: true })).toBeVisible(); };
    const { admin, vendor, driver, support } = pages;
    await detail('admin');
    // Native disclosure is keyboard operable, without disturbing the saved action.
    const summary = admin.locator('summary').filter({ hasText: 'Customer and collection' });
    await summary.focus(); await admin.keyboard.press('Enter');
    await expect(admin.locator('details[open]').filter({ has: summary })).toBeVisible();
    await admin.keyboard.press('Enter');
    await form(admin, 'Schedule pickup from order', { confirmedPickupDate: date, operatorNote: 'Synthetic customer confirmed reception.' }, 'Save pickup window', testInfo, 'admin-scheduling');
    await save(admin, 'Assign vendor + driver');
    await detail('support');
    await form(support, 'Log customer contact', { nextFollowUpAt: `${date}T09:00`, operatorNote: 'Synthetic contact log, no actual call or email.' }, 'Save contact log', testInfo, 'support-contact');
    await beforeHardNavigation(vendor, 'vendor populated queue');
    await vendor.goto(paths.vendor);
    const assignedRow = vendor.locator('.staffOrderRow').filter({ hasText: booking.id });
    await expect(assignedRow).toBeVisible();
    await expect(assignedRow).toContainText(`Synthetic account ${fixture}`);
    const queueHeader = vendor.locator('.staffOrderListHeader');
    if (width === 1440) {
      await expect(queueHeader).toBeVisible();
      const headerColumns = await queueHeader.locator(':scope > span').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().left));
      const rowColumns = await assignedRow.locator(':scope > *').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().left));
      expect(headerColumns).toHaveLength(5);
      expect(rowColumns).toHaveLength(5);
      for (let column = 0; column < 5; column++) expect(Math.abs(headerColumns[column] - rowColumns[column]), `Vendor queue column ${column + 1} aligns with its header`).toBeLessThanOrEqual(1);
    } else {
      await expect(queueHeader).toBeHidden();
    }
    await evidence(vendor, testInfo, 'vendor-populated-queue');
    await detail('vendor'); await evidence(vendor, testInfo, 'vendor-assignment');
    await save(vendor, 'Accept assigned job');
    await detail('driver'); await save(driver, 'Start pickup route');
    await form(driver, 'Mark picked up', { pickupBagCount: '1', operatorNote: 'Synthetic sealed bag received.' }, 'Confirm pickup', testInfo, 'driver-pickup');
    await form(driver, 'Drop at vendor', { vendorRecipient: 'Synthetic receiver', handoffBagCount: '1', operatorNote: 'Synthetic vendor handoff.' }, 'Confirm vendor handoff', testInfo, 'driver-vendor-handoff');
    await detail('vendor');
    await form(vendor, 'Confirm bag intake', { intakeBagCount: '1', receivedWeightKg: '20', operatorNote: 'Synthetic weight and count checked.' }, 'Confirm intake', testInfo, 'vendor-intake');
    await save(vendor, 'Start washing');
    await form(vendor, 'Mark ready for driver', { readyBagCount: '1', operatorNote: 'Synthetic finished bag sealed.' }, 'Mark ready', testInfo, 'vendor-ready');
    await detail('driver'); await save(driver, 'Start return delivery');
    await form(driver, 'Mark delivered', { recipientName: `Synthetic customer ${fixture}`, bagCount: '1', deliveryCode: booking.deliveryCode, operatorNote: 'Synthetic recipient checked bag.' }, 'Confirm delivery', testInfo, 'driver-delivery');
    await detail('admin');
    await admin.getByText('Record a payment, credit or refund', { exact: true }).click();
    const invoice = admin.locator('.invoicePanel');
    await invoice.getByLabel('Amount (GHS)').fill('1700');
    await invoice.getByLabel('Bank or payment service reference (must be unique)').fill(`SYNTHETIC-${fixture}`);
    await invoice.getByLabel('Payment note').fill('Synthetic ledger fixture only; no money transferred.');
    await save(admin, 'Record entry', '/api/orders/invoice');
    await detail('admin');
    admin.once('dialog', dialog => dialog.accept());
    await save(admin, 'Close order');
    await expect(admin.locator('.stageClock b')).toHaveText('Complete');
    await expect(admin.locator('.automationPanel')).toContainText('Order closed');
    await expect(admin.locator('.automationPanel')).toContainText('No further action required.');
    await expect(admin.locator('.automationPanel')).not.toContainText('Waiting');
    await evidence(admin, testInfo, 'admin-closed');
    const tracking = await customer.request.get(`/api/track?id=${booking.id}`, { timeout: 15_000 });
    expect(tracking.ok(), `Tracking: HTTP ${tracking.status()}`).toBeTruthy();
    expect((await tracking.json()).tracking.status).toBe('Closed');
    await beforeHardNavigation(admin, 'admin overdue fixture');
    await admin.goto('/admin?view=orders&order=BW-BROWSEROVERDUE01');
    await expect(admin.locator('.stageClock b')).toHaveText('Overdue');
    await admin.waitForTimeout(1100);
    await expect(admin.locator('.stageClock b')).toHaveText('Overdue');
    await evidence(admin, testInfo, 'admin-overdue-stopped');
    expect(external, 'No browser request may contact an external service').toEqual([]);
    expect(errors, 'No uncaught browser errors').toEqual([]);
  } catch (error) {
    console.error(`[${fixture}] journey failed: ${error.message}`);
    console.error(`[${fixture}] page errors: ${JSON.stringify(errors)}`);
    for (const [role, page] of Object.entries(pages)) {
      if (page.isClosed()) continue;
      const pathname = new URL(page.url()).pathname;
      console.error(`[${fixture}] ${role} current path: ${pathname}`);
      // Never capture a login or other credential-entry page, even with fixture accounts.
      if (pathname !== paths[role].split('?')[0]) continue;
      await page.screenshot({ timeout: 5_000, path: testInfo.outputPath(`${role}-failure.png`), fullPage: true }).catch(() => {});
    }
    throw error;
  } finally { for (const context of contexts) await context.close(); }
});
