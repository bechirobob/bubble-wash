import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const paths = { admin: '/admin?view=orders', vendor: '/vendors?view=jobs', driver: '/drivers?view=route', support: '/support?view=orders' };

async function evidence(page, testInfo, label) {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath(`${label}.png`), fullPage: true, animations: 'disabled' });
}
async function save(page, label, endpoint = '/api/orders/advance') {
  const responsePromise = page.waitForResponse(response => response.url().endsWith(endpoint) && response.request().method() === 'POST');
  await page.getByRole('button', { name: label, exact: true }).click();
  const response = await responsePromise;
  expect(response.ok(), await response.text()).toBeTruthy();
  await expect(page.getByRole('button', { name: 'Working…', exact: true })).toHaveCount(0);
}
async function form(page, action, values, submit, testInfo, label) {
  await page.getByRole('button', { name: action, exact: true }).click();
  for (const [name, value] of Object.entries(values)) await page.locator(`.structuredActionForm [name="${name}"]`).fill(value);
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
        // Same loopback HTTPS-proxy emulation as workflow-http.integration.mjs.
        origin: 'https://localhost:3100', 'x-forwarded-for': `192.0.2.${index + (fixture.startsWith('webkit') ? 31 : width === 320 ? 1 : width === 390 ? 11 : 21)}`,
      } });
      contexts.push(context);
      await context.route('**/*', route => {
        if (new URL(route.request().url()).hostname !== 'localhost') { external.push(route.request().url()); return route.abort(); }
        return route.continue();
      });
      const page = await context.newPage(); pages[role] = page;
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`/login?next=${encodeURIComponent(paths[role].split('?')[0])}`);
      await page.getByLabel('Staff username or email').fill(`${role}@example.invalid`);
      await page.getByLabel('Password', { exact: true }).fill(`synthetic-${role}-password-123`);
      await page.getByLabel('Password', { exact: true }).press('Tab');
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeFocused();
      expect(await page.getByRole('button', { name: 'Sign in', exact: true }).evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
      await page.keyboard.press('Enter');
      await page.waitForURL(url => url.pathname === paths[role].split('?')[0]);
      await evidence(page, testInfo, `${role}-landing`);
    }
    const customer = await browser.newContext({ baseURL: 'http://localhost:3100', extraHTTPHeaders: { origin: 'https://localhost:3100' } }); contexts.push(customer);
    const response = await customer.request.post('/api/submit', { data: { submissionType: 'pickup-booking', idempotencyKey: randomUUID(), name: `Synthetic customer ${fixture}`, email: `customer${fixture}@example.invalid`, phone: '0200000000', company: `Synthetic account ${fixture}`, pickupAddress: 'Synthetic reception, Osu, Accra', pickupDate: date, pickupWindow: '8:00–10:00', plan: 'Weekly', businessType: 'Office or small team', laundryRhythm: 'About once a week', locationCount: '1 location', servicePriority: 'Standard scheduled service', paymentPreference: 'Invoice me', alertPreference: 'Call me', addons: [] } });
    expect(response.ok(), await response.text()).toBeTruthy();
    const booking = await response.json();
    const detail = async role => { await pages[role].goto(`${paths[role]}&order=${booking.id}`); await expect(pages[role].getByRole('heading', { name: `Synthetic account ${fixture}`, exact: true })).toBeVisible(); };
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
    await admin.getByText('Reconcile payment, credit or refund', { exact: true }).click();
    const invoice = admin.locator('.invoicePanel');
    await invoice.getByLabel('Amount (GHS)').fill('1700');
    await invoice.getByLabel('Unique bank/provider reference').fill(`SYNTHETIC-${fixture}`);
    await invoice.getByLabel('Reconciliation note').fill('Synthetic ledger fixture only; no money transferred.');
    await save(admin, 'Record entry', '/api/orders/invoice');
    await detail('admin');
    admin.once('dialog', dialog => dialog.accept());
    await save(admin, 'Close order');
    await expect(admin.locator('.stageClock b')).toHaveText('Complete');
    await evidence(admin, testInfo, 'admin-closed');
    const tracking = await customer.request.get(`/api/track?id=${booking.id}`);
    expect((await tracking.json()).tracking.status).toBe('Closed');
    await admin.goto('/admin?view=orders&order=BW-BROWSEROVERDUE01');
    await expect(admin.locator('.stageClock b')).toHaveText('Overdue');
    await admin.waitForTimeout(1100);
    await expect(admin.locator('.stageClock b')).toHaveText('Overdue');
    await evidence(admin, testInfo, 'admin-overdue-stopped');
    expect(external, 'No browser request may contact an external service').toEqual([]);
    expect(errors, 'No uncaught browser errors').toEqual([]);
  } catch (error) {
    for (const [role, page] of Object.entries(pages)) {
      if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath(`${role}-failure.png`), fullPage: true }).catch(() => {});
    }
    throw error;
  } finally { for (const context of contexts) await context.close(); }
});
