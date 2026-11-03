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
async function capturePublicPage(page, testInfo, name) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  console.log('CUSTOMER_CAPTURE ' + JSON.stringify({ name, cssHeight: height, scale: 'css' }));
  if (height <= 30000) return page.screenshot({ path: testInfo.outputPath(name + '.png'), fullPage: true, scale: 'css' });
  // Overlapping viewport tiles retain all content if even CSS pixels exceed the
  // renderer's full-page limit. Width assertions remain independent and strict.
  const viewportHeight = await page.evaluate(() => innerHeight);
  const last = Math.max(0, height - viewportHeight);
  const positions = [];
  for (let y = 0; y < last; y += Math.floor(viewportHeight * .8)) positions.push(y);
  positions.push(last);
  for (const [index, y] of positions.entries()) {
    await page.evaluate(top => window.scrollTo({ top, behavior: 'instant' }), y);
    await expect.poll(() => page.evaluate(target => Math.abs(scrollY - target) <= 1, y)).toBe(true);
    console.log('CUSTOMER_CAPTURE_TILE ' + JSON.stringify({ name, index, expectedY: y, actualY: await page.evaluate(() => scrollY), viewportHeight }));
    await page.screenshot({ path: testInfo.outputPath(`${name}-tile-${String(index).padStart(3, '0')}.png`), scale: 'css' });
  }
}

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
    for (const summary of await page.locator('details > summary').all()) {
      if (!(await summary.isVisible())) continue;
      if (!(await summary.evaluate(node => node.parentElement.open))) await summary.click();
      await expect(summary.locator('..')).toHaveAttribute('open', '');
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('public-expanded.png'), fullPage: true });
    // Explicit 200% text enlargement, not a claim of physical-device/browser zoom.
    await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('main *')];
      const sizes = nodes.map(node => parseFloat(getComputedStyle(node).fontSize));
      nodes.forEach((node, index) => { node.style.fontSize = `${sizes[index] * 2}px`; });
    });
    const overflow = await page.evaluate(() => [...document.querySelectorAll('main *')].map(node => {
      const box = node.getBoundingClientRect();
      return { tag: node.tagName, className: String(node.className).slice(0, 100), x: Math.round(box.x), right: Math.round(box.right), width: Math.round(box.width) };
    }).filter(box => box.width > 0 && (box.x < -1 || box.right > innerWidth + 1)).slice(0, 30));
    console.log('CUSTOMER_OVERFLOW ' + JSON.stringify({ path, project: testInfo.project.name, overflow }));
    await capturePublicPage(page, testInfo, 'public-enlarged-text');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

test('pricing to booking and Back retains the selected estimate', async ({ page }, testInfo) => {
  await page.route('**/api/quote', route => route.fulfill({ json: { ok: true, quote: { estimatedMonthlyTotal: 3600, subscription: 1500, processingPerPickup: 450, addonsPerPickup: 0, zoneFee: 0, minimumAdjustment: 0, perPickupTotal: 450, monthlyPickups: 4, occasionalLines: [], routeFeePending: false } } }));
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
  await expect(form).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('pricing-return-before-assertion.png'), fullPage: true });
  await expect(form.getByRole('combobox', { name: 'Collection plan', exact: true })).toHaveValue('Twice weekly');
  await expect(form.locator('input[type="number"]')).toHaveValue('60.5');
  if (!(await form.locator('.estimateExtras').evaluate(node => node.open))) await form.locator('.estimateExtras > summary').click();
  await expect(form.getByRole('checkbox').first()).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('pricing-return.png'), fullPage: true });
});
