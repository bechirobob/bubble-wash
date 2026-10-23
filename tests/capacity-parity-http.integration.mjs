import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPasswordHash } from '../src/lib/passwords.ts';
const sourceRoot = process.cwd();
const directory = mkdtempSync(join(tmpdir(), 'bubblewash-capacity-http-'));
const origin = 'http://127.0.0.1:3198';
for (const key of Object.keys(process.env)) if (/^(BUBBLEWASH_|NEXT_PUBLIC_BUBBLEWASH_|RESEND_|WHATSAPP_|PAYSTACK_)/.test(key)) delete process.env[key];
Object.assign(process.env, { NODE_ENV: 'production', BUBBLEWASH_DATABASE_PATH: join(directory, 'workflow.sqlite'), BUBBLEWASH_SESSION_SECRET: 'isolated-http-regression-session-secret-32-plus', BUBBLEWASH_STAFF_AUTH_DISABLED: 'false', BUBBLEWASH_DISABLE_DEMO_LOGIN: 'true', BUBBLEWASH_ADMIN_MFA_REQUIRED: 'false', BUBBLEWASH_NATIVE_API_ENABLED: 'true', BUBBLEWASH_VENDOR_ENTITY_ID: 'vendor-http', BUBBLEWASH_DRIVER_ENTITY_ID: 'driver-http', BUBBLEWASH_PUBLIC_URL: origin, NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED: 'false', NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED: 'false', RESEND_API_KEY: '', PAYSTACK_SECRET_KEY: '' });
for (const role of ['admin', 'vendor', 'driver', 'support']) { process.env[`BUBBLEWASH_${role.toUpperCase()}_EMAIL`] = `${role}@example.invalid`; process.env[`BUBBLEWASH_${role.toUpperCase()}_PASSWORD_HASH`] = createPasswordHash(`isolated-${role}-password-123`); }
// Isolate legacy cwd/data imports in both fixture process and Next server. No .env files are copied.
const runtimeRoot=join(directory,'runtime'); mkdirSync(runtimeRoot);
for(const name of ['.next','node_modules','public','src'])symlinkSync(join(sourceRoot,name),join(runtimeRoot,name),'dir');
for(const name of ['next.config.mjs','package.json'])copyFileSync(join(sourceRoot,name),join(runtimeRoot,name));
const denyNetwork=join(directory,'deny-network.mjs'); writeFileSync(denyNetwork, "globalThis.fetch=async()=>{throw new Error('External fetch forbidden in synthetic HTTP server')};\n");
process.chdir(directory);
const availability = await import('../src/lib/availability-store.ts');
availability.upsertVendorAvailability({ vendorId: 'vendor-http', vendorName: 'HTTP Laundry', serviceZones: ['Osu'], serviceTypes: ['Wash + fold'], capacityRemaining: 3, availabilityStatus: 'available', updatedBy: 'fixture' });
availability.upsertDriverAvailability({ driverId: 'driver-http', driverName: 'HTTP Rider', serviceZones: ['Osu'], capacityRemaining: 3, availabilityStatus: 'active', updatedBy: 'fixture' });
const server = spawn(process.execPath, ['--import',denyNetwork,join(sourceRoot,'node_modules/next/dist/bin/next'), 'start', runtimeRoot, '-H', '127.0.0.1', '-p', '3198'], { cwd:runtimeRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; server.stdout.on('data', (d) => output += d); server.stderr.on('data', (d) => output += d);
// Emulate the production HTTPS reverse proxy while transport stays on loopback.
let checks = 0; const cookies = {};
async function post(path, body, role, expected = 200) { const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { origin: 'https://127.0.0.1:3198', 'content-type': 'application/json', ...(cookies[role] ? { cookie: cookies[role] } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }); const data = await response.json(); assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`); checks++; return { data, response }; }
const { capacityFreshness } = await import('../src/lib/automation-store.ts');
const { getDatabase } = await import('../src/lib/data-store.ts');
availability.upsertVendorAvailability({vendorId:'vendor-other',vendorName:'Other Laundry',serviceZones:['Tema'],serviceTypes:['Dry cleaning'],capacityRemaining:99,availabilityStatus:'suspended',updatedBy:'fixture'});
const foreignBefore=availability.listVendorAvailability().find(vendor=>vendor.vendorId==='vendor-other');
async function get(role, expected=200) {
 const response = await fetch(`${origin}/api/vendor/capacity`,{headers: cookies[role]?{cookie:cookies[role]}:{}});
 const data=await response.json(); assert.equal(response.status,expected,JSON.stringify(data)); assert.match(response.headers.get('cache-control'),/no-store/); checks++;return data;
}
function command(vendor,overrides={}) {return {capacityRemaining:vendor.capacityRemaining,availabilityStatus:'available',note:'Synthetic confirmation only',expectedUpdatedAt:vendor.updatedAt,expectedRevision:vendor.revision,idempotencyKey:randomUUID(),...overrides};}
try {
 for(let i=0;i<60;i++){try{if((await fetch(`${origin}/api/health`)).ok)break;}catch{}if(server.exitCode!==null)throw new Error(output);await new Promise(r=>setTimeout(r,250));}
 for(const role of ['admin','vendor','driver','support']) {const {response}=await post('/api/login',{email:`${role}@example.invalid`,password:`isolated-${role}-password-123`});cookies[role]=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');}
 await get('anonymous',401); for(const role of ['admin','driver','support'])await get(role,403);
 const scoped=await get('vendor');assert.equal(scoped.vendors.length,1);assert.equal(scoped.vendors[0].vendorId,'vendor-http');
 const original=scoped.vendors[0];assert.equal(original.capacityFreshness.fresh,false);
 const cmd=command(original);
 for(const role of ['admin','driver','support'])await post('/api/vendor/capacity',cmd,role,403);
 await post('/api/vendor/capacity',cmd,'anonymous',401);
 for(const path of ['staff/login','staff/availability','staff/vendor/capacity','staff/session','staff/orders']) {
  for(const method of ['GET','POST']) {
   const response=await fetch(`${origin}/api/mobile/v1/${path}`,{method,headers:{'content-type':'application/json','x-bubblewash-client':'staff',cookie:cookies.admin,authorization:'Bearer synthetic-invalid-token'},...(method==='POST'?{body:JSON.stringify({email:'admin@example.invalid',password:'isolated-admin-password-123'})}:{})});
   assert.equal(response.status,404,`Excluded native endpoint ${method} ${path}`);checks++;
  }
 }
 for(const extra of [{origin:'https://attacker.example.invalid'},{origin:''},{cookie:'',authorization:'Bearer synthetic-invalid-token'}]) {
  const response=await fetch(`${origin}/api/vendor/capacity`,{method:'POST',headers:{origin:'https://127.0.0.1:3198','content-type':'application/json',cookie:cookies.vendor,...extra},body:JSON.stringify(cmd)});
  assert.equal(response.status,extra.authorization?401:403);checks++;
 }
 for(const extra of [{capacityRemaining:-1},{capacityRemaining:1.5},{capacityRemaining:1000},{availabilityStatus:'active'},{vendorId:'another-vendor'},{serviceZones:['Tema']}])await post('/api/vendor/capacity',{...cmd,...extra},'vendor',400);
 const saved=(await post('/api/vendor/capacity',cmd,'vendor')).data;
 assert.equal(capacityFreshness('vendor-http').fresh,true);
 assert.equal(getDatabase().prepare('SELECT source FROM submissions WHERE id=?').get(saved.id).source,'browser-vendor-capacity');
 await post('/api/vendor/capacity',{...cmd,capacityRemaining:8},'vendor',409);
 const replay=(await post('/api/vendor/capacity',cmd,'vendor')).data;assert.equal(replay.id,saved.id);assert.equal(replay.replayed,true);
 const current=(await get('vendor')).vendors[0];assert.deepEqual(current.serviceZones,original.serviceZones);assert.deepEqual(current.serviceTypes,original.serviceTypes);
 await post('/api/vendor/capacity',{...cmd,idempotencyKey:randomUUID()},'vendor',409);
 await post('/api/submit',{submissionType:'vendor-application',capacity:'999',area:'Tema',services:'Dry cleaning',availability:'Available today'},'vendor',409);
 assert.equal(availability.listVendorAvailability().find(vendor=>vendor.vendorId==='vendor-http').capacityRemaining,3);
 const countBefore=getDatabase().prepare('SELECT count(*) AS n FROM submissions').get().n;
 for(const status of ['suspended','offboarded','training','inactive']) {
  const roster=availability.listVendorAvailability().find(vendor=>vendor.vendorId==='vendor-http');availability.upsertVendorAvailability({...roster,availabilityStatus:status});
  const view=(await get('vendor')).vendors[0];assert.equal(view.capacityEditable,false);
  await post('/api/vendor/capacity',command(view),'vendor',403);
  assert.equal(capacityFreshness('vendor-http').fresh,false);
 }
 assert.equal(getDatabase().prepare('SELECT count(*) AS n FROM submissions').get().n,countBefore);
 availability.upsertVendorAvailability({...availability.listVendorAvailability().find(vendor=>vendor.vendorId==='vendor-http'),availabilityStatus:'available'});
 const fresh=(await get('vendor')).vendors[0];
 const race=await Promise.all([4,5].map(capacityRemaining=>fetch(`${origin}/api/vendor/capacity`,{method:'POST',headers:{origin:'https://127.0.0.1:3198','content-type':'application/json',cookie:cookies.vendor},body:JSON.stringify(command(fresh,{capacityRemaining}))})));
 assert.deepEqual(race.map(response=>response.status).sort(),[200,409]);checks+=2;
 assert.equal(getDatabase().prepare('SELECT count(*) AS n FROM notification_outbox').get().n,0);
 const billingExists=getDatabase().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='billing_entries'").get();
 assert.equal(billingExists ? getDatabase().prepare('SELECT count(*) AS n FROM billing_entries').get().n : 0,0);
 assert.equal(process.env.NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED,'false');
 assert.equal(process.env.NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED,'false');
 assert.deepEqual(availability.listVendorAvailability().find(vendor=>vendor.vendorId==='vendor-other'),foreignBefore);
 console.log(`PASS: ${checks} browser capacity and excluded-native HTTP checks; synthetic data only, provider fetch denied, no notifications or financial entries.`);
} finally {
 server.kill('SIGTERM'); await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));
 process.chdir(sourceRoot);rmSync(directory,{recursive:true,force:true});
}
