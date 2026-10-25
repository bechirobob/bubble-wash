import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import Database from 'better-sqlite3';
import { verifyFocusPolicy, verifyResearchShellLayout } from './focus-policy-proof.mjs';
const fixture = JSON.parse(readFileSync('/tmp/bubblewash-results-fixture-proof.json','utf8'));
const origin = 'http://localhost:3217';
const output = resolve('test-results/survey-results') + '/';
mkdirSync(output,{recursive:true});
const browser = await chromium.launch({...(process.env.BUBBLEWASH_TEST_CHROMIUM_PATH ? {executablePath:process.env.BUBBLEWASH_TEST_CHROMIUM_PATH} : {}),headless:true});
const failures=[]; const tests=[];
async function context(role, viewport={width:1440,height:1050}) {
  const result=await browser.newContext({viewport});
  await result.route('**/*',route=>new URL(route.request().url()).hostname==='localhost'?route.continue():route.abort());
  if(role)await result.addCookies([{name:'bubblewash_staff_session',value:fixture.sessions[role],domain:'localhost',path:'/',httpOnly:true,sameSite:'Lax',secure:false}]);
  return result;
}
try {
  for(const role of [null,'master','vendor','driver','support']) {
    const c=await context(role);
    for(const path of ['/api/admin/research/results','/api/admin/research/responses',`/api/admin/research/responses/${fixture.firstId}`]){
      const response=await c.request.get(origin+path);assert.equal(response.status(),403,`${role??'anonymous'} ${path}`);const value=await response.text();assert.equal(value.includes('demo-'),false);assert.equal(value.includes('Ama Demo'),false);
    }
    tests.push(`${role??'anonymous'} blocked on all three read endpoints`);await c.close();
  }
  const owner=await context('owner');const page=await owner.newPage();page.on('pageerror',error=>failures.push(error.message));
  const aggregate=await owner.request.get(origin+'/api/admin/research/results');assert.equal(aggregate.status(),200);assert.match(aggregate.headers()['cache-control'],/private.*no-store/);const body=await aggregate.json();
  assert.equal(body.totals.saved,84);assert.equal(body.totals.analysis,78);assert.equal('responses' in body,false);assert.equal(JSON.stringify(body).includes('@example.invalid'),false);assert.equal(JSON.stringify(body).includes('Ama Demo'),false);assert.equal(JSON.stringify(body).includes('Synthetic research response'),false);
  tests.push('owner aggregate returns correct core counts and no names, contacts, or prose');
  await page.goto(origin+'/admin/surveys');await page.getByText('73 answered',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  const coloredBorders = await page.locator('main').evaluate(root => [...root.querySelectorAll('*')].filter(element => { const style = getComputedStyle(element); return ['Top','Right','Bottom','Left'].some(side => { const color = style['border'+side+'Color'].match(/\d+/g)?.map(Number); return parseFloat(style['border'+side+'Width']) > 0 && style['border'+side+'Style'] !== 'none' && color && (color[0] !== color[1] || color[1] !== color[2]); }); }).map(element => element.tagName + '.' + element.className));
  assert.deepEqual(coloredBorders, []); tests.push('rendered decorative borders are neutral');
  const shadows = await page.locator('main').evaluate(root => [...root.querySelectorAll('*')].filter(element => getComputedStyle(element).boxShadow !== 'none').map(element => element.tagName + '.' + element.className));
  assert.deepEqual(shadows, []); tests.push('approved staff research surface has no decorative shadows');
  const identity = await page.locator('main').evaluate(root => {
    const css = element => getComputedStyle(element);
    const title = root.querySelector('h1');
    return { font: css(root).fontFamily, bodyFont: css(document.body).fontFamily,
      header: css(title.parentElement.parentElement).backgroundColor,
      summary: css(root.querySelector('[aria-busy]')).backgroundColor,
      work: css(root.querySelector('#patterns-panel section')).backgroundColor,
      chart: css(root.querySelector('[role="tabpanel"] [style*="width"]')).backgroundColor };
  });
  assert.match(identity.font, /-apple-system/);
  assert.equal(await page.locator('main.portalPage.staffDesk').count(), 1);
  assert.equal(await page.locator('.staffWorkspaceSwitcherIcon path').getAttribute('d'), 'M-8 -4H8M-8 4H3');
  assert.equal(identity.header, 'rgba(0, 0, 0, 0)');
  assert.equal(identity.summary, 'rgb(251, 252, 252)');
  assert.equal(identity.work, 'rgb(251, 252, 252)');
  assert.equal(identity.chart, 'rgb(8, 117, 142)');
  tests.push('results use the approved shared staff shell, restrained surfaces and chart blue');
  await page.screenshot({path:output+'desktop-patterns.png',fullPage:true});
  await page.getByRole('combobox',{name:'Choose a question',exact:true}).selectOption('C1');await page.getByText(/Multiple answers allowed/).waitFor();assert.equal(await page.getByText(/^100%/).count()>0,true);
  tests.push('multi-select renders respondent denominator and multiple-selection explanation');
  await page.getByRole('combobox',{name:'Analysis sample',exact:true}).selectOption('quota');await page.getByText(/Consumer scope: Accra core in agreed areas/).waitFor();await page.getByText('72',{exact:true}).first().waitFor();
  const quota=await owner.request.get(origin+'/api/admin/research/results?sample=quota');assert.equal((await quota.json()).totals.analysis,72);
  await page.getByRole('combobox',{name:'Analysis sample',exact:true}).selectOption('core');await page.getByRole('combobox',{name:'Choose a question',exact:true}).selectOption('E1');await page.getByText('73 answered',{exact:true}).waitFor();
  await page.getByRole('tab',{name:'Responses',exact:true}).click();await page.getByRole('button',{name:/Open response from/}).first().waitFor();
  const visibleList = await page.getByRole('region',{name:'Survey responses',exact:true}).innerText();
  const listData = await (await owner.request.get(origin+'/api/admin/research/responses')).json();
  for (const response of listData.responses) { assert.equal(visibleList.includes(response.id),false); assert.equal(visibleList.includes(response.id.slice(0,8)),false); }
  const scrollable = await page.getByRole('region',{name:'Survey responses',exact:true}).evaluate(element => element.scrollHeight > element.clientHeight && getComputedStyle(element).overflowY === 'auto');
  assert.equal(scrollable,true); tests.push('response list hides internal IDs and has bounded internal scrolling');
  await page.screenshot({path:output+'desktop-responses.png',fullPage:true});
  await page.getByRole('button',{name:/Open response from/}).first().click();await page.getByRole('dialog').getByText(/@example.invalid/).waitFor();await page.screenshot({path:output+'desktop-response-detail.png',fullPage:true});
  await page.getByRole('button',{name:'Close response',exact:true}).click();assert.equal(await page.getByRole('dialog').isVisible(),false);
  tests.push('owner-only list and contact/prose detail open and close through actual UI');
  await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByText('Page 2 of 7',{exact:true}).waitFor();tests.push('response pagination works');
  await page.getByRole('tab',{name:'Patterns',exact:true}).click();await page.getByText('73 answered',{exact:true}).waitFor();await page.setViewportSize({width:390,height:844});await page.screenshot({path:output+'mobile-patterns.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  await page.setViewportSize({width:320,height:740});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);await page.screenshot({path:output+'mobile-320-patterns.png',fullPage:true});tests.push('390px and 320px layouts have no horizontal overflow');
  const comparison = page.locator('details').filter({has:page.locator('summary').filter({hasText:'A closer comparison'})});
  if (!(await comparison.evaluate(element => element.open))) await comparison.locator('summary').click();
  const comparisonLoaded = page.waitForResponse(response => response.url().includes('/api/admin/research/results?') && new URL(response.url()).searchParams.get('compare') === 'area');
  await page.getByRole('combobox',{name:'Compare by',exact:true}).selectOption('area'); await comparisonLoaded;
  await page.getByText('73 answered',{exact:true}).waitFor();
  assert.equal(await comparison.evaluate(element => element.open), true, 'comparison stays expanded across its own filter reload');
  tests.push('mobile comparison disclosure retains expansion while changing its filter');
  await verifyResearchShellLayout(page);
  await page.screenshot({path:output+'mobile-320-comparison-layout.png',fullPage:true});
  await page.getByRole('tab',{name:'Responses',exact:true}).click(); await page.getByRole('button',{name:/Open response from/}).first().waitFor(); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false); await page.screenshot({path:output+'mobile-320-responses.png',fullPage:true}); tests.push('320px response list, pagination and bounded scrolling are rendered');
  await page.getByRole('tab',{name:'Patterns',exact:true}).click();
  await page.getByRole('combobox',{name:'Audience',exact:true}).selectOption('none');await page.getByRole('combobox',{name:'Area',exact:true}).selectOption('Airport');await page.waitForTimeout(300);
  // A revoked existing owner session must immediately lose all results access.
  const db=new Database(fixture.directory+'/synthetic.sqlite');db.prepare("UPDATE staff_accounts SET status='suspended' WHERE email='owner@example.invalid'").run();
  for(const path of ['/api/admin/research/results','/api/admin/research/responses',`/api/admin/research/responses/${fixture.firstId}`])assert.equal((await owner.request.get(origin+path)).status(),403);
  db.prepare("UPDATE staff_accounts SET status='active' WHERE email='owner@example.invalid'").run();db.close();tests.push('suspended owner session denied immediately on all read endpoints');
  tests.push(...await verifyFocusPolicy({ browser, fixture, origin, output }));
  assert.deepEqual(failures,[]);tests.push('no browser runtime errors');
  await owner.close();writeFileSync(output+'results.json',JSON.stringify({ok:true,tests,failures,syntheticOnly:true,origin},null,2));console.log(JSON.stringify({ok:true,tests,output},null,2));
} finally {await browser.close();}
