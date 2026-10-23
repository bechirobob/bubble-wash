import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPasswordHash } from '../src/lib/passwords.ts';
const sourceRoot = process.cwd();
const directory = mkdtempSync(join(tmpdir(), 'bubblewash-capacity-http-'));
const origin = 'http://127.0.0.1:3197';
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
const server = spawn(process.execPath, ['--import',denyNetwork,join(sourceRoot,'node_modules/next/dist/bin/next'), 'start', runtimeRoot, '-H', '127.0.0.1', '-p', '3197'], { cwd:runtimeRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; server.stdout.on('data', (d) => output += d); server.stderr.on('data', (d) => output += d);
// Emulate the production HTTPS reverse proxy while transport stays on loopback.
const cookies = {};
async function post(path, body, role, expected = 200) { const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { origin: 'https://127.0.0.1:3197', 'content-type': 'application/json', ...(cookies[role] ? { cookie: cookies[role] } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }); const data = await response.json(); assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`); return { data, response }; }

try {
 for(let i=0;i<60;i++){try{if((await fetch(`${origin}/api/health`)).ok)break;}catch{}if(server.exitCode!==null)throw new Error(output);await new Promise(r=>setTimeout(r,250));}
 const {response}=await post('/api/login',{email:'vendor@example.invalid',password:'isolated-vendor-password-123'});
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE_PATH);
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 try {
 const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});
 await context.addCookies(response.headers.getSetCookie().map(c=>{const [name,...value]=c.split(';')[0].split('=');return {name,value:value.join('='),url:origin};}));
 await context.route('**/*',async route=>{
  const request=route.request();if(!request.url().startsWith(origin+'/'))return route.abort();
  return route.continue({headers:{...request.headers(),...(request.method()==='POST'?{origin:'https://127.0.0.1:3197'}:{})}});
 });
 const page=await context.newPage();let writes=0;page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/api/vendor/capacity'))writes++;});
 await page.goto(origin+'/vendors?view=capacity');
 const submit=page.getByRole('button',{name:'Confirm capacity',exact:true});await submit.waitFor();
 assert.equal(await page.locator('input[name="area"],select[name="services"]').count(),0);
 await page.getByLabel('Order slots remaining').fill('7');
 await submit.evaluate(button=>{button.click();button.click();});
 await page.getByRole('status').filter({hasText:'Capacity confirmed for 12 hours'}).waitFor();
 assert.equal(writes,1);assert.equal(availability.listVendorAvailability()[0].capacityRemaining,7);
 await page.getByLabel('Order slots remaining').waitFor();
 await page.screenshot({path:join(sourceRoot,'evidence/capacity-mobile.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 availability.upsertVendorAvailability({...availability.listVendorAvailability()[0],capacityRemaining:8});
 await page.getByLabel('Order slots remaining').fill('9');await submit.click();
 await page.getByRole('status').filter({hasText:'Availability changed'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Confirm capacity',exact:true}).count(),0);
 assert.equal(availability.listVendorAvailability()[0].capacityRemaining,8);
 await page.getByRole('button',{name:'Refresh capacity',exact:true}).click();
 await submit.waitFor();assert.equal(await page.getByLabel('Order slots remaining').inputValue(),'9');
 await page.getByText(/Current saved capacity: 8/).waitFor();
 await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:join(sourceRoot,'evidence/capacity-desktop.png'),fullPage:true});
 console.log('PASS: browser mobile/desktop layout, approved-scope fields absent, duplicate-click suppression, successful confirmation, stale-write failure and explicit refresh recovery. Loopback proxy Origin simulated; no external requests.');
 } finally {await browser.close();}
} finally {server.kill('SIGTERM');await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));process.chdir(sourceRoot);rmSync(directory,{recursive:true,force:true});}
