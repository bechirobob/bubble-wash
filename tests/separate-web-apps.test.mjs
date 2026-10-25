import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { isStaffAppHost, STAFF_APP_URL } from '../src/lib/web-app.ts';
import config from '../next.config.mjs';
const read = path => readFileSync(new URL(`../${path}`,import.meta.url),'utf8');

test('staff app identity only matches the exact host, never a forwarded or suffix host',()=>{
  assert.equal(isStaffAppHost('staff.bubblewash.co'),true);
  assert.equal(isStaffAppHost('STAFF.BUBBLEWASH.CO'),true);
  for(const host of [null,undefined,'','bubblewash.co','staff.bubblewash.co.evil.test','evil.test, staff.bubblewash.co','staff.bubblewash.co:443']) assert.equal(!!isStaffAppHost(host),false);
  assert.equal(STAFF_APP_URL,'https://staff.bubblewash.co');
});

test('customer identity unchanged; separate origin has staff launch and full role-route scope',async()=>{
  const customer=JSON.parse(read('public/site.webmanifest'));
  const staff=JSON.parse(read('public/staff.webmanifest'));
  assert.equal(customer.id,'/');assert.equal(customer.start_url,'/');assert.equal(customer.name,'Bubble Wash');
  assert.equal(staff.id,'/');assert.equal(staff.start_url,'/staff');assert.equal(staff.scope,'/');assert.equal(staff.name,'Bubble Wash Staff');
  assert.equal(staff.display,'standalone');assert.equal(staff.prefer_related_applications,false);
  for(const icon of staff.icons){
    assert.ok(!customer.icons.some(original=>original.src===icon.src));
    const size=Number(icon.sizes.split('x')[0]);const meta=await sharp(new URL(`../public${icon.src}`,import.meta.url).pathname).metadata();
    assert.equal(meta.width,size);assert.equal(meta.height,size);assert.equal(meta.format,'png');
  }
  const apple=await sharp(new URL('../public/staff-apple-icon.png',import.meta.url).pathname).metadata();assert.equal(apple.width,180);
  assert.deepEqual(await config.redirects(),[{source:'/',has:[{type:'host',value:'staff.bubblewash.co'}],destination:'/staff',permanent:false}]);
});

test('staff metadata is server selected with separate Apple icon and no-index; no cookie or CORS widening',()=>{
  const layout=read('src/app/layout.tsx');
  assert.match(layout,/isStaffAppHost\(\(await headers\(\)\)\.get\("host"\)\)/);
  assert.match(layout,/manifest: "\/staff.webmanifest"/);assert.match(layout,/apple: "\/staff-apple-icon.png"/);assert.match(layout,/robots: \{ index: false, follow: false \}/);
  assert.match(read('src/lib/security.ts'),/originUrl.host === host/);
  assert.doesNotMatch(read('src/lib/auth.ts'),/domain:\s*["']\.?(?:staff\.)?bubblewash\.co/);
  const provider=read('src/components/WebAppProvider.tsx');assert.doesNotMatch(provider,/localStorage|requestPermission|pushManager/);
  assert.doesNotMatch(read('public/sw.js'),/caches\.|indexedDB|skipWaiting/);
});

test('staff install guidance stays separate and keeps offline/background limitations truthful',()=>{
  const page=read('src/app/install/page.tsx');assert.match(page,/<WebAppInstall staffApp/);assert.match(page,/href="\/staff"/);
  const install=read('src/components/WebAppInstall.tsx');assert.match(install,/staff\.bubblewash\.co/);assert.match(install,/phone is locked/);
  const chooser=read('src/app/staff/page.tsx');for(const role of ['admin','vendors','drivers','support'])assert.ok(chooser.includes(`/login?next=/${role}`));
});
