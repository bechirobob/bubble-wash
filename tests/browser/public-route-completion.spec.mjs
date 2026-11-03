import { test, expect, expectCustomerFailure } from './customer-error-fixture.mjs';

// Read-only rendered coverage. Every mutation and external origin is blocked.
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  expectCustomerFailure(page, { kind: 'response', path: '/api/customer/order', method: 'GET', status: 401 });
  await page.route('**/*', route => {
    const request = route.request();
    return new URL(request.url()).origin === 'http://localhost:3100' && request.method() === 'GET' ? route.continue() : route.abort();
  });
});
for (const path of ['/', '/services', '/book', '/track', '/manage', '/early-access', '/privacy', '/terms', '/refund-policy', '/install']) {
  test(`public route ${path} keeps expanded controls within the viewport`, async ({ page }, testInfo) => {
    await page.goto(path);
    await expect(page.locator('h1').first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    if (await menu.isVisible()) {
      await menu.click();
      const nav = page.getByRole('navigation', { name: 'Main navigation' });
      for (const link of await nav.getByRole('link').all()) {
        const box = await link.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
      }
      await page.screenshot({ path: testInfo.outputPath('public-menu-expanded.png'), fullPage: true });
      await page.keyboard.press('Escape');
    }
    for (const summary of await page.locator('details:not([open]) > summary').all()) {
      if (await summary.isVisible()) await summary.click();
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('public-expanded.png'), fullPage: true });
    // Explicit 200% text enlargement, not a claim of physical-device/browser zoom.
    await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('main *')];
      const sizes = nodes.map(node => parseFloat(getComputedStyle(node).fontSize));
      nodes.forEach((node, index) => { node.style.fontSize = `${sizes[index] * 2}px`; });
    });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('public-enlarged-text.png'), fullPage: true });
  });
}

test('pricing to booking and Back retains the selected estimate', async ({ page }, testInfo) => {
  await page.route('**/api/quote', route => route.fulfill({ json: { ok: true, quote: { estimatedMonthlyTotal: 3600, subscription: 1500, processingPerPickup: 450, routeFee: 0, perPickupTotal: 450, monthlyPickups: 4, occasionalLines: [], routeFeePending: false } } }));
  await page.goto('/services?plan=Weekly');
  const form = page.locator('.quoteForm');
  await form.getByRole('combobox', { name: 'Collection plan', exact: true }).selectOption('Twice weekly');
  await form.locator('input[type="number"]').fill('60.5');
  await form.locator('.estimateExtras > summary').click();
  await form.getByRole('checkbox').first().check();
  await form.getByRole('button', { name: 'Calculate estimate', exact: true }).click();
  await expect(form.getByRole('status')).toHaveText('Estimate ready.');
  await page.getByRole('link', { name: 'Continue to booking', exact: true }).click();
  await expect(page).toHaveURL(/\/book\?plan=Twice\+weekly&addons=ironing$/);
  await page.goBack();
  await expect(form.getByRole('combobox', { name: 'Collection plan', exact: true })).toHaveValue('Twice weekly');
  await expect(form.locator('input[type="number"]')).toHaveValue('60.5');
  await expect(form.getByRole('checkbox').first()).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('pricing-return.png'), fullPage: true });
});
