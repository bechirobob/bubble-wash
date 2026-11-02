import { test, expect } from '@playwright/test';

// UI transport simulation only: no request reaches a database/provider. The paired
// real-handler regression proves transaction/replay behavior against disposable SQLite.
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => {
    const r = route.request();
    return new URL(r.url()).origin === 'http://localhost:3100' && r.method() === 'GET' ? route.continue() : route.abort();
  });
  await page.route('**/api/customer/order', route => route.fulfill({ json: { order: {
    orderId: 'synthetic-retry-order', customer: 'Synthetic customer', createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:00:00Z', status: 'Received', nextStep: 'Confirm pickup', area: 'Synthetic area', pickupAddress: 'Synthetic reception', plan: 'Weekly', service: 'Wash + fold', pickupDate: '', pickupWindow: '', timeline: [],
  }, references: [] } }));
});
async function ready(page) {
  await page.goto('/manage');
  const form = page.locator('.customerRequestForm');
  await expect(form).toBeVisible();
  await form.locator('select[name="action"]').selectOption('care');
  await form.locator('textarea[name="note"]').fill('Synthetic care request');
  return form;
}
test('customer request retains its logical key and draft after a lost response, then rotates after success', async ({ page }) => {
  const payloads = [];
  await page.route('**/api/customer/request', async route => {
    payloads.push(route.request().postDataJSON());
    if (payloads.length === 1) return route.abort('connectionreset');
    return route.fulfill({ json: { ok: true, ticketId: 'synthetic-case', replayed: payloads.length === 2, message: 'Synthetic request saved' } });
  });
  const form = await ready(page), send = form.getByRole('button', { name: 'Send request', exact: true });
  await send.click();
  await expect.poll(() => payloads.length).toBe(1);
  await expect(send).toBeEnabled();
  await expect(form.locator('textarea')).toHaveValue('Synthetic care request');
  await send.click();
  await expect(form.getByRole('status')).toHaveText('Synthetic request saved');
  expect(payloads).toHaveLength(2);
  expect(payloads[0].idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
  expect(payloads[1]).toEqual(payloads[0]);
  await expect(form.locator('textarea')).toHaveValue('');
  await form.locator('select[name="action"]').selectOption('care');
  await form.locator('textarea').fill('Synthetic care request');
  await send.click();
  await expect.poll(() => payloads.length).toBe(3);
  expect(payloads[2].idempotencyKey).not.toBe(payloads[1].idempotencyKey);
});
test('same-frame repeated customer submits send one request while pending', async ({ page }) => {
  let calls = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/customer/request', async route => {
    calls++;
    await held;
    await route.fulfill({ json: { ok: true, ticketId: 'synthetic-one-case', message: 'Synthetic request saved' } });
  });
  const form = await ready(page);
  await form.evaluate(node => { node.requestSubmit(); node.requestSubmit(); });
  await expect.poll(() => calls).toBe(1);
  await expect(form.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  release();
  await expect(form.getByRole('status')).toHaveText('Synthetic request saved');
  expect(calls).toBe(1);
});
test('editing a failed request starts a new logical request instead of reusing its key', async ({ page }) => {
  const payloads = [];
  await page.route('**/api/customer/request', route => {
    payloads.push(route.request().postDataJSON());
    return payloads.length === 1 ? route.abort('connectionreset') : route.fulfill({ json: { ok: true, ticketId: 'synthetic-edited-case', message: 'Synthetic edited request saved' } });
  });
  const form = await ready(page), send = form.getByRole('button', { name: 'Send request', exact: true });
  await send.click();
  await expect.poll(() => payloads.length).toBe(1);
  await expect(send).toBeEnabled();
  await form.locator('textarea').fill('Changed synthetic care request');
  await send.click();
  await expect(form.getByRole('status')).toHaveText('Synthetic edited request saved');
  expect(payloads).toHaveLength(2);
  expect(payloads[1].idempotencyKey).not.toBe(payloads[0].idempotencyKey);
  expect(payloads[1].note).toBe('Changed synthetic care request');
});

test('request-specific fields preserve drafts without submitting irrelevant pickup details', async ({ page }, testInfo) => {
  const payloads = [];
  await page.route('**/api/customer/request', route => {
    payloads.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, json: { ok: false, error: 'Synthetic request unavailable' } });
  });
  await page.goto('/manage');
  const form = page.locator('.customerRequestForm');
  const action = form.getByRole('combobox', { name: 'Request', exact: true });
  const date = form.locator('input[name="requestedDate"]');
  const window = form.locator('select[name="requestedWindow"]');
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await date.fill(tomorrow);
  await window.selectOption('10:00–12:00');
  await form.getByRole('textbox', { name: 'Details', exact: true }).fill('Synthetic garment-care draft');
  await action.selectOption('care');
  await expect(date).toBeHidden(); await expect(date).toBeDisabled();
  await expect(window).toBeHidden(); await expect(window).toBeDisabled();
  await form.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(form.getByRole('status')).toHaveText('Synthetic request unavailable');
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).not.toHaveProperty('requestedDate');
  expect(payloads[0]).not.toHaveProperty('requestedWindow');
  await expect(action).toHaveValue('care');
  await expect(form.getByRole('textbox', { name: 'Details', exact: true })).toHaveValue('Synthetic garment-care draft');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('customer-care-request.png'), fullPage: true });
  await action.selectOption('reschedule');
  await expect(date).toBeVisible(); await expect(date).toHaveValue(tomorrow);
  await expect(window).toHaveValue('10:00–12:00');
  await page.screenshot({ path: testInfo.outputPath('customer-reschedule-draft.png'), fullPage: true });
});
