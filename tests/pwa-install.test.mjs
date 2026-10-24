import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import sharp from 'sharp';
import config from '../next.config.mjs';

const worker = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
function fixture(fetch) {
  const listeners = {};
  let claimed = 0;
  runInNewContext(worker, { URL, Response, fetch, self: { location: { origin: 'https://bubblewash.co' }, clients: { claim: async () => { claimed++; } }, addEventListener: (type, callback) => { listeners[type] = callback; } } });
  return { listeners, claimed: () => claimed };
}
function request(listeners, overrides = {}) {
  let result;
  listeners.fetch({ request: { url: 'https://bubblewash.co/survey/consumer', method: 'GET', mode: 'navigate', ...overrides }, respondWith: promise => { result = promise; } });
  return result;
}

test('standalone manifest keeps stable identity and fresh-home launch', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../public/site.webmanifest', import.meta.url)));
  assert.equal(manifest.id, '/'); assert.equal(manifest.start_url, '/'); assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone'); assert.equal(manifest.prefer_related_applications, false);
  for (const size of [192,512]) {
    const icon=manifest.icons.find(icon=>icon.sizes===`${size}x${size}` && icon.purpose.split(' ').includes('any')); assert.ok(icon);
    const meta=await sharp(new URL(`../public${icon.src}`,import.meta.url).pathname).metadata();
    assert.equal(meta.width,size); assert.equal(meta.height,size); assert.equal(meta.format,'png');
    const expected=await sharp(new URL('../public/bubble-wash-icon.jpg',import.meta.url).pathname)
      .extract({left:128,top:80,width:960,height:960}).resize(size,size).raw().toBuffer();
    const actual=await sharp(new URL(`../public${icon.src}`,import.meta.url).pathname).raw().toBuffer();
    assert.deepEqual(actual,expected,'Only empty padding is cropped from the approved original artwork');
  }
  const maskable=manifest.icons.find(icon=>icon.purpose.split(' ').includes('maskable')); assert.ok(maskable);
  const {data,info}=await sharp(new URL(`../public${maskable.src}`,import.meta.url).pathname).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  assert.equal(info.width,512);assert.equal(info.height,512);
  for(let i=3;i<data.length;i+=4) assert.equal(data[i],255,'Maskable background is fully opaque');
  for(let y=0;y<info.height;y++) for(let x=0;x<info.width;x++) {
    const i=(y*info.width+x)*4;
    const visible=Math.min(data[i],data[i+1],data[i+2])<245;
    if(visible) assert.ok(Math.hypot(x-(info.width-1)/2,y-(info.height-1)/2)<=info.width*.4,'All visible artwork stays inside the maskable safe circle');
    if(x===0||y===0||x===info.width-1||y===info.height-1) assert.deepEqual([...data.subarray(i,i+4)],[255,255,255,255],'No inherited dark corner pixels');
  }
  assert.ok(manifest.icons.every(icon=>icon.src!=='/icon-512.png'),'Install manifest uses the cleaned app assets only');
  const page=readFileSync(new URL('../src/app/install/page.tsx',import.meta.url),'utf8');
  assert.match(page,/className=\{styles.brand\}/);assert.match(page,/src="\/bubble-wash-icon.jpg"/);assert.doesNotMatch(page,/src="\/apple-icon.png"/);
});

test('worker passes through all successful and error HTTP responses unchanged', async () => {
  for(const status of [200,302,401,403,404,503]) {
    const response=new Response('live',{status}); const {listeners}=fixture(async()=>response);
    assert.equal(await request(listeners),response);
  }
});

test('offline navigation returns generic no-store fallback without sensitive URL data', async () => {
  const {listeners}=fixture(async()=>{throw new TypeError('offline')});
  const response=await request(listeners,{url:'https://bubblewash.co/staff?token=private-token'});
  assert.equal(response.status,503); assert.equal(response.headers.get('cache-control'),'no-store');
  const body=await response.text();assert.match(body,/You're offline/); assert.match(body,/responses cannot be sent offline/);
  assert.doesNotMatch(body,/private-token|saved|queued|submitted successfully/i);
});

test('API requests, writes, cross-origin requests and Next data requests are not intercepted', () => {
  const {listeners}=fixture(()=>{throw new Error('must not fetch')});
  for(const overrides of [{method:'POST'},{method:'PUT'},{method:'DELETE'},{url:'https://bubblewash.co/api/research/responses'},{url:'https://bubblewash.co/api'},{mode:'cors'},{mode:'same-origin'},{url:'https://third-party.invalid/'}]) assert.equal(request(listeners,overrides),undefined);
});

test('worker claims clients but never caches, queues writes or forces updates', async () => {
  const {listeners,claimed}=fixture(()=>{});let promise;listeners.activate({waitUntil:value=>{promise=value}});await promise;assert.equal(claimed(),1);
  assert.deepEqual(Object.keys(listeners).sort(),['activate','fetch']);
  assert.doesNotMatch(worker,/caches\.|indexedDB|skipWaiting|backgroundSync|postMessage|\.reload\(/);
});

test('worker script is not cached and no new permissions are requested', async()=>{
  const rule=(await config.headers()).find(rule=>rule.source==='/sw.js');
  assert.match(rule.headers.find(header=>header.key==='Cache-Control').value,/no-store/);
  const provider=readFileSync(new URL('../src/components/WebAppProvider.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(provider,/Notification\.requestPermission|pushManager|localStorage|sessionStorage|location\.reload/);
  assert.match(provider,/updateViaCache: "none"/);
});

test('favicon ICO contains only resized approved clean Bubble Wash artwork', async () => {
  const ico = readFileSync(new URL('../src/app/favicon.ico', import.meta.url));
  const clean = readFileSync(new URL('../public/icon-192.png', import.meta.url));
  assert.equal(ico.readUInt16LE(0), 0); assert.equal(ico.readUInt16LE(2), 1);
  const sizes = [16, 32, 48, 192]; assert.equal(ico.readUInt16LE(4), sizes.length);
  let next = 6 + 16 * sizes.length;
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16;
    assert.equal(ico[entry], size); assert.equal(ico[entry + 1], size);
    const length = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
    assert.equal(offset, next); assert.ok(offset + length <= ico.length);
    const image = ico.subarray(offset, offset + length);
    const expected = size === 192 ? clean : await sharp(clean).resize(size, size).png().toBuffer();
    assert.deepEqual(image, expected, 'Every favicon frame uses the clean approved art, not the framework triangle');
    next += length;
  }
  assert.equal(next, ico.length);
});
