import { test, expect } from '@playwright/test';

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || page.isClosed()) return;
  if (!['/staff/worklist', '/admin', '/support', '/vendors', '/drivers'].includes(new URL(page.url()).pathname)) return;
  await page.screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true, animations: 'disabled', timeout: 5000 }).catch(() => {});
});
import { randomUUID } from 'node:crypto';

async function login(page, role, testInfo) {
  await page.context().setExtraHTTPHeaders({'x-forwarded-for':`192.0.2.${testInfo.project.name.startsWith('desktop')?51:61}`});
  await page.context().route('**/*', route => new URL(route.request().url()).hostname==='localhost' ? route.continue() : route.abort());
  const response=await page.request.post('/api/login',{headers:{origin:'http://localhost:3195'},data:{email:`${role}@example.invalid`,password:`synthetic-${role}-password-123`}});
  expect(response.status(),await response.text()).toBe(200);
  await page.goto('/staff/worklist?filter=all');
  await expect(page.getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
}
async function screenshot(page,testInfo,label) {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({path:testInfo.outputPath(`${label}.png`),fullPage:true,animations:'disabled'});
  const shadows=await page.locator('nav a, h1, h2, summary, button').evaluateAll(nodes=>nodes.map(node=>({box:getComputedStyle(node).boxShadow,text:getComputedStyle(node).textShadow})).filter(({box,text})=>box!=='none'||text!=='none'));
  expect(shadows).toEqual([]);
}

test('real staff worklist, safe writes, conflict recovery and admin reviews',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await login(page,'admin',testInfo);
  await screenshot(page,testInfo,'worklist-collapsed');
  const item=page.getByRole('region',{name:'Worklist',exact:true}).getByRole('listitem').filter({has:page.getByText('BW-WORKLISTCASE',{exact:true})});
  await item.getByText('Owner and follow-up deadline',{exact:true}).click();
  const form=item.getByRole('form');
  await form.getByRole('combobox',{name:'Owner',exact:true}).selectOption('support@example.invalid');
  const future=new Date(Date.now()+3600000).toISOString().slice(0,16);
  await form.getByLabel('Follow-up deadline',{exact:false}).fill(future);
  const draft=`Call after reviewing the case (${testInfo.project.name})`;
  await form.getByLabel('Next step').fill(draft);
  await screenshot(page,testInfo,'ownership-editor');
  page.once('dialog',dialog=>dialog.dismiss());
  await page.getByRole('link',{name:'Mine',exact:true}).click();
  await expect(form.getByLabel('Next step')).toHaveValue(draft);
  await expect(page).toHaveURL(/filter=all/);
  // Simulate a response lost after the server committed, then retry unchanged.
  let savedId,firstKey;
  await page.route('**/api/staff/automation/ownership',async route=>{
    firstKey=route.request().postDataJSON().idempotencyKey;
    const response=await route.fetch();savedId=(await response.json()).id;
    await route.abort('failed');await page.unroute('**/api/staff/automation/ownership');
  });
  await form.getByRole('button',{name:'Save owner and deadline',exact:true}).click();
  await expect(form.getByText('Save could not be confirmed.',{exact:false})).toBeVisible();
  const [retry]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/staff/automation/ownership')&&r.request().method()==='POST'),form.getByRole('button',{name:'Save owner and deadline',exact:true}).click()]);
  expect(retry.request().postDataJSON().idempotencyKey).toBe(firstKey);
  expect(await retry.json()).toMatchObject({id:savedId,replayed:true});
  await expect(form.getByText('Owner and follow-up deadline saved.',{exact:false})).toBeVisible();
  await expect(page.getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
  // A second operator changes ownership after this form's snapshot.
  const latest=(await(await page.request.get('/api/staff/automation/worklist?itemId=case-followup:BW-WORKLISTCASE')).json()).items[0];
  await form.getByLabel('Next step').fill('Unsaved draft must survive a conflict');
  const changed=await page.request.post('/api/staff/automation/ownership',{headers:{origin:'http://localhost:3195'},data:{itemId:latest.id,ownerEmail:'admin@example.invalid',dueAt:new Date(Date.now()+7200000).toISOString(),note:'Saved elsewhere',expectedRevision:latest.revision,signalVersion:latest.signalVersion,idempotencyKey:randomUUID()}});
  expect(changed.status()).toBe(200);
  await form.getByRole('button',{name:'Save owner and deadline',exact:true}).click();
  await expect(form.getByText('This item changed.',{exact:false})).toBeVisible();
  await expect(form.getByLabel('Next step')).toHaveValue('Unsaved draft must survive a conflict');
  await expect(form.getByRole('button',{name:'Save owner and deadline',exact:true})).toBeDisabled();
  await screenshot(page,testInfo,'ownership-conflict');
  await form.getByRole('button',{name:/Load latest values/}).click();
  await expect(form.getByLabel('Next step')).toHaveValue('Saved elsewhere');
  await item.getByRole('link',{name:'Open case',exact:true}).click();
  await expect(page.locator('.caseDetail').getByText('CASE-WORKLIST-REFERENCE',{exact:true})).toBeVisible();
  await page.goBack();
  await page.getByRole('link',{name:'Assignment options',exact:true}).click();
  await page.getByLabel('Order reference').fill('BW-BROWSEROVERDUE01');
  await page.getByRole('button',{name:'Show available options'}).click();
  await expect(page.getByRole('region',{name:'Vendor options',exact:true}).getByText('Available · confirm capacity first',{exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'Rider options',exact:true}).getByText('Available',{exact:true})).toBeVisible();
  await expect(page.getByText('Assignment is not available at this order stage.',{exact:false})).toBeVisible();
  await expect(page.getByRole('button',{name:'Assign vendor + driver',exact:true})).toHaveCount(0);
  await screenshot(page,testInfo,'dispatch-suggestions');
  await page.getByRole('link',{name:'Payment review',exact:true}).click();
  await expect(page.getByText('Invoice missing after laundry check-in')).toBeVisible();
  await screenshot(page,testInfo,'payment-review');
  await page.getByRole('link',{name:'Message review',exact:true}).click();
  await expect(page.getByText('Delivery uncertain; team review needed')).toBeVisible();
  await expect(page.getByRole('button',{name:/resend|activate provider/i})).toHaveCount(0);
  await screenshot(page,testInfo,'message-review');
  expect(errors).toEqual([]);
});

test('staff scopes and retry state',async({page},testInfo)=>{
  await login(page,'admin',testInfo);
  const current=(await(await page.request.get('/api/staff/automation/worklist?itemId=case-followup:BW-WORKLISTCASE')).json()).items[0];
  const setup=await page.request.post('/api/staff/automation/ownership',{headers:{origin:'http://localhost:3195'},data:{itemId:current.id,ownerEmail:'admin@example.invalid',dueAt:new Date(Date.now()+3600000).toISOString(),note:'Saved elsewhere',expectedRevision:current.revision,signalVersion:current.signalVersion,idempotencyKey:randomUUID()}});
  expect(setup.status()).toBe(200);await page.context().clearCookies();
  await login(page,'support',testInfo);
  await expect(page.getByRole('link',{name:'Message review',exact:true})).toHaveCount(0);
  await expect(page.getByRole('link',{name:'Assignment options',exact:true})).toHaveCount(0);
  const item=page.getByRole('region',{name:'Worklist',exact:true}).getByRole('listitem').filter({has:page.getByText('BW-WORKLISTCASE',{exact:true})});
  await item.getByText('Owner and follow-up deadline',{exact:true}).click();
  await expect(item.getByRole('button',{name:'Save owner and deadline'})).toBeDisabled();
  await expect(item.getByLabel('Next step')).toHaveValue('Saved elsewhere');
  await screenshot(page,testInfo,'support-scoped');
  await page.route('**/api/staff/automation/worklist?**',route=>route.abort());
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  const loadError=page.locator('main').getByRole('alert').filter({has:page.getByRole('button',{name:'Retry',exact:true})});
  await expect(loadError).toBeVisible();
  await expect(item.getByLabel('Next step')).toHaveValue('Saved elsewhere');
  await page.unroute('**/api/staff/automation/worklist?**');
  const recovered=page.waitForResponse(response=>response.url().includes('/api/staff/automation/worklist?')&&response.request().method()==='GET');
  await loadError.getByRole('button',{name:'Retry',exact:true}).click();
  expect((await recovered).ok()).toBe(true);
  await expect(loadError).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
  await expect(item.getByLabel('Next step')).toHaveValue('Saved elsewhere');
  await expect(item.getByRole('button',{name:'Save owner and deadline'})).toBeDisabled();
  for(const role of ['vendor','driver']) {
    await page.context().clearCookies();await login(page,role,testInfo);
    await expect(page.getByText('BW-WORKLISTCASE',{exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Save owner and deadline'})).toHaveCount(0);
    await screenshot(page,testInfo,`${role}-scoped`);
  }
});

test('Back and Forward preserve a revised draft after an earlier request finishes',async({page},testInfo)=>{
 await login(page,'admin',testInfo);
 await page.getByRole('link',{name:'Follow-ups',exact:true}).click();
 let releaseResponse,upstreamCommitted,deliveredResponse,failedResponse;
 const committed=new Promise(resolve=>{upstreamCommitted=resolve;});
 const release=new Promise(resolve=>{releaseResponse=resolve;});
 const delivered=new Promise((resolve,reject)=>{deliveredResponse=resolve;failedResponse=reject;});
 const findForm=()=>page.getByRole('region',{name:'Worklist',exact:true}).getByRole('listitem').filter({has:page.getByText('BW-WORKLISTCASE',{exact:true})}).getByRole('form');
 await page.getByRole('region',{name:'Worklist',exact:true}).getByRole('listitem').filter({has:page.getByText('BW-WORKLISTCASE',{exact:true})}).getByText('Owner and follow-up deadline',{exact:true}).click();
 let form=findForm();
 await form.getByLabel('Follow-up deadline',{exact:false}).fill(new Date(Date.now()+3600000).toISOString().slice(0,16));
 await form.getByLabel('Next step').fill('Submitted before browser Back');
 await page.route('**/api/staff/automation/ownership',async route=>{
   try {
     const response=await route.fetch();expect(response.ok()).toBe(true);upstreamCommitted();await release;
     await route.fulfill({response});deliveredResponse();
   } catch(error) { failedResponse(error); }
 });
 await form.getByRole('button',{name:'Save owner and deadline',exact:true}).click();await Promise.race([committed,delivered]);
 await page.goBack();form=findForm();
 await expect(form.getByLabel('Next step')).toHaveValue('Submitted before browser Back');
 await form.getByLabel('Next step').fill('Revised draft survives old response');
 releaseResponse();await delivered;await page.unroute('**/api/staff/automation/ownership');
 await page.goForward();form=findForm();
 await expect(form.getByLabel('Next step')).toHaveValue('Revised draft survives old response');
 await form.getByRole('button',{name:/Load latest values/}).click();
 await expect(form.getByLabel('Next step')).toHaveValue('Submitted before browser Back');
 await expect(form.getByLabel('Next step')).toBeVisible();
 await expect(form.getByText('Latest values loaded.',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
 // Loading latest must not collapse a restored editor, and a deliberate close
 // must remain closed during refresh without losing the latest saved values.
 const disclosure=page.getByRole('region',{name:'Worklist',exact:true}).getByRole('listitem').filter({has:page.getByText('BW-WORKLISTCASE',{exact:true})}).locator('details');
 await expect(disclosure).toHaveAttribute('open','');
 await disclosure.locator('summary').click();
 await expect(disclosure).not.toHaveAttribute('open');
 await page.getByRole('button',{name:'Refresh',exact:true}).click();
 await expect(page.getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
 await expect(disclosure).not.toHaveAttribute('open');
 await disclosure.locator('summary').click();
 await expect(form.getByLabel('Next step')).toBeVisible();
 await expect(form.getByLabel('Next step')).toHaveValue('Submitted before browser Back');
});
