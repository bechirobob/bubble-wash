import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.context().route('**/*', route => new URL(route.request().url()).hostname === 'localhost' ? route.continue() : route.abort());
});

async function verifyLayout(page, testInfo, name) {
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
  await expect(catalogue.getByRole('article')).toHaveCount(1);
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect(catalogue.getByRole('radio', { name: 'Twice weekly, 2 pickups / week', exact: true })).toBeChecked();
  await expect(catalogue.locator('.focusedPlanCard h3')).toHaveText('Twice weekly');
  await expect(catalogue.locator('.focusedPlanPrice strong')).toContainText('2,250');
  await expect(catalogue.getByRole('status')).toContainText('Twice weekly selected');
  await expect.poll(() => catalogue.locator('.focusedPlanSegment:has(input:focus-visible)').count()).toBe(1);
  await page.keyboard.press('ArrowRight');
  await expect(catalogue.locator('.focusedPlanCard h3')).toHaveText('Three times weekly');
  await page.keyboard.press('ArrowRight');
  await expect(catalogue.locator('.focusedPlanCard h3')).toHaveText('Contract');
  await expect(catalogue.locator('.focusedPlanPrice strong')).toContainText('4,750');
  await page.keyboard.press('ArrowRight');
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
  await weight.fill('60.5');
  await form.locator('.estimateExtras > summary').click();
  await form.getByRole('checkbox').first().check();
  const catalogue = page.locator('.focusedPlanCatalogue');
  await catalogue.locator('summary').filter({ hasText: 'Compare all 4 plans' }).click();
  await catalogue.getByRole('button', { name: /^Choose Twice weekly,/ }).click();
  await expect(weight).toHaveValue('60.5');
  await expect(form.getByRole('checkbox').first()).toBeChecked();
  await expect(form.getByLabel('Collection plan', { exact: true })).toHaveValue('Twice weekly');
  await catalogue.getByRole('link', { name: 'Estimate my cost' }).click();
  await expect(page).toHaveURL(/#estimate-heading$/);
  const request = page.waitForRequest(req => req.url().endsWith('/api/quote') && req.method() === 'POST');
  await form.getByRole('button', { name: 'Calculate estimate', exact: true }).click();
  expect((await request).postDataJSON()).toMatchObject({ plan: 'Twice weekly', kg: 60.5, addons: ['ironing'], zone: 'core', discount: 'none' });
  await expect(form.getByRole('status')).toHaveText('Estimate ready.');
  await verifyLayout(page, testInfo, 'pricing-c-estimate');
});
