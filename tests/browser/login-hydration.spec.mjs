import { test, expect } from '@playwright/test';

test('staff sign-in cannot submit while JavaScript is unavailable', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL: 'http://localhost:3100' });
  context.setDefaultTimeout(15_000);
  context.setDefaultNavigationTimeout(20_000);
  try {
    await context.route('**/*', route => new URL(route.request().url()).hostname === 'localhost' ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto('/login?next=%2Fadmin');
    await expect(page.getByLabel('Staff username or email')).toBeDisabled();
    await expect(page.getByLabel('Password', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeDisabled();
    await expect(page.locator('form')).toHaveAttribute('method', 'post');
    await expect(page.locator('form')).toHaveAttribute('aria-busy', 'true');
    // Playwright's text matcher intentionally skips NOSCRIPT; read its DOM text directly.
    await expect.poll(() => page.locator('noscript').textContent()).toContain('JavaScript is required');
    // Credential controls remain unnamed, so even a forced native submission
    // cannot serialize credentials. Enabled keyboard sign-in is covered by the journey.
    await expect(page.locator('form input[name]')).toHaveCount(0);
  } finally { await context.close(); }
});
