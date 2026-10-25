import { test, expect } from '@playwright/test';
import { orders, records } from '../visual-fixture/data.ts';

async function signIn(page, role) {
  await page.route('**/*', route => new URL(route.request().url()).hostname === 'localhost' ? route.continue() : route.abort());
  await page.goto('/login');
  await page.getByLabel('Staff username or email').fill(`${role}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill(`synthetic-${role}-password-123`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
async function fixtureOrders(page, rows) {
  await page.route('**/api/orders?*', route => route.fulfill({ json: { ok: true, orders: rows, nextOffset: null } }));
  await page.route('**/api/orders', route => route.fulfill({ json: { ok: true, orders: rows, nextOffset: null } }));
}

test('approved service board stays compact and history tools are secondary', async ({ page }, testInfo) => {
  await signIn(page, 'admin');
  await fixtureOrders(page, orders);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Service board', exact: true })).toBeVisible();
  await expect(page.locator('.staffDecisionSheet')).toContainText('BW-1038');
  await expect(page.locator('.staffAccountMenu')).not.toHaveAttribute('open', '');
  await expect(page.locator('.staffTopbar')).toHaveCSS('min-height', '60px');
  const washing = page.getByRole('button', { name: /Washing/ }).first();
  await washing.click();
  await expect(washing).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.staffStageLane.selected')).toContainText('BW-1036');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('service-board.png'), fullPage: true });
  await page.goto('/admin?view=activity');
  const tools = page.locator('.activityTools');
  await expect(tools).not.toHaveAttribute('open', '');
  await tools.locator('summary').click();
  await expect(tools.getByLabel('Date', { exact: true })).toBeVisible();
  await expect(tools.getByRole('option', { name: 'Last 24 hours', exact: true })).toHaveCount(1);
  await page.goto('/admin?view=people');
  await expect(page.locator('.staffAccessDisclosure')).not.toHaveAttribute('open', '');
  await expect(page.locator('.staffAccountPanel')).toBeVisible();
});

test('vendor current job retains intake draft across refresh reordering', async ({ page }, testInfo) => {
  await signIn(page, 'vendor');
  const job = { ...orders[2], vendor: 'Synthetic vendor', status: 'At Vendor', workflowStage: { ...orders[2].workflowStage, key: 'at-vendor', label: 'At Vendor' } };
  let rows = [job, { ...orders[4], vendor: 'Synthetic vendor' }];
  await page.route('**/api/orders?*', route => route.fulfill({ json: { ok: true, orders: rows, nextOffset: null } }));
  await page.goto('/vendors');
  await expect(page.locator('.staffWorkTicket')).toContainText('BW-1036');
  await page.locator('.staffWorkTicket').getByRole('button', { name: 'Confirm bag intake', exact: true }).click();
  await page.getByLabel('Bag/item count', { exact: true }).fill('3');
  rows = [...rows].reverse();
  await page.locator('.staffRoleLedger').getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByLabel('Bag/item count', { exact: true })).toHaveValue('3');
  await expect(page.locator('.staffWorkTicket')).toContainText('BW-1036');
  rows = rows.filter(order => order.orderId !== job.orderId);
  await page.locator('.staffRoleLedger').getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByLabel('Bag/item count', { exact: true })).toHaveValue('3');
  await expect(page.getByLabel('Bag/item count', { exact: true })).toBeDisabled();
  await expect(page.locator('.staffWorkTicket')).toContainText('actions are paused');
  await page.screenshot({ path: testInfo.outputPath('vendor-intake.png'), fullPage: true });
});

test('rider vendor collection does not display customer destination or unrelated ETA', async ({ page }, testInfo) => {
  await signIn(page, 'driver');
  const ready = { ...orders[2], driver: 'Synthetic driver', status: 'Ready', workflowStage: { ...orders[2].workflowStage, key: 'ready', label: 'Ready' }, dispatch: { ...orders[2].dispatch, etaSource: 'area-estimate', etaText: '18 min' } };
  await fixtureOrders(page, [ready]);
  await page.goto('/drivers');
  await expect(page.locator('.staffWorkTicket h2')).toHaveText(ready.vendor);
  await expect(page.locator('.staffStopAddress')).toContainText('Vendor collection');
  await expect(page.locator('.staffStopAddress')).not.toContainText(ready.pickupAddress);
  await expect(page.locator('.staffRouteFacts')).toContainText('Vendor destination needed');
  await expect(page.locator('.staffTicketNavigation').getByRole('link', { name: 'Directions', exact: true })).toHaveCount(0);
  await expect(page.locator('.staffTicketNavigation').getByRole('link', { name: 'Scan bag', exact: true })).toHaveAttribute('href', '/scan');
  await page.screenshot({ path: testInfo.outputPath('rider-vendor-collection.png'), fullPage: true });
});

test('support dossier preserves case draft and failed writes never claim success', async ({ page }, testInfo) => {
  await signIn(page, 'support');
  await page.route('**/api/submissions', route => route.fulfill({ json: { ok: true, records } }));
  await page.route('**/api/staff/automation/case?*', route => { const id = new URL(route.request().url()).searchParams.get('caseId'); return route.fulfill({ json: { ok: true, records: records.filter(row => row.data.ticketId === id) } }); });
  await page.route('**/api/submit', route => route.fulfill({ status: 503, json: { ok: false, error: 'Synthetic save unavailable' } }));
  await page.goto('/support');
  await expect(page.locator('.staffCaseDeskDossier')).toContainText('CASE-018');
  await page.getByLabel('Case note', { exact: true }).fill('Draft to retain');
  await page.locator('.staffCaseDeskIndex').getByRole('link').filter({ hasText: 'CASE-021' }).click();
  await expect(page.locator('.staffCaseDeskDossier')).toContainText('CASE-021');
  await page.locator('.staffCaseDeskIndex').getByRole('link').filter({ hasText: 'CASE-018' }).click();
  await expect(page.getByLabel('Case note', { exact: true })).toHaveValue('Draft to retain');
  await page.getByRole('button', { name: 'Save case action', exact: true }).click();
  await expect(page.locator('.staffCaseDeskDossier')).toContainText('Synthetic save unavailable');
  await expect(page.getByLabel('Case note', { exact: true })).toHaveValue('Draft to retain');
  await page.screenshot({ path: testInfo.outputPath('support-save-failure.png'), fullPage: true });
});
