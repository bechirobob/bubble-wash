import { test, expect } from '@playwright/test';

// UI simulation and actual temporary-fixture journeys are explicitly separated.
// The fixture sanitizes credentials, blocks provider egress and deletes SQLite
// on teardown. No production accounts, delivery or external services are used.
test.use({ serviceWorkers: 'block' });
const origin = 'http://localhost:3100';
const projects = ['portrait-320', 'portrait-390', 'webkit-portrait-390', 'desktop-1440'];
test.beforeEach(async ({ page }, testInfo) => {
  const index = projects.indexOf(testInfo.project.name);
  expect(index).toBeGreaterThanOrEqual(0);
  // Reserved synthetic clients keep genuine rate limits independent per device.
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': `192.0.2.${120 + index}` });
  await page.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    const allowedWrite = request.method() === 'POST' && ['/api/privacy/requests', '/api/customer/recover'].includes(url.pathname);
    return url.origin === origin && (request.method() === 'GET' || allowedWrite) ? route.continue() : route.abort();
  });
});
async function fillSignup(page, name = 'Synthetic signup') {
  const form = page.locator('.earlyAccessForm');
  await form.locator('input[name="firstName"]').fill(name);
  await form.locator('input[name="phone"]').fill('0200000000');
  await form.locator('input[name="email"]').fill('signup@example.invalid');
  await form.locator('select[name="area"]').selectOption('Osu');
  await form.locator('select[name="frequency"]').selectOption('Weekly');
  return form;
}

test('early access validates consent and renders saved versus updated transport results honestly', async ({ page }, testInfo) => {
  const payloads = [];
  await page.route('**/api/early-access', route => {
    expect(route.request().method()).toBe('POST');
    payloads.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true, updated: payloads.length > 1,
      message: payloads.length > 1 ? 'Your early-access details were updated.' : 'You are on the Bubble Wash early-access list.',
      confirmation: { whatsapp: 'queued', email: 'skipped' } } });
  });
  await page.goto('/early-access');
  const join = page.getByRole('button', { name: 'Join early access', exact: true });
  await join.click();
  expect(await page.locator('.earlyAccessForm').evaluate(form => form.checkValidity())).toBe(false);
  expect(payloads).toHaveLength(0);
  let form = await fillSignup(page);
  await join.click();
  expect(await form.locator('input[name="consent"]').evaluate(input => input.validity.valueMissing)).toBe(true);
  expect(payloads).toHaveLength(0);
  await form.locator('input[name="consent"]').check();
  await join.click();
  await expect(page.getByRole('heading', { name: 'We saved your early-access request.', exact: true })).toBeVisible();
  expect(payloads).toEqual([{ firstName:'Synthetic signup', phone:'0200000000', email:'signup@example.invalid', area:'Osu', frequency:'Weekly', website:'', consent:true }]);
  await expect(page.locator('.earlyAccessPanel .recordList dd')).toHaveText(['Waiting to send; not delivered yet', 'Not sent; follow-up needed']);
  await page.getByRole('button', { name:'Update another signup', exact:true }).click();
  form = await fillSignup(page, 'Synthetic updated signup');
  await form.locator('input[name="consent"]').check();
  await join.click();
  await expect(page.getByRole('heading', { name:'Your details are up to date.', exact:true })).toBeVisible();
  expect(payloads).toHaveLength(2);
  expect(payloads[1].phone).toBe(payloads[0].phone);
  expect(payloads[1].firstName).toBe('Synthetic updated signup');
  // This is UI contract proof only; real-handler deduplication has a paired test.
  await page.screenshot({path:testInfo.outputPath('early-access-updated.png'),fullPage:true});
});

test('early access retains the draft after API failure and never presents false success', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/early-access', route => { calls++; return route.fulfill({status:503,json:{ok:false,error:'Unable to save your early-access request.'}}); });
  await page.goto('/early-access');
  const form = await fillSignup(page);
  await form.locator('input[name="consent"]').check();
  await form.getByRole('button', {name:'Join early access',exact:true}).click();
  await expect(form.getByRole('alert')).toHaveText('Unable to save your early-access request.');
  expect(calls).toBe(1);
  await expect(form.locator('input[name="firstName"]')).toHaveValue('Synthetic signup');
  await expect(form.locator('input[name="phone"]')).toHaveValue('0200000000');
  await expect(form.locator('input[name="consent"]')).toBeChecked();
  await expect(form.getByRole('button', {name:'Join early access',exact:true})).toBeEnabled();
  await expect(page.getByRole('heading',{name:'We saved your early-access request.',exact:true})).toHaveCount(0);
});

test('privacy request is saved by the real fixture handler and appears in the authenticated admin queue', async ({ page }, testInfo) => {
  await page.goto('/privacy');
  const form = page.locator('.policyRequestForm');
  const name = `Synthetic privacy ${testInfo.project.name}`;
  await form.locator('input[name="name"]').fill(name);
  await form.locator('input[name="contact"]').fill('privacy-audit@example.invalid');
  await form.locator('select[name="requestType"]').selectOption('deletion');
  const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/privacy/requests' && response.request().method() === 'POST');
  await form.getByRole('button', {name:'Submit privacy request',exact:true}).click();
  const response = await received;
  expect(response.status()).toBe(200);
  const saved = await response.json();
  expect(saved.ok).toBe(true); expect(saved.id).toMatch(/^PR-[A-F0-9]{16}$/);
  await expect(form.getByRole('status')).toContainText(`Reference: ${saved.id}`);
  await expect(form.locator('input[name="name"]')).toHaveValue('');
  const login = await page.context().request.post('/api/login', {headers:{origin,'x-forwarded-for':`192.0.2.${140 + projects.indexOf(testInfo.project.name)}`},data:{email:'admin@example.invalid',password:'synthetic-admin-password-123'}});
  expect(login.status()).toBe(200);
  expect((await page.context().cookies()).some(cookie => cookie.name === 'bubblewash_staff_session' && cookie.httpOnly)).toBe(true);
  await page.goto('/admin?view=operations');
  const row = page.locator('.privacyOpsRow').filter({hasText:saved.id});
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(name);
  await expect(row).toContainText('privacy-audit@example.invalid');
  await expect(row).toContainText('deletion');
  await expect(row).toContainText('received');
  await expect(page.getByText('These controls record status only; they do not carry out the requested work.',{exact:false})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('privacy-request-admin-queue.png'),fullPage:true});
});

test('customer recovery reports unavailable email transport without claiming a link was sent', async ({ page }, testInfo) => {
  await page.goto('/manage');
  await expect(page.locator('.manageAccessForm')).toBeVisible();
  await page.getByText('Recover a lost reference or handoff code',{exact:true}).click();
  await page.getByLabel('Booking email',{exact:true}).fill('recovery-audit@example.invalid');
  const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/customer/recover' && response.request().method() === 'POST');
  await page.getByRole('button',{name:'Send recovery link',exact:true}).click();
  expect((await received).status()).toBe(503);
  const status = page.locator('.manageAccessForm').getByRole('status');
  await expect(status).toContainText('Email recovery is temporarily unavailable.');
  await expect(status).not.toContainText('a recovery link will be sent');
  await expect(page.getByLabel('Booking email',{exact:true})).toHaveValue('recovery-audit@example.invalid');
  await page.screenshot({path:testInfo.outputPath('customer-recovery-unavailable.png'),fullPage:true});
});
