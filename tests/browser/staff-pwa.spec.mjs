import { test, expect } from '@playwright/test';
import { fixtureEdgeResponseHeaders } from './fixture-edge.mjs';

// Presentation-only fixture: expose a staff Host to the loopback runtime for GETs.
// No writes, login, changed Origin, real DNS or third-party traffic are allowed.
test.beforeEach(async ({ page }) => {
  await page.route('**/*', async route => {
    const request=route.request(), url=new URL(request.url());
    if(url.origin!=='http://localhost:3100' || request.method()!=='GET') return route.abort('blockedbyclient');
    const upstream=await route.fetch({url:`http://localhost:3101${url.pathname}${url.search}`,headers:{...request.headers(),host:'staff.bubblewash.co'},maxRedirects:0});
    await route.fulfill({response:upstream,headers:fixtureEdgeResponseHeaders(upstream.headers())});
  });
});

test('staff launch and all role entries keep separate installation identity',async({page})=>{
  await page.goto('/');await expect(page).toHaveURL(/\/staff$/);
  await expect(page.getByRole('heading',{name:'Staff access',exact:true})).toBeVisible();
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href','/staff.webmanifest');
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content','Bubble Wash Staff');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href','/staff-apple-icon.png');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content',/noindex/);
  for(const [label,target] of [['Admin','admin'],['Vendor','vendors'],['Driver','drivers'],['Support','support']]) {
    const link=page.locator('.staffAccessCard').filter({has:page.getByRole('heading',{name:label,exact:true})});
    await expect(link).toHaveAttribute('href',`/login?next=/${target}`);
  }
  await page.getByRole('link',{name:'Add staff app to home screen',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Bubble Wash Staff',exact:true})).toBeVisible();
  await expect(page.getByText('Open staff.bubblewash.co in Safari.',{exact:true})).toBeVisible();
  await expect(page.getByText(/phone is locked/)).toBeVisible();
  await expect(page.getByRole('link',{name:'Back to staff sign-in',exact:true})).toHaveAttribute('href','/staff');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('staff installation remains deliberate, repeat-safe and correctly named',async({page},info)=>{
  await page.addInitScript(()=>{
    const add=window.addEventListener;
    window.addEventListener=function(type,listener,options){const result=add.call(this,type,listener,options);if(type==='beforeinstallprompt')window.__staffPromptReady=true;return result;};
  });
  await page.goto('/install');await page.waitForFunction(()=>window.__staffPromptReady);
  await page.evaluate(()=>{
    window.__staffPromptCount=0;const event=new Event('beforeinstallprompt',{cancelable:true});
    event.prompt=async()=>{window.__staffPromptCount++;};event.userChoice=Promise.resolve({outcome:'dismissed',platform:'web'});window.dispatchEvent(event);
  });
  const button=page.getByRole('button',{name:'Install Bubble Wash Staff',exact:true});await expect(button).toBeVisible();
  expect(await page.evaluate(()=>window.__staffPromptCount)).toBe(0);
  await page.screenshot({path:info.outputPath('staff-install.png'),fullPage:true});
  await button.click();await expect(page.getByRole('status')).toHaveText('You can add Bubble Wash Staff later from your browser menu.');
  expect(await page.evaluate(()=>window.__staffPromptCount)).toBe(1);
  await page.evaluate(()=>window.dispatchEvent(new Event('appinstalled')));
  await expect(page.getByRole('status')).toHaveText('Bubble Wash Staff is installed on this device.');
});
