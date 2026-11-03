import { test, expect, expectCustomerFailure } from './customer-error-fixture.mjs';

// Transport-only synthetic responses: no submitted data reaches a provider or DB.
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  expectCustomerFailure(page, { kind: 'response', path: '/api/customer/order', method: 'GET', status: 401 });
  await page.route('**/*', route => {
    const request = route.request();
    return new URL(request.url()).origin === 'http://localhost:3100' && request.method() === 'GET'
      ? route.continue() : route.abort();
  });
});

test('privacy distinguishes pending and unfamiliar errors from success and retains the draft', async ({ page }, testInfo) => {
  let release, calls = 0;
  const held = new Promise(resolve => { release = resolve; });
  expectCustomerFailure(page, { kind: 'response', path: '/api/privacy/requests', method: 'POST', status: 503 });
  await page.route('**/api/privacy/requests', async route => {
    calls++;
    if (calls === 1) {
      await held;
      return route.fulfill({ status: 503, json: { ok: false, error: 'Service is taking a break. Please try again.' } });
    }
    return route.fulfill({ json: { ok: true, message: 'Request received.', id: 'PR-SYNTHETIC' } });
  });
  await page.goto('/privacy');
  const form = page.locator('.policyRequestForm');
  await form.locator('[name="name"]').fill('Synthetic person');
  await form.locator('[name="contact"]').fill('privacy@example.invalid');
  await form.locator('[name="requestType"]').selectOption('correction');
  await form.getByRole('button', { name: 'Submit privacy request' }).click();
  await expect(form.getByRole('status')).toHaveText('Saving your request…');
  await expect(form.getByRole('status')).not.toHaveClass(/success|error/);
  await expect(form.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  release();
  await expect(form.getByRole('alert')).toHaveText('Service is taking a break. Please try again.');
  await expect(form.getByRole('alert')).toHaveClass(/error/);
  await expect(form.locator('[name="name"]')).toHaveValue('Synthetic person');
  await expect(form.locator('[name="contact"]')).toHaveValue('privacy@example.invalid');
  await expect(form.locator('[name="requestType"]')).toHaveValue('correction');
  await page.screenshot({ path: testInfo.outputPath('privacy-retry-feedback.png'), fullPage: true });
  await form.getByRole('button', { name: 'Submit privacy request' }).click();
  await expect(form.getByRole('status')).toHaveText('Request received. Reference: PR-SYNTHETIC');
  await expect(form.getByRole('status')).toHaveClass(/success/);
  await expect(form.locator('[name="name"]')).toHaveValue('');
  expect(calls).toBe(2);
});

test('booking preserves failed draft and focuses confirmed result only after success', async ({ page }, testInfo) => {
  const payloads = [];
  expectCustomerFailure(page, { kind: 'response', path: '/api/submit', method: 'POST', status: 503 });
  await page.route('**/api/submit', route => {
    payloads.push(route.request().postDataJSON());
    return payloads.length === 1
      ? route.fulfill({ status: 503, json: { ok: false, error: 'Unable to save this pickup. Please try again.' } })
      : route.fulfill({ json: { ok: true, id: 'synthetic-private-tracking-token', bookingReference: 'BW-901', message: 'Pickup requested.', deliveryCode: 'SYNTHETIC-CODE' } });
  });
  await page.goto('/book');
  const form = page.locator('.bookingForm');
  await expect(form).toBeVisible();
  await form.locator('[name="businessType"]').selectOption('Office or small team');
  await form.locator('[name="laundryRhythm"]').selectOption('About once a week');
  await form.locator('[name="locationCount"]').selectOption('1 location');
  await form.locator('[name="servicePriority"]').selectOption('Standard scheduled service');
  await form.locator('[name="name"]').fill('Synthetic booking');
  await form.locator('[name="email"]').fill('booking@example.invalid');
  await form.locator('[name="phone"]').fill('0200000000');
  await form.locator('[name="company"]').fill('Synthetic business');
  await form.locator('[name="pickupAddress"]').fill('Synthetic reception, Osu');
  await form.locator('[name="pickupDate"]').fill(new Date(Date.now() + 86400000).toISOString().slice(0, 10));
  await form.locator('[name="pickupWindow"]').selectOption('10:00–12:00');
  await form.locator('.termsCheck input').check();
  const send = form.getByRole('button', { name: 'Request pickup', exact: true });
  await send.click();
  await expect(form.getByRole('status')).toHaveText('Unable to save this pickup. Please try again.');
  await expect(page.locator('#booking-confirmation-title')).toHaveCount(0);
  await expect(form.locator('[name="name"]')).toHaveValue('Synthetic booking');
  await expect(form.locator('[name="pickupAddress"]')).toHaveValue('Synthetic reception, Osu');
  await expect(form.locator('.termsCheck input')).toBeChecked();
  await send.click();
  const heading = page.locator('#booking-confirmation-title');
  await expect(heading).toHaveText('BW-901');
  await expect(heading).toBeFocused();
  await expect(send).toBeDisabled();
  expect(payloads).toHaveLength(2);
  expect(payloads[1].idempotencyKey).toBe(payloads[0].idempotencyKey);
  await expect(page.locator('.bookingConfirmation').getByRole('link', { name: 'Private tracking link' })).toHaveAttribute('href', '/track#tracking=synthetic-private-tracking-token');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('booking-confirmation-focus.png'), fullPage: true });
});
