import { test, expect } from '@playwright/test';

// These two tests require intercepted synthetic login responses. Real worker/login
// behavior remains covered by the separate PWA and four-role browser suites.
test.use({ serviceWorkers: 'block' });

// Synthetic presentation diagnostics only: never print credentials, codes or response prose.
function observeLogin(page, testInfo) {
  const counts = { request: 0, mock: 0, response: 0, failed: 0 };
  const loginRequest = request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/login';
  const report = (kind, details = {}) => {
    counts[kind]++;
    if (counts[kind] <= 12) console.log(JSON.stringify({ fixture: 'mfa-presentation', project: testInfo.project.name, test: testInfo.title, kind, sequence: counts[kind], ...details }));
  };
  page.on('request', request => { if (loginRequest(request)) report('request'); });
  page.on('requestfailed', request => { if (loginRequest(request)) report('failed'); });
  page.on('response', async response => {
    if (!loginRequest(response.request())) return;
    const details = { status: response.status(), serviceWorker: response.fromServiceWorker(), classification: 'unreadable' };
    try {
      const data = await response.json();
      details.classification = data.mfaStep === 'enroll' ? 'enroll' : data.mfaStep === 'verify' ? 'verify' : data.ok === true ? 'success' : data.ok === false ? 'rejected-without-mfa-step' : 'other-json';
    } catch { /* A bounded classification, not raw network or response data. */ }
    report('response', details);
  });
  return (classification, status) => report('mock', { classification, status });
}


// Presentation contract only. Real credential/MFA enforcement is covered by
// personal-owner-mfa.integration and personal-owner-http with global MFA=false.
test('personal MFA enrollment appears only after credential-verified response', async ({ page }, testInfo) => {
  const mockHandled = observeLogin(page, testInfo);
  await page.route('**/api/login', async route => {
    const valid = route.request().postDataJSON().password === 'synthetic-valid-password';
    mockHandled(valid ? 'enroll' : 'rejected-without-mfa-step', valid ? 403 : 401);
    await route.fulfill({ status: valid ? 403 : 401, contentType: 'application/json', body: JSON.stringify(valid
      ? { ok:false, mfaStep:'enroll', error:'Set up your personal authenticator before opening staff workspaces.' }
      : { ok:false, error:'Invalid Bubble Wash staff credentials.' }) });
  });
  await page.goto('/login');
  await expect(page.getByRole('button', { name:'Sign in', exact:true })).toBeEnabled();
  await expect(page.getByRole('link', { name:'Set up admin authenticator' })).toHaveCount(0);
  await page.getByLabel('Staff username or email').fill('synthetic-owner@example.invalid');
  await page.getByLabel('Password', { exact:true }).fill('wrong-password');
  await page.getByRole('button', { name:'Sign in', exact:true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /^Invalid Bubble Wash staff credentials\.$/ })).toHaveText('Invalid Bubble Wash staff credentials.');
  await expect(page.getByRole('link', { name:'Set up admin authenticator' })).toHaveCount(0);
  await page.getByLabel('Password', { exact:true }).fill('synthetic-valid-password');
  await page.getByRole('button', { name:'Sign in', exact:true }).click();
  await expect(page.getByRole('link', { name:'Set up admin authenticator' })).toHaveAttribute('href','/admin/mfa/enroll');
  await page.getByLabel('Staff username or email').fill('another@example.invalid');
  await expect(page.getByRole('link', { name:'Set up admin authenticator' })).toHaveCount(0);
});

test('personal MFA code field is dynamic when global MFA UI is disabled', async ({ page }, testInfo) => {
  const mockHandled = observeLogin(page, testInfo);
  await page.route('**/api/login', route => {
    const correct = route.request().postDataJSON().totp === '654321';
    mockHandled(correct ? 'success' : 'verify', correct ? 200 : 401);
    return route.fulfill({ status:correct ? 200 : 401, contentType:'application/json', body:JSON.stringify(correct ? { ok:true, next:'/owner-mfa-fixture-success' } : { ok:false, mfaStep:'verify', error:'Enter your personal authenticator or recovery code.' }) });
  });
  await page.route('**/owner-mfa-fixture-success', route => route.fulfill({ status:200, contentType:'text/html', body:'<p>Synthetic successful sign-in</p>' }));
  await page.goto('/login');
  const code = page.getByLabel('Admin authenticator or recovery code', { exact:false });
  await expect(code).toHaveCount(0);
  await page.getByLabel('Staff username or email').fill('synthetic-owner@example.invalid');
  await page.getByLabel('Password', { exact:true }).fill('synthetic-valid-password');
  await page.getByRole('button', { name:'Sign in', exact:true }).click();
  await expect(code).toBeVisible();
  await expect(page.getByLabel('Password', { exact:true })).toHaveValue('synthetic-valid-password');
  await code.fill('123456');
  await page.getByRole('button', { name:'Sign in', exact:true }).click();
  await expect(code).toBeVisible();
  await expect(code).toHaveValue('123456');
  await code.fill('654321');
  await page.getByRole('button', { name:'Sign in', exact:true }).click();
  await expect(page).toHaveURL(/owner-mfa-fixture-success$/);
  await page.goto('/login');
  await page.getByLabel('Staff username or email').fill('synthetic-owner@example.invalid');
  await page.getByLabel('Password', { exact:true }).fill('synthetic-valid-password');
  await page.getByRole('button', { name:'Sign in', exact:true }).click();
  await expect(code).toBeVisible();
  await page.getByLabel('Staff username or email').fill('another@example.invalid');
  await expect(code).toHaveCount(0);
});
