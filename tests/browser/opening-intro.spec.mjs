import { test, expect } from '@playwright/test';
import { fixtureRequestPolicy } from './request-policy.mjs';
test.beforeEach(async({page})=>{await page.route('**/*',route=>fixtureRequestPolicy(route.request().url())===null?route.abort('blockedbyclient'):route.continue());});
const opening = page => page.getByRole('dialog', { name: 'Bubble Wash opening' });

test('fresh home opens once, skips without click-through, and keeps the actual home', async ({ page }) => {
  await page.goto('/');
  await expect(opening(page)).toBeVisible();
  await expect(page.locator('#home-title')).toHaveText('Laundry pickupfor your business.');
  await page.getByRole('button', { name: 'Skip intro' }).click();
  await expect(opening(page)).not.toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('link', { name: 'Track an order', exact: false }).first().click();
  await expect(page).toHaveURL(/\/track$/);
  await page.goBack();
  await expect(opening(page)).not.toBeVisible();
});

test('auto hands off without remounting the underlying home', async ({ page }) => {
  await page.goto('/');
  await expect(opening(page)).toBeVisible();
  await page.locator('#home-title').evaluate(node => { node.dataset.introIdentity = 'same-home'; });
  await expect(opening(page)).not.toBeVisible({ timeout: 3500 });
  await expect(page.locator('#home-title')).toHaveAttribute('data-intro-identity', 'same-home');
});

test('Escape closes instantly', async ({ page }) => {
  await page.goto('/');
  await expect(opening(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(opening(page)).not.toBeVisible();
});

test('reduced motion bypasses the intro', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('#home-title')).toBeVisible();
  await expect(opening(page)).not.toBeVisible();
});

for (const path of ['/#how-it-works', '/?resume=survey', '/book', '/early-access', '/track']) {
  test(`direct ${path} never opens the intro`, async ({ page }) => {
    await page.goto(path);
    await expect(opening(page)).not.toBeVisible();
  });
}

test('tab hiding cancels and does not replay on resume', async ({ page }) => {
  await page.goto('/');
  await expect(opening(page)).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(opening(page)).not.toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(opening(page)).not.toBeVisible();
});

test('a reduced-motion change cancels an already-running intro', async ({ page }) => {
  await page.goto('/');
  await expect(opening(page)).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(opening(page)).not.toBeVisible();
});

test('pagehide closes the modal before a page can be restored', async ({ page }) => {
  await page.goto('/');
  await expect(opening(page)).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(opening(page)).not.toBeVisible();
});

// Requires the reconstructed C3 survey alongside this intro patch. Collection stays disabled.
for (const path of ['/survey', '/survey/consumer', '/survey/consumer-interview', '/survey/business-interview', '/survey/vendor-interview', '/survey/consumer?source=invite#start']) {
  test(`fresh survey entry plays the approved intro: ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(opening(page)).toBeVisible();
    await page.locator('main').first().evaluate(node => { node.dataset.introIdentity = 'same-survey'; });
    await page.getByRole('button', { name: 'Skip intro' }).click();
    await expect(opening(page)).not.toBeVisible();
    await expect(page.locator('main').first()).toHaveAttribute('data-intro-identity', 'same-survey');
  });
}

test('survey route navigation does not replay and leaves stored drafts unchanged', async ({ page }) => {
  test.skip(process.env.BUBBLEWASH_TEST_RESEARCH_OPEN==='true','Closed-only route; open-fixture tests cover actual form state.');
  await page.addInitScript(() => { sessionStorage.setItem('synthetic-survey-draft', '{"answer":"keep"}'); });
  await page.goto('/survey/consumer');
  await expect(opening(page)).toBeVisible();
  await page.getByRole('button', { name: 'Skip intro' }).click();
  await page.getByRole('link', { name: 'Back to research' }).click();
  await expect(page).toHaveURL(/\/survey$/);
  await expect(opening(page)).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('synthetic-survey-draft'))).toBe('{"answer":"keep"}');
});

test('survey reduced-motion entry bypasses the intro', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/survey/consumer');
  await expect(page.locator('main').first()).toBeVisible();
  await expect(opening(page)).not.toBeVisible();
});

// Open-mode acceptance uses only the isolated synthetic fixture. Production flags
// and credentials are never modified by this test file.
test.describe('interim survey open-fixture acceptance',()=>{
  test.skip(process.env.BUBBLEWASH_TEST_RESEARCH_OPEN!=='true','Requires isolated open survey fixture');
  async function enter(page,instrument='consumer'){
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.goto('/survey/'+instrument);
    await expect(page.getByRole('heading',{name:'Before you start'})).toBeVisible();
    await expect(page.getByLabel('Full name',{exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'Yes, I am 18 or older',exact:true}).click();
    await page.getByLabel('Full name',{exact:true}).fill('TEST SURVEY — SYNTHETIC');
    await page.getByLabel('Email address',{exact:true}).fill('synthetic@example.invalid');
    await page.getByLabel('Phone number',{exact:true}).fill('0200000000');
    if(await page.getByLabel('Organisation',{exact:true}).count())await page.getByLabel('Organisation',{exact:true}).fill('Synthetic Browser Fixture');
  }
  async function eligibility(page,yes=[]){
    for(const [id,name] of [['student','Students'],['business','Business owners'],['corporate','Office workers'],['household','Households']]){
      const group=page.getByRole('group',{name:new RegExp('^'+name+':')});
      if(await group.isVisible())await group.getByRole('radio',{name:yes.includes(id)?'Yes':'No',exact:true}).check();
    }
  }
  test('adult gate and consent refusal never submit identity',async({page},testInfo)=>{
    let requests=0;page.on('request',r=>{if(r.url().includes('/api/research/responses'))requests++;});
    await page.emulateMedia({reducedMotion:'reduce'});await page.goto('/survey/consumer');
    await expect(page.getByRole('heading',{name:'Before you start'})).toBeVisible();
    await page.screenshot({path:testInfo.outputPath('survey-eligibility.png'),fullPage:true});
    await page.getByRole('button',{name:'No, I am under 18',exact:true}).click();
    await expect(page.getByText('No personal details or answers have been saved or emailed.')).toBeVisible();
    await enter(page);await page.getByRole('radio',{name:'No, I do not agree (end survey)',exact:true}).click();
    await expect(page.getByRole('heading',{name:'You can stop here.'})).toBeVisible();expect(requests).toBe(0);
  });
  test('compact details, required Other text and sequential source eligibility',async({page},testInfo)=>{
    await enter(page);const information=page.getByText('More information',{exact:true});
    await expect(page.getByText(/Your response is not anonymous/)).toBeVisible();
    await expect(page.getByText(/Identifiable website research records/)).not.toBeVisible();
    await information.focus();await information.press('Enter');await expect(page.getByText(/up to 12 months from collection/)).toBeVisible();
    await information.press('Enter');await page.screenshot({path:testInfo.outputPath('survey-details.png'),fullPage:true});
    await expect(page.getByText('Optional questions for work, study or home',{exact:true})).toHaveCount(0);
    await page.getByRole('radio',{name:'Yes, I agree',exact:true}).check();await page.getByRole('button',{name:'Continue',exact:true}).click();
    await page.getByRole('radio',{name:'25 to 34',exact:true}).check();await page.getByRole('radio',{name:'Other (specify)',exact:true}).check();
    await page.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.getByLabel('Specify area',{exact:true})).toBeVisible();await page.getByLabel('Specify area',{exact:true}).fill('Synthetic area');
    await page.getByRole('button',{name:'Back',exact:true}).click();await expect(page.getByLabel('Full name',{exact:true})).toHaveValue('TEST SURVEY — SYNTHETIC');
    await page.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.getByRole('radio',{name:'25 to 34',exact:true})).toBeChecked();
    await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('radio',{name:'Other',exact:true}).check();
    await page.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.getByLabel('Please describe your work/study category.')).toBeVisible();
    await page.getByLabel('Please describe your work/study category.').fill('Synthetic work category');await page.getByRole('button',{name:'Continue',exact:true}).click();
    for(let i=0;i<5&&!await page.getByRole('group',{name:/^Students:/}).isVisible();i++)await page.getByRole('button',{name:'Continue',exact:true}).click();
    await page.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.getByRole('group',{name:/^Students:/})).toBeVisible();
    await eligibility(page,['student']);await page.getByRole('button',{name:'Continue',exact:true}).click();
    await expect(page.getByRole('group',{name:/^Households:/})).toContainText('woman who works and has household laundry responsibilities');await eligibility(page,['corporate','household']);
    await page.screenshot({path:testInfo.outputPath('survey-profile-routing.png'),fullPage:true});await page.getByRole('button',{name:'Continue',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Students',exact:true})).toBeVisible();await expect(page.getByText('Which university or college do you attend?',{exact:false})).toBeVisible();
    await page.getByRole('radio',{name:'University of Ghana',exact:true}).check();
    for(let i=0;i<8&&!await page.getByRole('heading',{name:'Households',exact:true}).isVisible();i++)await page.getByRole('button',{name:'Continue',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Households',exact:true})).toBeVisible();
  });
  test('long multilingual responses show a recoverable overall-length limit',async({page})=>{
    await enter(page,'consumer-interview');await page.getByRole('radio',{name:'Yes, I agree',exact:true}).check();await page.getByRole('button',{name:'Continue',exact:true}).click();
    for(let i=0;i<8;i++){
      await eligibility(page);
      const inputs=page.locator('textarea');for(let j=0;j<await inputs.count();j++)await inputs.nth(j).fill('漢'.repeat(4000));
      if(await page.getByRole('button',{name:'Continue',exact:true}).isDisabled())break;
      await page.getByRole('button',{name:'Continue',exact:true}).click();
    }
    await expect(page.getByText(/Please shorten one or more answers/)).toBeVisible();
    await expect(page.getByRole('button',{name:'Continue',exact:true})).toBeDisabled();
    const inputs=page.locator('textarea');for(let j=0;j<await inputs.count();j++)await inputs.nth(j).fill('Short synthetic answer.');
    await expect(page.getByRole('button',{name:'Continue',exact:true})).toBeEnabled();
  });
  test('changing eligibility removes hidden answers before a real synthetic save',async({page})=>{
    await enter(page);await page.getByRole('radio',{name:'Yes, I agree',exact:true}).check();await page.getByRole('button',{name:'Continue',exact:true}).click();
    for(let i=0;i<6&&!await page.getByRole('group',{name:/^Students:/}).isVisible();i++)await page.getByRole('button',{name:'Continue',exact:true}).click();
    await eligibility(page);await page.getByRole('button',{name:'Continue',exact:true}).click();await eligibility(page,['corporate','household']);await page.getByRole('button',{name:'Continue',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Office workers',exact:true})).toBeVisible();await page.getByRole('radio',{name:'Under 30 min',exact:true}).check();
    for(let i=0;i<5&&!await page.getByRole('heading',{name:'Households',exact:true}).isVisible();i++)await page.getByRole('button',{name:'Continue',exact:true}).click();
    await page.getByRole('radio',{name:'All or almost all',exact:true}).check();
    for(let i=0;i<8&&!await page.getByRole('group',{name:/^Office workers:/}).isVisible();i++)await page.getByRole('button',{name:'Back',exact:true}).click();
    await eligibility(page);await page.getByRole('button',{name:'Back',exact:true}).click();await eligibility(page,['student']);
    for(let i=0;i<35&&!await page.getByRole('button',{name:'Submit response',exact:true}).isVisible();i++)await page.getByRole('button',{name:'Continue',exact:true}).click();
    const saved=page.waitForResponse(r=>r.url().endsWith('/api/research/responses')&&r.request().method()==='POST');await page.getByRole('button',{name:'Submit response',exact:true}).click();const response=await saved;expect(response.status()).toBe(200);
    const submitted=response.request().postDataJSON();expect(submitted.answers['icp-student']).toBe('Yes');expect(submitted.answers['icp-corporate']).toBe('No');expect(submitted.answers['icp-household']).toBe('No');expect(submitted.answers.F3a).toBeUndefined();expect(submitted.answers.F4a).toBeUndefined();
    await expect(page.getByRole('heading',{name:'Thank you!',exact:true})).toBeVisible();
  });
  test('consumer interview retains all qualifying probes and submits once',async({page})=>{
    await enter(page,'consumer-interview');await page.getByRole('radio',{name:'Yes, I agree',exact:true}).check();await page.getByRole('button',{name:'Continue',exact:true}).click();const seen=new Set();
    for(let i=0;i<20&&!await page.getByRole('button',{name:'Submit response',exact:true}).isVisible();i++){
      await eligibility(page,['student','business','corporate','household']);
      for(const name of ['Students:','Business owners:','Office workers:','Households:'])if(await page.locator('legend').filter({hasText:name}).count()&&await page.locator('textarea').count())seen.add(name);
      const inputs=page.locator('textarea');for(let j=0;j<await inputs.count();j++)await inputs.nth(j).fill('Clearly marked synthetic interview answer.');await page.getByRole('button',{name:'Continue',exact:true}).click();
    }
    expect([...seen].sort()).toEqual(['Business owners:','Households:','Office workers:','Students:']);
    const saved=page.waitForResponse(r=>r.url().endsWith('/api/research/responses')&&r.request().method()==='POST');await page.getByRole('button',{name:'Submit response',exact:true}).click();const response=await saved;expect(response.status()).toBe(200);
    const answers=response.request().postDataJSON().answers;for(const key of ['probe-student','probe-business','probe-corporate','probe-household'])expect(answers[key]).toBe('Clearly marked synthetic interview answer.');await expect(page.getByRole('heading',{name:'Thank you!',exact:true})).toBeVisible();
  });
  test('business journey saves once and shows compact confirmation',async({page},testInfo)=>{
    await enter(page,'business-interview');await page.getByRole('radio',{name:'Yes, I agree',exact:true}).check();
    await page.getByRole('button',{name:'Continue',exact:true}).click();
    for(let i=0;i<8&&!await page.getByRole('button',{name:'Submit response',exact:true}).isVisible();i++){
      const inputs=page.locator('textarea');for(let j=0;j<await inputs.count();j++)await inputs.nth(j).fill('Clearly marked synthetic browser response.');
      await page.getByRole('button',{name:'Continue',exact:true}).click();
    }
    const saved=page.waitForResponse(r=>r.url().endsWith('/api/research/responses')&&r.request().method()==='POST');
    await page.getByRole('button',{name:'Submit response',exact:true}).click();expect((await saved).status()).toBe(200);
    await expect(page.getByRole('status')).toHaveText('✓ RESPONSE SAVED');
    await expect(page.getByRole('heading',{name:'Thank you!',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Submit response',exact:true})).toHaveCount(0);
    await expect(page.getByText(/synthetic details only/i)).toHaveCount(0);
    await page.screenshot({path:testInfo.outputPath('survey-compact-completion.png'),fullPage:true});
  });
});

test('open survey fixture rejects cross-origin, oversized and minor submissions at the real edge',async({request})=>{
  test.skip(process.env.BUBBLEWASH_TEST_RESEARCH_OPEN!=='true','Requires isolated open survey fixture');
  const endpoint='/api/research/responses';
  const foreign=await request.post(endpoint,{headers:{Origin:'https://outside.example.invalid','Content-Type':'application/json'},data:'{}'});expect(foreign.status()).toBe(403);
  const oversized=await request.post(endpoint,{headers:{Origin:'http://localhost:3100','Content-Type':'application/json'},data:JSON.stringify({x:'a'.repeat(65536)})});expect(oversized.status()).toBe(413);
  const minor=await request.post(endpoint,{headers:{Origin:'http://localhost:3100','Content-Type':'application/json'},data:{adultEligible:false,identity:{name:'SYNTHETIC EXCLUDED'},answers:{A1:'Under 18'}}});expect(minor.status()).toBe(400);
});
