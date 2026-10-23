import { expectNeutralDecoration } from './decoration-checks.mjs';
import { test, expect } from '@playwright/test';

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || page.isClosed()) return;
  if (!['/services'].includes(new URL(page.url()).pathname)) return;
  await page.screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true, animations: 'disabled', timeout: 5000 }).catch(() => {});
});

test.beforeEach(async ({ page }) => {
  await page.context().route('**/*', route => new URL(route.request().url()).hostname === 'localhost' ? route.continue() : route.abort());
});

async function verifyLayout(page, testInfo, name) {
  await expectNeutralDecoration(page);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  const catalogue = page.locator('.focusedPlanCatalogue');
  const decorations = await catalogue.locator('*').evaluateAll(nodes => nodes.flatMap(node => {
    const style = getComputedStyle(node);
    return style.boxShadow !== 'none' || style.textShadow !== 'none' || style.filter.includes('drop-shadow')
      ? [{ tag: node.tagName, className: node.className, box: style.boxShadow, text: style.textShadow, filter: style.filter }]
      : [];
  }));
  expect(decorations).toEqual([]);
  await catalogue.screenshot({ path: testInfo.outputPath(name + '.png'), animations: 'disabled' });
}

test('native frequency keyboard navigation updates the selected plan and supports open comparisons', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/services?plan=Weekly');
  const catalogue = page.locator('.focusedPlanCatalogue');
  const first = catalogue.getByRole('radio', { name: 'Weekly, 1 pickup / week', exact: true });
  await expect(first).toBeChecked();
  await expect(first).toBeEnabled();
  await expect(catalogue.getByRole('article')).toHaveCount(1);
  // Enter the native group with the keyboard, not programmatic focus.
  for (let step = 0; step < 30 && !(await first.evaluate(node => node === document.activeElement)); step++) await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(catalogue.getByRole('radio', { name: 'Twice weekly, 2 pickups / week', exact: true })).toBeChecked();
  await expect(catalogue.locator('.focusedPlanCard h3')).toHaveText('Twice weekly');
  await expect(catalogue.locator('.focusedPlanPrice strong')).toContainText('2,250');
  await expect(catalogue.getByRole('status')).toContainText('Twice weekly selected');
  const second = catalogue.getByRole('radio', { name: 'Twice weekly, 2 pickups / week', exact: true });
  await expect(second).toBeFocused();
  await expect.poll(() => second.evaluate(input => {
    const style = getComputedStyle(input.closest('label'));
    return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2 && style.outlineColor !== 'transparent';
  })).toBe(true);
  await page.keyboard.press('ArrowRight');
  await expect(catalogue.locator('.focusedPlanCard h3')).toHaveText('Three times weekly');
  await page.keyboard.press('ArrowRight');
  await expect(catalogue.locator('.focusedPlanCard h3')).toHaveText('Contract');
  await expect(catalogue.locator('.focusedPlanPrice strong')).toContainText('4,750');
  // Native radio groups differ at their boundary. Verify reverse traversal
  // without requiring the browser to wrap from its final option to its first.
  for (const name of ['Three times weekly, 3 pickups / week', 'Twice weekly, 2 pickups / week', 'Weekly, 1 pickup / week']) {
    await page.keyboard.press('ArrowLeft');
    const selected = catalogue.getByRole('radio', { name, exact: true });
    await expect(selected).toBeChecked();
    await expect(selected).toBeFocused();
  }
  await expect(first).toBeChecked();
  await verifyLayout(page, testInfo, 'pricing-c-collapsed');
  const compare = catalogue.locator('summary').filter({ hasText: 'Compare all 4 plans' });
  await compare.focus();
  await page.keyboard.press('Enter');
  await expect(catalogue.locator('.focusedPlanComparison')).toBeVisible();
  await catalogue.getByRole('button', { name: /^Choose Contract,/ }).click();
  await expect(catalogue.locator('.focusedPlanCard h3')).toHaveText('Contract');
  await expect(catalogue.getByRole('button', { name: /^Choose Contract,/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(catalogue.locator('.focusedPlanComparison')).toBeVisible();
  await catalogue.locator('summary').filter({ hasText: 'What’s included' }).click();
  await catalogue.locator('summary').filter({ hasText: 'Laundry rates' }).click();
  await expect(catalogue.locator('.focusedPlanBenefits')).toContainText('Contracted pricing');
  await expect(catalogue.locator('.focusedPlanRates')).toContainText('13.5');
  await verifyLayout(page, testInfo, 'pricing-c-expanded');
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await verifyLayout(page, testInfo, 'pricing-c-large-text');
  expect(errors).toEqual([]);
});

test('comparison selections preserve estimate inputs and send the unchanged quote contract', async ({ page }, testInfo) => {
  await page.goto('/services?plan=Weekly');
  const form = page.locator('.quoteForm');
  const weight = form.locator('input[type="number"]');
  await expect(form).toHaveAttribute('aria-busy', 'false');
  await expect(weight).toBeEnabled();
  await weight.fill('60.5');
  await expect(weight).toHaveValue('60.5');
  await form.locator('.estimateExtras > summary').click();
  await form.getByRole('checkbox').first().check();
  await expect(weight).toHaveValue('60.5');
  const catalogue = page.locator('.focusedPlanCatalogue');
  await catalogue.locator('summary').filter({ hasText: 'Compare all 4 plans' }).click();
  await catalogue.getByRole('button', { name: /^Choose Twice weekly,/ }).click();
  await expect(weight).toHaveValue('60.5');
  await expect(form.getByRole('checkbox').first()).toBeChecked();
  await expect(form.getByRole('combobox', { name: 'Collection plan', exact: true })).toHaveValue('Twice weekly');
  await catalogue.getByRole('link', { name: 'Estimate my cost' }).click();
  await expect(page).toHaveURL(/#estimate-heading$/);
  const request = page.waitForRequest(req => req.url().endsWith('/api/quote') && req.method() === 'POST');
  await form.getByRole('button', { name: 'Calculate estimate', exact: true }).click();
  expect((await request).postDataJSON()).toMatchObject({ plan: 'Twice weekly', kg: 60.5, addons: ['ironing'], zone: 'core', discount: 'none' });
  await expect(form.getByRole('status')).toHaveText('Estimate ready.');
  await verifyLayout(page, testInfo, 'pricing-c-estimate');
});


test('slow hydration keeps estimate controls safe, then preserves the decimal quote', async ({ page }, testInfo) => {
  let releaseScripts;
  const released = new Promise(resolve => { releaseScripts = resolve; });
  const scriptRequests = [];
  const scripts = /^http:\/\/localhost:3100\/_next\/.*\.js(?:\?.*)?$/;
  await page.route(scripts, route => {
    const pending = released.then(() => route.continue());
    scriptRequests.push(pending);
    return pending;
  });
  try {
    await page.goto('/services?plan=Weekly', { waitUntil: 'commit' });
    const form = page.locator('.quoteForm');
    const weight = form.locator('input[type="number"]');
    const catalogue = page.locator('.focusedPlanCatalogue');
    await expect(form).toHaveAttribute('aria-busy', 'true');
    await expect(weight).toBeVisible();
    await expect(weight).toBeDisabled();
    for (const control of await form.locator('input, select, button').all()) await expect(control).toBeDisabled();
    for (const radio of await catalogue.getByRole('radio').all()) await expect(radio).toBeDisabled();
    await catalogue.locator('summary').filter({ hasText: 'Compare all 4 plans' }).click();
    const choice = catalogue.getByRole('button', { name: /^Choose Twice weekly,/ });
    await expect(choice).toBeVisible();
    for (const button of await catalogue.getByRole('button').all()) await expect(button).toBeDisabled();
    await expect(form.getByRole('status')).toHaveText('Preparing estimate…');
    expect(scriptRequests.length).toBeGreaterThan(0);
    releaseScripts();
    await expect(form).toHaveAttribute('aria-busy', 'false');
    await expect(weight).toBeEnabled();
    await expect(choice).toBeEnabled();
    await weight.fill('60.5');
    await expect(weight).toHaveValue('60.5');
    await form.locator('.estimateExtras > summary').click();
    await form.getByRole('checkbox').first().check();
    await expect(weight).toHaveValue('60.5');
    await choice.click();
    await expect(weight).toHaveValue('60.5');
    await expect(form.getByRole('checkbox').first()).toBeChecked();
    await expect(form.getByRole('combobox', { name: 'Collection plan', exact: true })).toHaveValue('Twice weekly');
    const request = page.waitForRequest(req => req.url().endsWith('/api/quote') && req.method() === 'POST');
    await form.getByRole('button', { name: 'Calculate estimate', exact: true }).click();
    expect((await request).postDataJSON()).toMatchObject({ plan: 'Twice weekly', kg: 60.5, addons: ['ironing'], zone: 'core', discount: 'none' });
    await expect(form.getByRole('status')).toHaveText('Estimate ready.');
    await verifyLayout(page, testInfo, 'pricing-hydrated-estimate');
  } finally {
    releaseScripts();
    await Promise.all(scriptRequests);
    await page.unroute(scripts);
  }
});
