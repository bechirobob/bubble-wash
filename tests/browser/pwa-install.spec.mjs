import { test, expect } from '@playwright/test';
import { fixtureRequestPolicy } from './request-policy.mjs';

test.beforeEach(async({page})=>{
  await page.route('**/*',route=>fixtureRequestPolicy(route.request().url())===null?route.abort('blockedbyclient'):route.continue());
});

async function syntheticPrompt(page, outcome='dismissed') {
  await page.evaluate(outcome=>{
    window.__pwaPrompts=0;
    const event=new Event('beforeinstallprompt',{cancelable:true});
    event.prompt=async()=>{window.__pwaPrompts++;if(outcome==='error')throw new Error('Synthetic prompt failure');};
    event.userChoice=outcome==='pending'?new Promise(resolve=>{window.__pwaChoice=resolve}):Promise.resolve({outcome,platform:'web'});
    window.dispatchEvent(event);
  },outcome);
}

async function controlled(page) {
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));});
}

test('install page is compact, branded and exposes truthful platform guidance',async({page},testInfo)=>{
  await page.goto('/install');
  await expect(page.getByRole('heading',{name:'Keep Bubble Wash close.'})).toBeVisible();
  await expect(page.getByRole('dialog',{name:'Bubble Wash opening'})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'iPhone or iPad',exact:true})).toBeVisible();
  await expect(page.getByText('Turn on Open as Web App if shown, then tap Add.',{exact:true})).toBeVisible();
  await expect(page.getByText(/does not save submissions offline/)).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await syntheticPrompt(page);await expect(page.getByRole('button',{name:'Install Bubble Wash',exact:true})).toBeVisible();
  const button=page.getByRole('button',{name:'Install Bubble Wash',exact:true});
  expect(await button.evaluate(element=>getComputedStyle(element).boxShadow)).toBe('none');
  expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await page.screenshot({path:testInfo.outputPath('install-page.png'),fullPage:true});
});

test('browser prompt only runs on deliberate click; dismissal can be retried with a fresh event',async({page})=>{
  await page.goto('/install');await syntheticPrompt(page);
  expect(await page.evaluate(()=>window.__pwaPrompts)).toBe(0);
  await page.getByRole('button',{name:'Install Bubble Wash',exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('You can add Bubble Wash later from your browser menu.');
  expect(await page.evaluate(()=>window.__pwaPrompts)).toBe(1);
  await expect(page.getByRole('button',{name:'Install Bubble Wash',exact:true})).toHaveCount(0);
  await syntheticPrompt(page,'accepted');await page.getByRole('button',{name:'Install Bubble Wash',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Installation requested.');
  await expect(page.getByRole('status')).not.toContainText('is installed');
  await page.evaluate(()=>window.dispatchEvent(new Event('appinstalled')));
  await expect(page.getByRole('status')).toHaveText('Bubble Wash is installed on this device.');
});

test('pending installation is single flight and failure retains manual guidance',async({page})=>{
  await page.goto('/install');await syntheticPrompt(page,'pending');
  await page.getByRole('button',{name:'Install Bubble Wash',exact:true}).evaluate(button=>{button.click();button.click()});
  await expect(page.getByRole('button',{name:'Opening install…',exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>window.__pwaPrompts)).toBe(1);
  await page.evaluate(()=>window.__pwaChoice({outcome:'dismissed',platform:'web'}));
  await syntheticPrompt(page,'error');await page.getByRole('button',{name:'Install Bubble Wash',exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('Installation did not start. Use the steps below instead.');
  await expect(page.getByRole('heading',{name:'iPhone or iPad',exact:true})).toBeVisible();
});

test('iOS standalone mode hides installation controls',async({page})=>{
  await page.addInitScript(()=>Object.defineProperty(navigator,'standalone',{value:true}));
  await page.goto('/install');await expect(page.getByRole('status')).toHaveText('Bubble Wash is installed on this device.');
  await syntheticPrompt(page);await expect(page.getByRole('button',{name:'Install Bubble Wash',exact:true})).toHaveCount(0);
});

test('footer navigation retains an available prompt without interrupting the home intro',async({page})=>{
  await page.goto('/');await expect(page.getByRole('dialog',{name:'Bubble Wash opening'})).toBeVisible();
  await syntheticPrompt(page);
  await expect(page.getByRole('button',{name:'Install Bubble Wash',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Skip intro',exact:true}).click();
  await page.getByRole('link',{name:'Add to home screen',exact:true}).click();
  await expect(page).toHaveURL(/\/install$/);
  await expect(page.getByRole('button',{name:'Install Bubble Wash',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Back to Bubble Wash',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Bubble Wash opening'})).not.toBeVisible();
});

test('offline navigation is generic and never caches pages or queues a POST',async({page,context})=>{
  await page.goto('/install');await controlled(page);
  expect(await page.evaluate(()=>caches.keys())).toEqual([]);
  await context.setOffline(true);
  const post=await page.evaluate(async()=>{try{await fetch('/api/research/responses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({synthetic:'offline-not-saved'})});return 'unexpected-success';}catch{return 'network-error';}});
  expect(post).toBe('network-error');
  const response=await page.goto('/staff?synthetic=private-value');expect(response.status()).toBe(503);
  await expect(page.getByRole('heading',{name:"You're offline.",exact:true})).toBeVisible();
  await expect(page.locator('body')).not.toContainText('private-value');
  await expect(page.locator('body')).toContainText('responses cannot be sent offline');
  expect(await page.evaluate(()=>caches.keys())).toEqual([]);
  const posts=[];page.on('request',request=>{if(request.method()==='POST')posts.push(request.url())});
  await context.setOffline(false);await page.getByRole('link',{name:'Try again',exact:true}).click();
  await expect(page.getByRole('heading',{name:"You're offline.",exact:true})).toHaveCount(0);
  expect(posts).toEqual([]);
});

test('service worker keeps security and cache headers and usable manifest icons',async({page,request})=>{
  await page.goto('/install');await controlled(page);
  const worker=await request.get('/sw.js');expect(worker.status()).toBe(200);expect(worker.headers()['cache-control']).toContain('no-store');
  const manifest=await (await request.get('/site.webmanifest')).json();expect(manifest.start_url).toBe('/');expect(manifest.display).toBe('standalone');
  for(const icon of manifest.icons){const result=await request.get(icon.src);expect(result.status()).toBe(200);expect(result.headers()['content-type']).toBe('image/png');}
  await expect(page.locator('meta[name="mobile-web-app-capable"]')).toHaveAttribute('content','yes');
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content','Bubble Wash');
});
