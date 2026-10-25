import { test, expect } from '@playwright/test';

// Synthetic loopback fixture only. Closing/reopening a page exercises launch routing,
// not iOS process eviction or Safari/Home Screen storage sharing.
test('valid staff session reopens its workspace without another login', async ({ browser }) => {
  for (const [index, [role, destination]] of Object.entries({ admin: '/admin', vendor: '/vendors', driver: '/drivers', support: '/support' }).entries()) {
    const context = await browser.newContext({ baseURL: 'http://localhost:3100', extraHTTPHeaders: { 'x-forwarded-for': `192.0.2.${160 + index}` } });
    await context.route('**/*', route => new URL(route.request().url()).origin === 'http://localhost:3100' ? route.continue() : route.abort());
    try {
      const login = await context.request.post('/api/login', { headers: { origin: 'http://localhost:3100' }, data: { email: `${role}@example.invalid`, password: `synthetic-${role}-password-123` } });
      expect(login.status()).toBe(200);
      const original = (await context.cookies()).find(cookie => cookie.name === 'bubblewash_staff_session');
      expect(original?.httpOnly).toBe(true);
      expect(original?.expires).toBeGreaterThan(Date.now() / 1000 + 7 * 60 * 60);
      let page = await context.newPage();
      await page.goto('/staff');
      await expect(page).toHaveURL(`http://localhost:3100${destination}`);
      await page.close();
      page = await context.newPage();
      await page.goto('/staff');
      await expect(page).toHaveURL(`http://localhost:3100${destination}`);
      // Wrong-role, repeated and external next inputs cannot create loops or open redirects.
      for (const next of ['/admin', '/drivers', 'https://example.invalid']) {
        await page.goto(`/login?next=${encodeURIComponent(next)}`);
        await expect(page).toHaveURL(`http://localhost:3100${destination}`);
      }
      const retained = (await context.cookies()).find(cookie => cookie.name === 'bubblewash_staff_session');
      // Compare in memory, never write a session value into an artifact.
      expect(retained?.value === original?.value).toBe(true);
      expect(retained?.expires).toBe(original?.expires);
      const logout = await context.request.post('/api/logout', { headers: { origin: 'http://localhost:3100' }, data: {} });
      expect(logout.status()).toBe(200);
      await page.goto('/staff');
      await expect(page.getByRole('heading', { name: 'Staff access', exact: true })).toBeVisible();
      await page.goto(`/login?next=${destination}`);
      await expect(page.getByLabel('Staff username or email')).toBeVisible();
    } finally { await context.close(); }
  }
});
