import { test, expect } from '@playwright/test';

// Synthetic display data only. No customer access, requests or payments are sent.
// Ordinary auth, customer authorization and PWA behavior retain their own gates.
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => {
    const request = route.request();
    if (new URL(request.url()).origin !== 'http://localhost:3100' || request.method() !== 'GET') return route.abort();
    return route.continue();
  });
});
async function contained(page, locator) {
  await expect(locator).toBeVisible();
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds.x).toBeGreaterThanOrEqual(-1);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
  expect(await locator.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
}
async function target44(locator) {
  await expect(locator).toBeVisible();
  const bounds = await locator.boundingBox();
  expect(bounds.height).toBeGreaterThanOrEqual(44);
}

test('customer order keeps long identity and address readable within the responsive layout', async ({ page }, testInfo) => {
  const name = 'SyntheticBusinessNameWithoutBreaks'.repeat(4);
  const address = 'SyntheticReceptionAddressWithoutBreaks'.repeat(5);
  let reads = 0;
  await page.route('**/api/customer/order', route => {
    reads++;
    return route.fulfill({ json: { order: {
      orderId: 'synthetic-alignment-order', bookingReference: 'BW-123456', customer: name,
      createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:00:00Z',
      status: 'Washing', nextStep: 'Our team is preparing the recorded return window.',
      area: 'Synthetic area', pickupAddress: address, plan: 'Twice weekly', service: 'Wash + fold',
      pickupDate: '2026-10-26', pickupWindow: '10:00–12:00',
      invoice: { invoiceId: 'synthetic-invoice', lines: [{ label: 'Synthetic laundry service', amountMinor: 123456789 }], balanceMinor: 123456789, status: 'Open' },
      timeline: [{ createdAt: '2026-10-25T10:00:00Z', status: 'Washing', type: 'synthetic' }],
    }, references: [] } });
  });
  await page.goto('/manage');
  await expect.poll(() => reads).toBeGreaterThan(0);
  const summary = page.locator('.customerOrderSummary');
  const heading = summary.getByRole('heading', { name: `${name}, here is your order.`, exact: true });
  await expect(heading).toHaveText(`${name}, here is your order.`);
  const location = summary.locator('.recordList dd').filter({ hasText: address });
  await expect(location).toHaveText(address);
  for (const element of [summary, heading, location, page.locator('.customerRequestForm')]) await contained(page, element);
  const signOut = summary.getByRole('button', { name: 'Sign out of this order', exact: true });
  await contained(page, signOut);
  await target44(signOut);
  const titleBounds = await heading.boundingBox(), buttonBounds = await signOut.boundingBox();
  expect(titleBounds.x + titleBounds.width <= buttonBounds.x + 1 || titleBounds.y + titleBounds.height <= buttonBounds.y + 1).toBe(true);
  await expect(summary).toContainText('GHS 1234567.89');
  await page.locator('.customerRequestForm textarea').fill('Synthetic draft only; no request is submitted.');
  await expect(page.locator('.customerRequestForm textarea')).toHaveValue('Synthetic draft only; no request is submitted.');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('customer-long-content.png'), fullPage: true, animations: 'disabled' });
});

test('login navigation and service terms keep aligned icons and 44px targets', async ({ page }, testInfo) => {
  await page.goto('/login');
  const links = page.locator('.redesignTextNav a');
  await expect(links).toHaveCount(2);
  for (const link of await links.all()) { await target44(link); await contained(page, link); }
  await expect(links.nth(0)).toHaveAttribute('href', '/');
  await expect(links.nth(1)).toHaveAttribute('href', '/staff');
  await page.goto('/services');
  const terms = page.locator('.serviceConditions > .inlineIconLink');
  await expect(terms).toHaveAttribute('href', '/terms');
  await target44(terms); await contained(page, terms);
  const alignment = await terms.evaluate(node => {
    const box = node.getBoundingClientRect(), icon = node.querySelector('svg').getBoundingClientRect();
    return Math.abs((box.top + box.bottom) / 2 - (icon.top + icon.bottom) / 2);
  });
  expect(alignment).toBeLessThanOrEqual(1);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('services-action-alignment.png'), fullPage: true, animations: 'disabled' });
});
