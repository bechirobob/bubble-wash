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
    const icon=manifest.icons.find(icon=>icon.sizes===`${size}x${size}` && icon.purpose==='any'); assert.ok(icon);
    const meta=await sharp(new URL(`../public${icon.src}`,import.meta.url).pathname).metadata();
    assert.equal(meta.width,size); assert.equal(meta.height,size); assert.equal(meta.format,'png');
  }
  const maskable=manifest.icons.find(icon=>icon.purpose==='maskable'); assert.ok(maskable);
  const {data,info}=await sharp(new URL(`../public${maskable.src}`,import.meta.url).pathname).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  assert.equal(info.width,512);assert.equal(info.height,512);
  for(let i=3;i<data.length;i+=4) assert.equal(data[i],255,'Maskable background is fully opaque');
  const original=await sharp(new URL('../public/icon-512.png',import.meta.url).pathname).flatten({background:'#ffffff'}).raw().toBuffer();
  const packaged=await sharp(new URL(`../public${maskable.src}`,import.meta.url).pathname).raw().toBuffer();
  assert.deepEqual(packaged,original,'Approved logo pixels preserved; only transparent corners flattened');
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
