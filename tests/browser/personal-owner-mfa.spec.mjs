import { test, expect } from '@playwright/test';

// Presentation contract only. Real credential/MFA enforcement is covered by
// personal-owner-mfa.integration and personal-owner-http with global MFA=false.
test('personal MFA enrollment appears only after credential-verified response', async ({ page }) => {
  await page.route('**/api/login', async route => {
    const valid = route.request().postDataJSON().password === 'synthetic-valid-password';
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
  await expect(page.getByRole('alert')).toContainText('Invalid Bubble Wash');
  await expect(page.getByRole('link', { name:'Set up admin authenticator' })).toHaveCount(0);
  await page.getByLabel('Password', { exact:true }).fill('synthetic-valid-password');
  await page.getByRole('button', { name:'Sign in', exact:true }).click();
  await expect(page.getByRole('link', { name:'Set up admin authenticator' })).toHaveAttribute('href','/admin/mfa/enroll');
  await page.getByLabel('Staff username or email').fill('another@example.invalid');
  await expect(page.getByRole('link', { name:'Set up admin authenticator' })).toHaveCount(0);
});

test('personal MFA code field is dynamic when global MFA UI is disabled', async ({ page }) => {
  await page.route('**/api/login', route => {
    const correct = route.request().postDataJSON().totp === '654321';
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
