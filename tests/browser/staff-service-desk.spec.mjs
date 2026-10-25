import { test, expect } from '@playwright/test';
import { orders, records } from '../visual-fixture/data.ts';

// Route-fulfilled data belongs to this interaction suite, not the PWA suite.
// A controlling worker can bypass Playwright routing, especially in WebKit.
// Real worker/session behavior remains covered by the dedicated PWA tests.
test.use({ serviceWorkers: 'block' });

// This suite tests workspace interaction; the existing four-role journey tests
// browser form sign-in. Authenticate before the first document so a late login
// router navigation cannot discard the page's synthetic API route handlers.
async function signIn(page, role) {
  // The loopback fixture explicitly trusts these TEST-NET clients. Keep the real
  // 10/minute login limiter intact; each role/device is a distinct test client.
  // Early acceptance plus the full suite uses at most two logins per identity.
  const projectIndex = ['portrait-320', 'portrait-390', 'webkit-portrait-390', 'desktop-1440'].indexOf(test.info().project.name);
  const roleIndex = ['admin', 'vendor', 'driver', 'support'].indexOf(role);
  expect(projectIndex).toBeGreaterThanOrEqual(0);
  expect(roleIndex).toBeGreaterThanOrEqual(0);
  const syntheticClientIp = `192.0.2.${200 + projectIndex * 4 + roleIndex}`;
  await page.route('**/*', route => new URL(route.request().url()).origin === 'http://localhost:3100' ? route.continue() : route.abort());
  const login = await page.context().request.post('/api/login', {
    headers: { origin: 'http://localhost:3100', 'x-forwarded-for': syntheticClientIp },
    data: { email: `${role}@example.invalid`, password: `synthetic-${role}-password-123` },
  });
  expect(login.status()).toBe(200);
  expect((await page.context().cookies()).some(cookie => cookie.name === 'bubblewash_staff_session' && cookie.httpOnly)).toBe(true);
  expect((await page.context().request.get('/api/orders')).status()).toBe(200);
}
async function fixtureOrders(page, readRows) {
  let fulfilled = 0;
  const respond = route => { fulfilled++; return route.fulfill({ json: { ok: true, orders: typeof readRows === 'function' ? readRows() : readRows, nextOffset: null } }); };
  await page.route('**/api/orders?*', respond);
  await page.route('**/api/orders', respond);
  return () => expect.poll(() => fulfilled, { message: 'Workspace fetched the intended synthetic order projection' }).toBeGreaterThan(0);
}

async function expectStaffControlLinks(page) {
  const controls = page.locator('.portalPage.staffDesk :is(.staffSectionNav a, .staffAccountMenuBody a, a.button, a.brand, .staffSectionHeader > a, a.staffLaneLink, .staffDeskFoot a, .staffCapacityStrip > a, a.staffBackLink, a.staffTicketDetails, .staffCaseDeskOrder > a, .customerContactActions > a)');
  expect(await controls.count()).toBeGreaterThan(0);
  const underlined = await controls.evaluateAll(links => links.filter(link => link.getClientRects().length && getComputedStyle(link).textDecorationLine !== 'none').map(link => link.textContent?.trim()));
  expect(underlined, 'Staff navigation and action links do not inherit browser underlines').toEqual([]);
  const navigation = page.locator('.staffSectionNav a');
  await navigation.first().focus();
  await page.keyboard.press('Tab');
  await expect(navigation.nth(1)).toBeFocused();
  await expect(navigation.nth(1)).toHaveCSS('outline-style', 'solid');
  await expect(navigation.nth(1)).toHaveCSS('outline-width', '2px');
}

test('approved service board stays compact and history tools are secondary', async ({ page }, testInfo) => {
  await signIn(page, 'admin');
  const assertOrdersRead = await fixtureOrders(page, orders);
  await page.goto('/admin');
  await assertOrdersRead();
  await expect(page.getByRole('heading', { name: 'Service board', exact: true })).toBeVisible();
  await expect(page.locator('.staffDecisionSheet')).toContainText('BW-1038');
  await expect(page.locator('.staffAccountMenu')).not.toHaveAttribute('open', '');
  await expect(page.locator('.staffTopbar')).toHaveCSS('min-height', '60px');
  const washing = page.getByRole('button', { name: /Washing/ }).first();
  await washing.click();
  await expect(washing).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.staffStageLane.selected')).toContainText('BW-1036');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectStaffControlLinks(page);
  const followUp = page.getByRole('navigation', { name: 'Operations follow-up', exact: true });
  await expect(followUp).toHaveCSS('display', 'flex');
  await expect(followUp).toHaveCSS('flex-wrap', 'wrap');
  await expect(followUp.getByRole('link')).toHaveText([/^\d+ available riders$/, /^\d+ open cases in recent records$/, /^\d+ vendors$/, 'Recent changes']);
  expect(await followUp.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href')))).toEqual(['/admin?view=dispatch', '/admin?view=cases', '/admin?view=people', '/admin?view=activity']);
  const targets = await followUp.getByRole('link').evaluateAll(links => links.map(link => { const box = link.getBoundingClientRect(); return { x: box.x, right: box.right, y: box.y, bottom: box.bottom, height: box.height }; }));
  expect(targets).toHaveLength(4);
  for (const target of targets) expect(target.height).toBeGreaterThanOrEqual(44);
  for (let i = 0; i < targets.length; i++) for (let j = i + 1; j < targets.length; j++) {
    const a = targets[i], b = targets[j];
    if (Math.abs(a.y - b.y) < 1) expect(b.x - a.right, 'Separate follow-up actions have a horizontal gap').toBeGreaterThanOrEqual(16);
    else expect(b.y - a.bottom, 'Wrapped follow-up actions have a vertical gap').toBeGreaterThanOrEqual(6);
  }
  await page.locator('.staffAccountMenu > summary').click();
  await expectStaffControlLinks(page);
  await page.locator('.staffAccountMenu > summary').click();
  await expect(page.locator('.staffAccountMenu')).not.toHaveAttribute('open', '');
  await page.screenshot({ path: testInfo.outputPath('service-board.png'), fullPage: true });
  await followUp.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('service-board-follow-up.png'), fullPage: false });
  await page.goto('/admin?view=activity');
  await expect(page.locator('.activitySection')).toHaveAttribute('aria-busy', 'false');
  const tools = page.locator('.activityTools');
  await expect(tools).not.toHaveAttribute('open', '');
  await tools.locator('summary').click();
  await expect(tools).toHaveAttribute('open', '');
  const dateFilter = tools.getByRole('combobox').filter({ has: page.getByRole('option', { name: 'Last 24 hours', exact: true }) });
  await expect(dateFilter).toBeVisible();
  await expect(dateFilter).toHaveAccessibleName(/^Date/);
  await dateFilter.selectOption('last24');
  await expect(dateFilter).toHaveValue('last24');
  await expect(tools.getByRole('option', { name: 'Last 24 hours', exact: true })).toHaveCount(1);
  await page.goto('/admin?view=people');
  await expect(page.locator('.staffAccessDisclosure')).not.toHaveAttribute('open', '');
  await expect(page.locator('.staffAccountPanel')).toBeVisible();
});

test('vendor current job retains intake draft across refresh reordering', async ({ page }, testInfo) => {
  await signIn(page, 'vendor');
  const job = { ...orders[2], vendor: 'Synthetic vendor', status: 'At Vendor', lastEventType: 'driver-route-log', workflowStage: { ...orders[2].workflowStage, key: 'at-vendor', label: 'At Vendor' } };
  let rows = [job, { ...orders[4], vendor: 'Synthetic vendor' }];
  const assertOrdersRead = await fixtureOrders(page, () => rows);
  await page.goto('/vendors');
  await assertOrdersRead();
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
  await expectStaffControlLinks(page);
  await page.screenshot({ path: testInfo.outputPath('vendor-intake.png'), fullPage: true });
});

test('rider vendor collection does not display customer destination or unrelated ETA', async ({ page }, testInfo) => {
  await signIn(page, 'driver');
  const ready = { ...orders[2], driver: 'Synthetic driver', status: 'Ready', workflowStage: { ...orders[2].workflowStage, key: 'ready', label: 'Ready' }, dispatch: { ...orders[2].dispatch, etaSource: 'area-estimate', etaText: '18 min' } };
  const assertOrdersRead = await fixtureOrders(page, [ready]);
  await page.goto('/drivers');
  await assertOrdersRead();
  await expect(page.locator('.staffWorkTicket h2')).toHaveText(ready.vendor);
  await expect(page.locator('.staffStopAddress')).toContainText('Vendor collection');
  await expect(page.locator('.staffStopAddress')).not.toContainText(ready.pickupAddress);
  await expect(page.locator('.staffRouteFacts')).toContainText('Vendor destination needed');
  await expect(page.locator('.staffTicketNavigation').getByRole('link', { name: 'Directions', exact: true })).toHaveCount(0);
  await expect(page.locator('.staffTicketNavigation').getByRole('link', { name: 'Scan bag', exact: true })).toHaveAttribute('href', '/scan');
  await expectStaffControlLinks(page);
  await page.screenshot({ path: testInfo.outputPath('rider-vendor-collection.png'), fullPage: true });
});

test('support dossier preserves case draft and failed writes never claim success', async ({ page }, testInfo) => {
  const caseReads = [];
  const pageErrors = [];
  const failedCaseReads = [];
  page.on('requestfailed', request => { const url = new URL(request.url()); if (url.pathname === '/api/staff/automation/case' && failedCaseReads.length < 20) failedCaseReads.push({ caseId: (url.searchParams.get('caseId') || '').slice(0, 80), failure: (request.failure()?.errorText || '').slice(0, 200) }); });
  page.on('pageerror', error => { if (pageErrors.length < 10) pageErrors.push(error.message.slice(0, 300)); });
  try {
  await signIn(page, 'support');
  await page.route('**/api/submissions', route => route.fulfill({ json: { ok: true, records } }));
  await page.route('**/api/staff/automation/case?*', route => { const id = new URL(route.request().url()).searchParams.get('caseId'); const projected = records.filter(row => row.data.ticketId === id); if (caseReads.length < 20) caseReads.push({ id: (id || '').slice(0, 80), recordIds: projected.slice(0, 10).map(row => row.id.slice(0, 80)) }); return route.fulfill({ json: { ok: true, records: projected } }); });
  await page.route('**/api/submit', route => route.fulfill({ status: 503, json: { ok: false, error: 'Synthetic save unavailable' } }));
  await page.goto('/support');
  await expect(page.locator('.staffCaseDeskDossier')).toContainText('CASE-018');
  // Controlled textarea text becomes a descendant of its implicit label.
  // Use its stable computed accessible name, not the label's full textContent.
  const caseNote = page.locator('.staffCaseDeskDossier').getByRole('textbox', { name: 'Case note', exact: true });
  await expect(caseNote).toHaveAccessibleName('Case note');
  await caseNote.fill('Draft to retain');
  await expect(caseNote).toHaveAccessibleName('Case note');
  await expect(page.locator('.staffCaseDeskDossier').getByRole('textbox', { name: 'Case note', exact: true })).toHaveValue('Draft to retain');
  await page.locator('.staffCaseDeskIndex').getByRole('link').filter({ hasText: 'CASE-021' }).click();
  await expect(page.locator('.staffCaseDeskDossier')).toContainText('CASE-021');
  await page.locator('.staffCaseDeskIndex').getByRole('link').filter({ hasText: 'CASE-018' }).click();
  await expect(page).toHaveURL(/case=CASE-018/);
  await expect(page.locator('.supportDeskSection')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.staffCaseDeskDossier .staffCaseDeskReference')).toContainText('CASE-018');
  await expect(page.locator('.staffCaseDeskDossier').getByRole('textbox', { name: 'Case note', exact: true })).toHaveValue('Draft to retain');
  await page.locator('.staffCaseDeskDossier').getByRole('button', { name: 'Save case action', exact: true }).click();
  await expect(page.locator('.staffCaseDeskDossier')).toContainText('Synthetic save unavailable');
  await expect(page.locator('.staffCaseDeskDossier').getByRole('textbox', { name: 'Case note', exact: true })).toHaveValue('Draft to retain');
  await expectStaffControlLinks(page);
  await page.screenshot({ path: testInfo.outputPath('support-save-failure.png'), fullPage: true });
  } catch (error) {
    console.log(JSON.stringify({ fixture: 'support-draft-diagnostic', project: testInfo.project.name, path: (() => { const url = new URL(page.url()); return `${url.pathname}${url.search}`.slice(0, 300); })(), caseReads, failedCaseReads, pageErrors, visibleText: (await page.locator('main').innerText().catch(() => 'No main element')).slice(0, 6000) }));
    await page.screenshot({ path: testInfo.outputPath('support-draft-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  }
});

// Customer prose remains conventionally identifiable; this is not a global a reset.
test('staff link treatment leaves customer inline policy links underlined', async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).origin === 'http://localhost:3100' ? route.continue() : route.abort());
  await page.goto('/terms');
  const proseLink = page.getByRole('link', { name: 'cancellation and refund policy', exact: true });
  await expect(proseLink).toBeVisible();
  await expect(proseLink).toHaveCSS('text-decoration-line', 'underline');
});
