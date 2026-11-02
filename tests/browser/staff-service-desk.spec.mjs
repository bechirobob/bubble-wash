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
  // Early acceptance plus the full suite stays below ten logins per role/device identity.
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
  const respond = route => { fulfilled++; return route.fulfill({ json: { ok: true, orders: typeof readRows === 'function' ? readRows(route.request()) : readRows, nextOffset: null } }); };
  await page.route('**/api/orders?*', respond);
  await page.route('**/api/orders', respond);
  return () => expect.poll(() => fulfilled, { message: 'Workspace fetched the intended synthetic order projection' }).toBeGreaterThan(0);
}

async function expectWorkspaceSwitcher(page) {
  const trigger = page.locator('.staffAccountMenu > summary');
  await expect(trigger.locator('svg[aria-hidden="true"] path')).toHaveAttribute('d', 'M-8 -4H8M-8 4H3');
  await expect(trigger.locator('svg rect')).toHaveCount(0);
  await expect(trigger).not.toContainText('⌄');
  await expect(trigger).toHaveCSS('min-height', '44px');
}

async function expectCompactWhiteWorkspace(page, testInfo) {
  await expect(page.locator('.portalPage.staffDesk')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  const heading = page.locator('.staffViewHeader h1');
  if (testInfo.project.use.viewport.width <= 700) {
    expect(await heading.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeLessThanOrEqual(24);
  }
  await expect(page.locator('.staffSectionNav a[aria-current="page"]')).toHaveCSS('background-color', 'rgb(240, 240, 240)');
  const decoration = await page.locator('.staffViewHeader h1, .staffSectionNav a[aria-current="page"], .staffStageLane.selected .staffStageSelector').evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node);
    return { box: style.boxShadow, text: style.textShadow, filter: style.filter };
  }));
  for (const style of decoration) {
    expect(style.box).toBe('none');
    expect(style.text).toBe('none');
    expect(style.filter).not.toContain('drop-shadow');
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function expectJobAndQueueGeometry(page, testInfo) {
  const sheet = await page.locator('.staffRoleFeatured').boundingBox();
  const queue = await page.locator('.staffRoleLedger').boundingBox();
  expect(sheet).not.toBeNull();
  expect(queue).not.toBeNull();
  if (testInfo.project.use.viewport.width <= 700) {
    expect(queue.y).toBeGreaterThanOrEqual(sheet.y + sheet.height - 1);
  } else {
    expect(queue.x).toBeGreaterThanOrEqual(sheet.x + sheet.width - 1);
  }
}

async function expectStaffControlLinks(page) {
  await expectWorkspaceSwitcher(page);
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
  await expect(navigation.nth(1)).toHaveCSS('outline-offset', '-2px');
  await expect(navigation.nth(1)).toHaveCSS('border-left-width', '0px');
  await expect(page.locator('.staffSignOut')).toHaveCSS('border-left-width', '0px');
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
  await expectCompactWhiteWorkspace(page, testInfo);
  if (testInfo.project.use.viewport.width <= 700) {
    await expect(page.locator('.staffStageLane.selected .staffStageSelector')).toHaveCSS('background-color', 'rgb(240, 240, 240)');
  }
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
  await page.screenshot({ path:testInfo.outputPath('workspace-menu-open.png'), fullPage:false });
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
  await page.goto('/staff/worklist');
  await expectWorkspaceSwitcher(page);
  await page.locator('.staffAccountMenu > summary').click();
  await expect(page.locator('.staffAccountMenu')).toHaveAttribute('open', '');
  await page.locator('.staffAccountMenu > summary').click();
  await expect(page.locator('.staffAccountMenu')).not.toHaveAttribute('open', '');
});

test('vendor current job retains intake draft through search, filters and refresh reordering', async ({ page }, testInfo) => {
  await signIn(page, 'vendor');
  const job = { ...orders[2], vendor: 'Synthetic vendor', status: 'At Vendor', lastEventType: 'driver-route-log', workflowStage: { ...orders[2].workflowStage, key: 'at-vendor', label: 'At Vendor' } };
  let rows = [job, { ...orders[4], vendor: 'Synthetic vendor' }];
  const assertOrdersRead = await fixtureOrders(page, request => {
    const query = new URL(request.url()).searchParams.get('q')?.toLowerCase();
    return query ? rows.filter(order => `${order.bookingReference} ${order.customer}`.toLowerCase().includes(query)) : rows;
  });
  await page.goto('/vendors');
  await assertOrdersRead();
  await expect(page.locator('.staffWorkTicket')).toContainText('BW-1036');
  await page.locator('.staffWorkTicket').getByRole('button', { name: 'Confirm bag intake', exact: true }).click();
  await page.getByLabel('Bag/item count', { exact: true }).fill('3');
  await expectCompactWhiteWorkspace(page, testInfo);
  await expectJobAndQueueGeometry(page, testInfo);
  await expect(page.locator('.staffJobFlow')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.staffOrderState')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const tools = page.locator('.staffQueueTools');
  await tools.locator('summary').click();
  const search = tools.getByRole('searchbox', { name: 'Find an order', exact: true });
  await search.fill('NO-SYNTHETIC-ORDER-MATCH');
  await expect(tools.locator('summary')).toHaveText('Find and filter orders · Filtered');
  await expect(page.getByRole('region', { name: 'Order queue', exact: true }).getByText('No orders match this search.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Bag/item count', { exact: true })).toHaveValue('3');
  await expect(page.getByLabel('Bag/item count', { exact: true })).toBeDisabled();
  await expect(page.locator('.staffSyncLine')).toContainText('outside these search results');
  await expect(page.locator('.sharedBoardSection')).not.toContainText('No shared orders yet');
  const filterBoxes = await tools.locator('.staffTextFilters button').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y));
  expect(Math.max(...filterBoxes) - Math.min(...filterBoxes)).toBeLessThanOrEqual(1);
  await tools.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByLabel('Bag/item count', { exact: true })).toHaveValue('3');
  await page.screenshot({ path: testInfo.outputPath('vendor-filtered-draft.png'), fullPage: true });
  await tools.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(tools.getByRole('button', { name: 'Needs action', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(tools.getByRole('button', { name: 'Clear filters', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Bag/item count', { exact: true })).toHaveValue('3');
  await expect(page.getByLabel('Bag/item count', { exact: true })).toBeEnabled();
  await tools.getByRole('button', { name: 'All active', exact: true }).click();
  await expect(page.getByLabel('Bag/item count', { exact: true })).toHaveValue('3');
  await tools.getByRole('button', { name: 'Clear filters', exact: true }).click();
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
  await expectCompactWhiteWorkspace(page, testInfo);
  await expectJobAndQueueGeometry(page, testInfo);
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

test('staff customer contact actions retain aligned touch targets and exact destinations', async ({ page }, testInfo) => {
  await signIn(page, 'admin');
  const order = { ...orders[0], phone: '0200000000', email: 'customer@example.invalid' };
  const assertOrdersRead = await fixtureOrders(page, [order]);
  await page.goto(`/admin?view=orders&order=${encodeURIComponent(order.orderId)}`);
  await assertOrdersRead();
  await page.locator('.staffDetailDisclosure > summary').filter({ hasText: 'Customer and collection' }).click();
  const actions = page.locator('.customerContactActions');
  const call = actions.getByRole('link', { name: 'Call customer', exact: true });
  const email = actions.getByRole('link', { name: 'Email customer', exact: true });
  await expect(call).toBeVisible();
  await expect(call).toHaveAttribute('href', 'tel:0200000000');
  await expect(email).toHaveAttribute('href', `mailto:customer@example.invalid?subject=${encodeURIComponent(`Bubble Wash order ${order.bookingReference}`)}`);
  for (const link of [call, email]) {
    await expect(link).toHaveCSS('min-height', '44px');
    await expect(link).toHaveCSS('align-items', 'center');
    const bounds = await link.boundingBox();
    expect(bounds.height).toBeGreaterThanOrEqual(44);
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await actions.scrollIntoViewIfNeeded();
  await page.screenshot({ path:testInfo.outputPath('contact-action-targets.png'), fullPage:false });
});

// Synthetic stress projections exercise geometry, never production order counts.
test('service stage counts stay paired with their own icons at three digit volumes', async ({ page }, testInfo) => {
  await signIn(page, 'admin');
  const rows = [[orders[1], 3], [orders[2], 24], [orders[0], 128]].flatMap(([base, count], group) =>
    Array.from({ length: count }, (_, index) => ({ ...base, orderId: `alignment-${group}-${index}`, bookingReference: `BW-${group}-${index}` })));
  const read = await fixtureOrders(page, rows);
  await page.goto('/admin');
  await read();
  const selectors = page.locator('.staffStageSelector');
  await expect(selectors.locator('b')).toHaveText(['3', '24', '128']);
  await expect(selectors.locator('span')).toHaveText(['Collection', 'Washing', 'Return']);
  const bounds = await selectors.evaluateAll(buttons => buttons.map(button => {
    const rect = element => { const b = element.getBoundingClientRect(); return { x:b.x, right:b.right, y:b.y, bottom:b.bottom, width:b.width, height:b.height }; };
    return { button:rect(button), icon:rect(button.querySelector('svg')), count:rect(button.querySelector('b')), label:rect(button.querySelector('span')) };
  }));
  for (const {button, icon, count, label} of bounds) {
    expect(button.height).toBeGreaterThanOrEqual(44);
    for (const content of [icon, count, label]) {
      expect(content.x).toBeGreaterThanOrEqual(button.x - 1);
      expect(content.right).toBeLessThanOrEqual(button.right + 1);
      expect(content.bottom).toBeLessThanOrEqual(button.bottom + 1);
    }
    if (testInfo.project.use.viewport.width <= 700) {
      expect(icon.width).toBeCloseTo(24, 2);
      expect(count.x - icon.right).toBeCloseTo(6, 0);
    }
  }
  for (let i=1;i<bounds.length;i++) expect(bounds[i].button.x - bounds[i-1].button.right).toBeGreaterThanOrEqual(7.5);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.staffStageBoard').scrollIntoViewIfNeeded();
  await page.screenshot({ path:testInfo.outputPath('stage-counts-3-24-128.png'), fullPage:false });
});

test('long rider destination names stay inside ticket and assigned stop rows', async ({ page }, testInfo) => {
  await signIn(page, 'driver');
  const vendor = 'SyntheticLaundryPartnerWithAnUnbrokenReferenceForContainmentVerification';
  const ready = { ...orders[2], driver:'Synthetic driver', vendor, status:'Ready', workflowStage:{ ...orders[2].workflowStage, key:'ready', label:'Ready' } };
  const read = await fixtureOrders(page, [ready]);
  await page.goto('/drivers');
  await read();
  await expect(page.locator('.staffTicketHeader h2')).toHaveText(vendor);
  const ticket = page.locator('.staffTicketHeader');
  const heading = await ticket.locator('h2').boundingBox();
  const state = await ticket.locator('.staffOrderState').boundingBox();
  const parent = await ticket.boundingBox();
  expect(heading.x + heading.width).toBeLessThanOrEqual(state.x + 1);
  expect(state.x + state.width).toBeLessThanOrEqual(parent.x + parent.width + 1);
  await expect(page.locator('.staffRoleQueueRow')).toHaveCount(1);
  await expect(page.locator('.staffRoleQueueRow')).toContainText(vendor);
  const overflowing = await page.locator('.staffRoleQueueRow').evaluateAll(rows => rows.filter(row => row.scrollWidth > row.clientWidth).length);
  expect(overflowing).toBe(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path:testInfo.outputPath('rider-long-destination.png'), fullPage:true });
});

// Visit the actual role destinations: an href assertion is not a rendered review.
for (const [role, routes] of Object.entries({
  admin: [['dispatch', 'Rider routes and ETAs'], ['orders', 'Order operations'], ['people', 'Partners and staff'], ['cases', 'Customer cases'], ['activity', 'Recent changes'], ['operations', 'Privacy requests']],
  vendor: [['capacity', 'Today’s availability'], ['activity', 'Saved updates']],
  driver: [['activity', 'Saved route updates']],
  support: [['cases', 'Customer cases'], ['activity', 'Saved support updates']],
})) {
  test(`${role} secondary workspace routes retain readable controls and navigation`, async ({ page }, testInfo) => {
    await signIn(page, role);
    const path = { admin: '/admin', vendor: '/vendors', driver: '/drivers', support: '/support' }[role];
    for (const [view, title] of routes) {
      await page.goto(`${path}?view=${view}`);
      await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expectCompactWhiteWorkspace(page, testInfo);
      await expectWorkspaceSwitcher(page);
      const menu = page.locator('.staffAccountMenu > summary');
      await menu.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('.staffAccountMenu')).toHaveAttribute('open', '');
      await page.keyboard.press('Escape');
      await expect(menu).toBeFocused();
      await expect(page.locator('.staffAccountMenu')).not.toHaveAttribute('open', '');
      if (role === 'vendor' && view === 'capacity') {
        const capacity = page.getByRole('spinbutton', { name: 'Order slots remaining', exact: true });
        await expect(capacity).toBeVisible();
        await capacity.fill('7');
        await expect(capacity).toHaveValue('7'); // Local draft only; no capacity write.
      }
      if (role === 'admin' && view === 'people') {
        const editor = page.locator('.staffRosterEditor').first();
        if (await editor.count()) await editor.locator('summary').click();
      }
      if (role === 'support' && view === 'cases') {
        const summary = page.locator('.staffRosterEditor > summary').filter({ hasText: 'Open a new case' });
        await expect(summary.locator('b')).toHaveCSS('white-space', 'nowrap');
        const bounds = await summary.evaluate(node => { const a=node.querySelector('span').getBoundingClientRect(), b=node.querySelector('b').getBoundingClientRect(); return {textRight:a.right,actionLeft:b.left}; });
        expect(bounds.textRight).toBeLessThanOrEqual(bounds.actionLeft);
        await summary.click();
        await expect(page.locator('.staffRosterEditor[open] form')).toBeVisible();
      }
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${role}-${view}-workspace.png`), fullPage: true });
    }
  });
}

test('paged order queue retains context and updates the saved detail row after retry', async ({ page }, testInfo) => {
  await signIn(page, 'admin');
  const rows = Array.from({ length: 23 }, (_, index) => ({ ...orders[1], orderId: `queue-context-${index}`, bookingReference: `BW-${4000 + index}`, customer: `Synthetic queue customer ${index}`, status: 'Pickup scheduled', workflowStage: { ...orders[1].workflowStage, key: 'pickup-scheduled', label: 'Pickup scheduled' } }));
  const requestedOffsets = [];
  let detailMode = '503';
  let saved = 0;
  await page.route('**/api/orders?*', async route => {
    const params = new URL(route.request().url()).searchParams;
    const query = params.get('q');
    if (query) {
      if (detailMode === 'network') return route.abort('failed');
      if (detailMode === '503' || detailMode === '403') return route.fulfill({ status: Number(detailMode), json: { ok: false, error: 'Synthetic detail read failure' } });
      return route.fulfill({ json: { ok: true, orders: detailMode === 'empty' ? [] : rows.filter(order => order.orderId === query), nextOffset: null } });
    }
    const offset = Number(params.get('offset') || 0);
    requestedOffsets.push(offset);
    return route.fulfill({ json: { ok: true, orders: rows.slice(offset, offset + 10), nextOffset: offset === 0 ? 10 : offset === 10 ? 20 : null } });
  });
  await page.route('**/api/orders/advance', async route => {
    expect(route.request().postDataJSON()).toMatchObject({ orderId: 'queue-context-15', actionKey: 'admin-assign-vendor' });
    saved++;
    rows[15] = { ...rows[15], status: 'Vendor assigned', workflowStage: { ...rows[15].workflowStage, key: 'vendor-assigned', label: 'Vendor assigned' } };
    await route.fulfill({ json: { ok: true, nextStatus: 'Vendor assigned', id: 'synthetic-saved-event' } });
  });
  await page.goto('/admin?view=orders');
  await page.locator('.staffQueueTools > summary').click();
  await page.getByRole('button', { name: 'All active', exact: true }).click();
  await page.getByRole('button', { name: 'Load older orders', exact: true }).click();
  await expect.poll(() => requestedOffsets.includes(10)).toBe(true);
  await page.getByRole('button', { name: 'Next page of Order queue', exact: true }).click();
  const target = page.getByRole('link', { name: 'View order BW-4015', exact: true });
  await target.focus();
  const region = page.getByRole('region', { name: 'Order queue', exact: true });
  const scrollBefore = await region.evaluate(node => node.scrollTop);
  await target.click();
  await expect(page.getByRole('heading', { name: 'Order details unavailable', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Order not found', exact: true })).toHaveCount(0);
  detailMode = 'network';
  const retry = page.getByRole('button', { name: 'Retry loading order', exact: true });
  await retry.click();
  await expect(page.locator('.sharedBoardSection > [role="status"]')).toContainText('Unable to load shared orders.');
  await expect(retry).toBeVisible();
  detailMode = 'success';
  await retry.click();
  await expect(page.locator('.orderDetail h2')).toHaveText('Synthetic queue customer 15');
  await expect(page.locator('.orderDetail h2')).toBeFocused();
  await page.locator('.orderDetail').getByRole('button', { name: 'Assign vendor + driver', exact: true }).click();
  await expect.poll(() => saved).toBe(1);
  await expect(page.locator('.staffDetailHeader')).toContainText('Vendor assigned');
  await expect(page.locator('.orderDetail').getByRole('button', { name: 'Assign vendor + driver', exact: true })).toHaveCount(0);
  const readsBeforeBack = requestedOffsets.length;
  await page.getByRole('link', { name: 'Back to order list', exact: false }).click();
  await expect(target).toBeVisible();
  await expect(target).toBeFocused();
  await expect(target.locator('..')).toContainText('Vendor assigned');
  await expect(page.getByRole('button', { name: 'All active', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('navigation', { name: 'Order queue pages', exact: true })).toContainText('Page 2 of 2');
  await expect.poll(() => region.evaluate(node => node.scrollTop)).toBe(scrollBefore);
  expect(requestedOffsets.length).toBe(readsBeforeBack);
  await expect(page.getByRole('button', { name: 'Load older orders', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('order-queue-return-context.png'), fullPage: true });
  for (const mode of ['403', 'empty']) {
    detailMode = mode;
    await page.goto('/admin?view=orders&order=queue-context-15');
    await expect(page.getByRole('heading', { name: 'Order not found', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry loading order', exact: true })).toHaveCount(0);
    await expect(page.locator('.orderDetail')).toHaveCount(0);
  }
});
