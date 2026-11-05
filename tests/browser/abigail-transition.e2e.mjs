import './block-egress.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { createFixtureEdge } from './fixture-edge.mjs';
import { createPasswordHash } from '../../src/lib/passwords.ts';
import { totpCode } from '../../src/lib/totp.ts';
const required=process.argv.includes('--global-on');
for(const filename of ['.env','.env.local','.env.production','.env.production.local'])assert.equal(existsSync(filename),false,'fixture refuses local environment files');
const platform=Object.fromEntries(['PATH','HOME','TMPDIR','TEMP','TMP','SYSTEMROOT'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
for(const key of Object.keys(process.env))delete process.env[key];
const directory=mkdtempSync(join(tmpdir(),'bw-abigail-browser-'));
Object.assign(process.env,platform,{NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',BUBBLEWASH_DATABASE_PATH:join(directory,'synthetic.sqlite'),BUBBLEWASH_SESSION_SECRET:'synthetic-browser-session-secret-123456',BUBBLEWASH_STAFF_AUTH_DISABLED:'false',BUBBLEWASH_DISABLE_DEMO_LOGIN:'true',BUBBLEWASH_ADMIN_MFA_REQUIRED:String(required),NEXT_PUBLIC_BUBBLEWASH_ADMIN_MFA_REQUIRED:String(required),BUBBLEWASH_TRUST_PROXY_HEADERS:'true',BUBBLEWASH_PUBLIC_URL:'http://localhost:3100',BUBBLEWASH_ADMIN_EMAIL:'master@example.invalid',BUBBLEWASH_ADMIN_PASSWORD_HASH:createPasswordHash('synthetic-master-password-123'),BUBBLEWASH_ADMIN_TOTP_SECRET:'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',BUBBLEWASH_MFA_ENCRYPTION_KEY:Buffer.alloc(32,23).toString('base64'),NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED:'false',NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED:'false'});
const {getDatabase,appendSubmissionRecord}=await import('../../src/lib/data-store.ts');
const {initializeStaffAccountsSchema}=await import('../../src/lib/staff-accounts.ts');
const {administratorTransitionFingerprint,prepareAdministratorInvitation}=await import('../../ops/administrator-invitation-transition.ts');
const {encodeSession}=await import('../../src/lib/auth.ts');
const db=getDatabase();initializeStaffAccountsSchema(db);
const email='abigail@bubblewash.co',password='synthetic-abigail-password-123',oldToken=randomBytes(32).toString('base64url');
db.exec('CREATE TABLE staff_owner_capabilities (email TEXT PRIMARY KEY COLLATE NOCASE REFERENCES staff_accounts(email), all_staff_access INTEGER NOT NULL CHECK (all_staff_access = 1))');
db.prepare("INSERT INTO staff_accounts VALUES (?, 'Abigail Kabirou', 'admin', '', '', 'old-version', 'invited', ?, '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z')").run(email,createHash('sha256').update(oldToken).digest('hex'));
db.prepare('INSERT INTO staff_owner_capabilities VALUES (?, 1)').run(email);
db.prepare("INSERT INTO staff_accounts VALUES ('unrelated@example.invalid', 'Unrelated', 'admin', '', ?, 'unchanged-version', 'active', '', '', '2000-01-01')").run(createPasswordHash('synthetic-unrelated-password-123'));
const unrelatedBefore=db.prepare("SELECT * FROM staff_accounts WHERE email != ?").all(email);
const masterBefore=db.prepare('SELECT * FROM staff_credential_overrides').all();
const oldSession=encodeSession({email,name:'Abigail Kabirou',role:'admin',credentialVersion:'old-version',passwordHash:''});
db.exec(readFileSync('db/proposed/research-v1.sql','utf8'));
const {saveResponse}=await import('../../src/lib/research/store.ts');
const {schemaVersion}=await import('../../src/lib/research/policy.ts');
saveResponse({adultEligible:true,instrument:'consumer',schemaVersion,submissionKey:randomUUID(),identity:{name:'Synthetic respondent',organisation:'',email:'respondent@example.invalid',phone:'+233240000000'},consent:true,answers:{'icp-student':'No','icp-business':'No','icp-corporate':'No','icp-household':'Yes',A1:'25 to 34',A2:'Both',A3:'East Legon',E1:'5'},reference:'fixture'},db);
appendSubmissionRecord({id:'BW-BROWSER-ORDER',createdAt:new Date(Date.now()-5000).toISOString(),source:'fixture',data:{submissionType:'pickup-booking',name:'Synthetic customer',email:'customer@example.invalid',area:'Osu',pickupAddress:'Synthetic address',plan:'Weekly',paymentPreference:'Invoice me'}});
appendSubmissionRecord({id:'BW-BROWSER-STAGE',createdAt:new Date().toISOString(),source:'fixture',data:{submissionType:'admin-operation',orderId:'BW-BROWSER-ORDER',actionType:'Assign vendor',orderStatus:'Vendor assigned',vendorName:'Synthetic vendor',driverName:'Synthetic driver'}});
const server=spawn(process.execPath,['--import',resolve('tests/browser/block-egress.mjs'),'node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p','3101'],{env:process.env,stdio:['ignore','pipe','pipe']});
let serverOutput='';for(const pipe of [server.stdout,server.stderr])pipe.on('data',data=>{serverOutput=(serverOutput+data).slice(-12000);});
const edge=createFixtureEdge();await new Promise((res,rej)=>{edge.once('error',rej);edge.listen(3100,'127.0.0.1',res);});
let browser;const checks=[];
try{
 for(let i=0;i<120;i++){try{if((await fetch('http://localhost:3100/api/health')).ok)break;}catch{}if(server.exitCode!==null)throw Error('Synthetic server exited');if(i===119)throw Error('Synthetic server not ready');await new Promise(r=>setTimeout(r,250));}
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({baseURL:'http://localhost:3100',serviceWorkers:'block',viewport:{width:1440,height:1000}});
 await context.route('**/*',route=>new URL(route.request().url()).hostname==='localhost'?route.continue():route.abort());
 const page=await context.newPage();page.setDefaultTimeout(15000);
 async function activation(token,want){await page.goto('/staff/activate#'+token);await page.getByLabel('New password').fill(password);await page.getByRole('button',{name:'Activate access',exact:true}).click();await expect(page.getByRole('status')).toHaveText(want);}
 await activation(oldToken,'This link is expired or already used.');checks.push('expired same-address owner link rejected by actual activation UI');
 const result=prepareAdministratorInvitation(db,{expectedFingerprint:administratorTransitionFingerprint(db),actor:'synthetic-reviewer@example.invalid',confirmedEmail:email,approved:true,operationalWorkspaces:true,surveyResults:true},process.env);
 assert.ok(Date.parse(result.expiresAt)-Date.now()<=86400000);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM staff_accounts WHERE email=?').get(email).n,1);
 await activation(result.token,'Access activated. You can now sign in.');await expect(page).toHaveURL('http://localhost:3100/staff/activate');
 await activation(result.token,'This link is expired or already used.');checks.push('new setup UI activates once, clears fragment, rejects reuse; one unchanged email identity');
 await page.goto('/login');await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeEnabled();await page.getByLabel('Staff username or email').fill(email);await page.getByLabel('Password',{exact:true}).fill(password);
 if(required){
  await expect(page.getByRole('link',{name:'Set up admin authenticator'})).toBeVisible();
  await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'Admin sign-in is temporarily unavailable.'})).toBeVisible();
  await page.getByRole('link',{name:'Set up admin authenticator'}).click();await page.getByLabel('Admin email').fill(email);await page.getByLabel('Password',{exact:true}).fill(password);
  const responsePromise=page.waitForResponse(r=>r.url().endsWith('/api/admin/mfa/enroll')&&r.request().postDataJSON()?.action==='start');
  await page.getByRole('button',{name:'Start secure setup'}).click();const setup=await (await responsePromise).json();
  await expect(page.getByAltText('Bubble Wash admin authenticator QR code')).toBeVisible();
  const codeInput=page.locator('input[inputmode="numeric"]');await codeInput.fill(totpCode(setup.enrollment.manualKey));
  const confirmationPromise=page.waitForResponse(r=>r.url().endsWith('/api/admin/mfa/enroll')&&r.request().postDataJSON()?.action==='confirm');
  await page.getByRole('button',{name:/Confirm authenticator/}).click();const confirmed=await (await confirmationPromise).json();await expect(page.getByText('Authenticator enrolled. Save every recovery code before continuing.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:/saved.*recovery|saved.*codes/i}).click();await expect(page).toHaveURL(/\/admin$/);checks.push('MFA-on real UI: personal enrollment QR, TOTP confirmation, recovery acknowledgement, admin entry');
  await page.locator('.staffAccountMenu > summary').click();await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeEnabled();await page.getByLabel('Staff username or email').fill(email);await page.getByLabel('Password',{exact:true}).fill(password);
  const totpInput=page.getByLabel('Admin authenticator or recovery code',{exact:false});
  await totpInput.fill(totpCode(process.env.BUBBLEWASH_ADMIN_TOTP_SECRET));await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'Invalid Bubble Wash staff credentials.'})).toBeVisible();
  await totpInput.fill(confirmed.recoveryCodes[0]);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page).toHaveURL(/\/admin$/);checks.push('MFA-on login UI rejects legacy authenticator and accepts personal recovery code');
 }else{await expect(page.getByRole('link',{name:'Set up admin authenticator'})).toHaveCount(0);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page).toHaveURL(/\/admin$/);checks.push('MFA-off actual login UI uses unchanged password-only administrator policy');}
 for(const [label,path] of [['Vendor workspace','/vendors'],['Rider workspace','/drivers'],['Support workspace','/support'],['Operations','/admin']]){
  await page.locator('.staffAccountMenu > summary').click();await page.getByRole('navigation',{name:'Staff workspaces'}).getByRole('link',{name:label,exact:true}).click();await expect(page).toHaveURL(new RegExp(path+'$'));await expect(page.locator('.staffAccountMenu > summary')).toBeVisible();
  if(path==='/drivers')await expect(page.getByText('Share live location',{exact:true})).toHaveCount(0);
 }
 checks.push('actual workspace navigation: admin, vendor, driver, support; no driver GPS control');
 await page.locator('.staffAccountMenu > summary').click();await page.getByRole('navigation',{name:'Staff workspaces'}).getByRole('link',{name:'Survey results'}).click();await expect(page).toHaveURL(/\/admin\/surveys$/);
 await expect(page.getByRole('heading',{name:'Survey results',exact:true})).toBeVisible();
 await page.getByRole('tab',{name:'Responses',exact:true}).click();await page.getByRole('button',{name:'Open response from Synthetic respondent'}).click();await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('dialog').getByText('respondent@example.invalid',{exact:true})).toBeVisible();checks.push('real survey aggregate UI and identifiable response-detail dialog rendered');
 const api=await page.evaluate(async()=>{const post=async(path,body)=>{const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};return {action:await post('/api/orders/advance',{orderId:'BW-BROWSER-ORDER',actionKey:'vendor-accept-job',allStaffAccess:true}),gps:await post('/api/dispatch/location',{orderId:'BW-BROWSER-ORDER'})};});
 assert.equal(api.action.status,400);assert.match(api.action.data.error,/not allowed/);assert.equal(api.gps.status,403);checks.push('actual HTTP rejects forged owner-only vendor action and GPS publication');
 const stale=await browser.newContext({baseURL:'http://localhost:3100'});await stale.addCookies([{name:'bubblewash_staff_session',value:oldSession,url:'http://localhost:3100'}]);assert.equal((await stale.request.get('/api/admin/research/results')).status(),403);await stale.close();checks.push('pre-transition session remains invalid after activation');
 db.prepare('UPDATE staff_accounts SET credential_version=? WHERE email=?').run('synthetic-revoked-version',email);
 await page.goto('/admin');await expect(page).toHaveURL(/\/login\?next=/);checks.push('current browser session revoked by credential-version change');
 assert.deepEqual(db.prepare('SELECT * FROM staff_accounts WHERE email != ?').all(email),unrelatedBefore);assert.deepEqual(db.prepare('SELECT * FROM staff_credential_overrides').all(),masterBefore);assert.equal(db.prepare('SELECT * FROM staff_owner_capabilities WHERE email=?').get(email),undefined);checks.push('unrelated account/master records preserved and Abigail owner capability absent');
 console.log(JSON.stringify({ok:true,browser:'Chromium',globalMfa:required,checks}));
}catch(error){console.error('Synthetic browser failure:',error.message.replace(/#[A-Za-z0-9_-]{43}/g,'#[redacted]'));throw Error('Abigail synthetic browser test failed; see assertion classification above');}
finally{await browser?.close();edge.closeAllConnections();await new Promise(r=>edge.close(r));server.kill('SIGTERM');await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));db.close();rmSync(directory,{recursive:true,force:true});}
