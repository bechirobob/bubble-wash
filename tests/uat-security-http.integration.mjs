import { AsyncLocalStorage } from 'node:async_hooks';
globalThis.AsyncLocalStorage = AsyncLocalStorage;
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { NextRequest } = await import('next/server');
const root = mkdtempSync(join(tmpdir(), 'bw-uat-api-'));
const realNow = Date.now;
let now = realNow();
Date.now = () => now;
Object.assign(process.env, {
  NODE_ENV: 'production', BUBBLEWASH_UAT_ENABLED: 'true', BUBBLEWASH_UAT_ISOLATION_CONFIRMED: 'true',
  BUBBLEWASH_DATABASE_DRIVER: 'sqlite', BUBBLEWASH_UAT_DATA_ROOT: root, BUBBLEWASH_DATABASE_PATH: join(root, 'test.sqlite'),
  BUBBLEWASH_PUBLIC_URL: 'https://uat.example.invalid', BUBBLEWASH_DISABLE_DEMO_LOGIN: 'true',
  NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED: 'false', NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED: 'false',
  BUBBLEWASH_RESEARCH_EMAIL_ENABLED: 'false', BUBBLEWASH_STAFF_AUTH_DISABLED: 'false',
  BUBBLEWASH_SESSION_SECRET: 'synthetic-uat-session-secret-never-deploy', BUBBLEWASH_ADMIN_MFA_REQUIRED: 'true',
  BUBBLEWASH_TRUST_PROXY_HEADERS: 'true',
});
for (const key of ['PAYSTACK_SECRET_KEY','RESEND_API_KEY','WHATSAPP_ACCESS_TOKEN','WHATSAPP_PHONE_NUMBER_ID','BUBBLEWASH_RESEARCH_RESEND_KEY','BUBBLEWASH_OWNER_RESEND_KEY','NEXT_PUBLIC_BUBBLEWASH_WHATSAPP','NEXT_PUBLIC_BUBBLEWASH_CONTACT_EMAIL']) delete process.env[key];
const { getDatabase } = await import('../src/lib/data-store.ts');
const { issueUatCohort, createUatTeamAccount, createUatAccount, revokeUatTeamAccount, UAT_WINDOW_MS } = await import('../src/lib/uat-accounts.ts');
const auth = await import('../src/lib/auth.ts');
const { GET: readiness } = await import('../src/app/api/uat/ready/route.ts');
const availability = await import('../src/lib/availability-store.ts');
const { POST: login } = await import('../src/app/api/login/route.ts');
const accounts = await import('../src/app/api/staff/accounts/route.ts');
const team = await import('../src/app/api/uat/accounts/route.ts');
const submissions = await import('../src/app/api/submit/route.ts');
const earlyAccess = await import('../src/app/api/early-access/route.ts');
const privacy = await import('../src/app/api/privacy/requests/route.ts');
const customerRoutes = await Promise.all(['access','order','request','decision','delivery-code','recover'].map(async name=>[name,await import(`../src/app/api/customer/${name}/route.ts`)]));
const tracking = await import('../src/app/api/track/route.ts');
const activation = await import('../src/app/api/staff/activate/route.ts');
const operations = await import('../src/app/api/admin/operations/route.ts');
const { POST: enroll } = await import('../src/app/api/admin/mfa/enroll/route.ts');
const { POST: recover } = await import('../src/app/api/admin/recover/route.ts');
const research = await import('../src/app/api/admin/research/results/route.ts');
const { workAsyncStorage } = await import('next/dist/server/app-render/work-async-storage.external.js');
const { workUnitAsyncStorage } = await import('next/dist/server/app-render/work-unit-async-storage.external.js');
let ip = 1;
const request = (path, body = {}) => new NextRequest(`https://uat.example.invalid${path}`, {method:'POST', headers:{origin:'https://uat.example.invalid',host:'uat.example.invalid','content-type':'application/json','x-forwarded-for':`192.0.2.${ip++}`},body:JSON.stringify(body)});
const withSession = (value, fn) => workAsyncStorage.run({route:'/api/staff/accounts'}, () => workUnitAsyncStorage.run({type:'request',phase:'render',cookies:{get:name=>name === auth.sessionCookieName && value ? {name,value}:undefined}},fn));
const db = getDatabase();
try {
  const password = 'synthetic-test-password-12345';
  const startsAt = now;
  availability.upsertVendorAvailability({vendorId:'synthetic-vendor',vendorName:'Synthetic Vendor',capacityRemaining:5,availabilityStatus:'available',updatedBy:'fixture'});
  availability.upsertDriverAvailability({driverId:'synthetic-driver',driverName:'Synthetic Driver',capacityRemaining:5,availabilityStatus:'available',updatedBy:'fixture'});
  const cohort = ['admin','vendor','driver','support'].map(role => ({username:role === 'admin' ? 'uat.general-admin' : `uat.${role}`,name:`Synthetic ${role}`,role,password,entityId:['vendor','driver'].includes(role) ? `synthetic-${role}` : undefined}));
  assert.throws(() => issueUatCohort(cohort.slice(1),'fixture',db),/four approved/);
  assert.throws(() => issueUatCohort(cohort.map(a => a.role === 'support' ? {...a,password:'short'} : a),'fixture',db));
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='staff_uat_accounts'").get(),undefined,'failed issuance rolls back the whole cohort and schema');
  const issued = issueUatCohort(cohort,'fixture',db);
  assert.equal(issued.issuedAt,now,'window begins only at explicit working-credential issuance');
  assert.equal(issued.expiresAt,now+UAT_WINDOW_MS);
  assert.ok(issued.accounts.every(a=>a.startsAt===issued.issuedAt && a.expiresAt===issued.expiresAt));
  assert.doesNotMatch(JSON.stringify(issued),/password|synthetic-test-password/,'issuance receipt never exposes passwords');
  const snapshot = () => JSON.stringify({accounts:db.prepare('SELECT * FROM staff_uat_accounts ORDER BY username').all(),audit:db.prepare('SELECT * FROM staff_uat_audit ORDER BY id').all()});
  const initial = snapshot();
  now = startsAt - 1;
  assert.equal((await readiness()).status,503,'readiness blocked before access window');
  assert.equal(snapshot(),initial,'read-only readiness never audits or mutates before start');
  now = startsAt;
  assert.equal((await readiness()).status,200,'all four temporary roles and exact synthetic schema admitted');
  assert.equal(snapshot(),initial,'positive readiness is read-only');
  for (const role of ['vendor','driver','support']) {
    const result = await login(request('/api/login',{username:`uat.${role}`,password,next:'/admin'}));
    assert.equal(result.status,200);
    assert.equal((await result.json()).next,{vendor:'/vendors',driver:'/drivers',support:'/support'}[role]);
    const identity = auth.decodeSession(result.cookies.get(auth.sessionCookieName)?.value);
    assert.equal(identity.role,role);
    assert.equal(identity.entityId,role === 'support' ? undefined : `synthetic-${role}`);
  }
  const response = await login(request('/api/login',{username:'uat.general-admin',password}));
  assert.equal(response.status,200, 'username/password UAT works without weakening production MFA');
  const cookie = response.cookies.get(auth.sessionCookieName)?.value;
  assert.equal((await activation.POST(request('/api/staff/activate',{token:'not-an-invite',password:'synthetic-password-123'}))).status,403);
  for (const [name,handler] of customerRoutes) assert.equal((await withSession('',()=>(handler.POST||handler.GET)(request(`/api/customer/${name}`,{})))).status,401,'anonymous customer UAT access denied');
  assert.equal((await withSession('',()=>tracking.GET(new NextRequest('https://uat.example.invalid/api/track?id=private-id')))).status,401);
  for (const [handler,path] of [[submissions,'/api/submit'],[earlyAccess,'/api/early-access'],[privacy,'/api/privacy/requests']]) {
    assert.equal((await withSession('',()=>handler.POST(request(path,{})))).status,401,'anonymous UAT writes denied');
    assert.equal((await withSession(cookie,()=>handler.POST(request(path,{})))).status,400,'active tester reaches normal validation');
  }
  assert.equal((await withSession(cookie,()=>submissions.POST(request('/api/submit',{})))).status,400,'active tester reaches real form validation');
  assert.ok(cookie);
  assert.equal(auth.decodeSession(cookie).temporaryAccess,true);
  assert.equal(auth.decodeSession(cookie).allStaffAccess,false);
  assert.equal((await login(request('/api/login',{username:'uat.general-admin',password:'incorrect-password'}))).status,401);
  assert.equal((await login(request('/api/login',{username:'not-present',password}))).status,401);
  assert.equal((await login(request('/api/login',null))).status,400);
  assert.equal((await login(request('/api/login',{username:'x'.repeat(161),password}))).status,401);
  for (const handler of [accounts.GET,operations.GET]) assert.equal((await withSession(cookie,handler)).status,403);
  for (const [handler,path] of [[accounts.POST,'/api/staff/accounts'],[operations.POST,'/api/admin/operations']]) {
    assert.equal((await withSession(cookie,()=>handler(request(path,{action:'invite',email:'other@example.invalid',name:'Other',role:'support'})))).status,403);
  }
  assert.equal((await withSession(cookie,()=>research.GET(new NextRequest('https://uat.example.invalid/api/admin/research/results')))).status,403);
  for (const action of ['start','confirm']) {
    assert.equal((await enroll(request('/api/admin/mfa/enroll',{action,email:'uat.general-admin',password,code:'000000'}))).status,401);
  }
  for (const action of ['resume','acknowledge']) {
    const req = request('/api/admin/mfa/enroll',{action}); req.cookies.set(auth.sessionCookieName,cookie);
    assert.equal((await enroll(req)).status,401);
  }
  assert.equal((await recover(request('/api/admin/recover',{token:'not-a-recovery-token'}))).status,403);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='staff_accounts'").get().n,0,'no permanent identity store created');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM admin_mfa_settings').get().n,0,'no MFA security changes');
  // A reviewer can add staff testers, but cannot renew the group or create admins.
  now = startsAt + 86400000;
  const adminIdentity = auth.findStaffUser('uat.general-admin',password);
  const teamCookie = auth.encodeSession(adminIdentity);
  const teamPost = body => withSession(teamCookie,()=>team.POST(request('/api/uat/accounts',body)));
  const child = {action:'create',username:'extra-support',name:'Extra test support',role:'support',password};
  assert.equal((await withSession('',team.GET)).status,403);
  const supportCookie=auth.encodeSession(auth.findStaffUser('uat.support',password));
  assert.equal((await withSession(supportCookie,()=>team.POST(request('/api/uat/accounts',child)))).status,403);
  const wrongOrigin=request('/api/uat/accounts',child); wrongOrigin.headers.set('origin','https://other.invalid');
  assert.equal((await withSession(teamCookie,()=>team.POST(wrongOrigin))).status,403);
  assert.equal((await teamPost({...child,role:'admin'})).status,400);
  assert.equal((await teamPost({...child,role:'owner'})).status,400);
  assert.equal((await teamPost({...child,expiresAt:now+UAT_WINDOW_MS})).status,400);
  assert.equal((await teamPost({...child,role:'vendor',entityId:'missing'})).status,400);
  const childResponse=await teamPost(child); assert.equal(childResponse.status,200);
  const childData=await childResponse.json();
  assert.equal(childData.account.startsAt,startsAt);
  assert.equal(childData.account.expiresAt,startsAt+UAT_WINDOW_MS,'late joiner inherits original seven-day cutoff');
  assert.equal((await teamPost(child)).status,400,'duplicate cannot reset or extend account');
  for(const role of ['vendor','driver']) assert.equal((await teamPost({...child,username:`extra-${role}`,role,entityId:`synthetic-${role}`})).status,200);
  const childSession=auth.encodeSession(auth.findStaffUser(child.username,password));
  assert.equal((await teamPost({action:'revoke',username:child.username})).status,200);
  assert.equal(auth.decodeSession(childSession),null,'admin revocation invalidates existing child session');
  assert.equal((await teamPost({action:'revoke',username:'uat.general-admin'})).status,400,'cannot revoke administrator');
  createUatAccount({...child,username:'different-cohort',startsAt:now},'operator',db);
  assert.throws(()=>revokeUatTeamAccount('different-cohort',adminIdentity,db),/test group/);
  for(let i=0;i<13;i++) createUatTeamAccount({...child,username:`bounded-${i}`},adminIdentity,db);
  assert.equal((await teamPost({...child,username:'beyond-limit'})).status,400,'bounded cohort includes revoked accounts');
  const teamData=await (await withSession(teamCookie,team.GET)).json();
  assert.equal(teamData.remaining,0); assert.equal(teamData.limit,20);
  assert.doesNotMatch(JSON.stringify(teamData),/password|credentialVersion|different-cohort|uat.general-admin/,'team list reveals neither secrets nor other cohorts/admin accounts');
  assert.ok(db.prepare("SELECT 1 FROM staff_uat_audit WHERE username=? AND actor=? AND action='created'").get('extra-vendor','uat.general-admin'));
  assert.ok(db.prepare("SELECT 1 FROM staff_uat_audit WHERE username=? AND actor=? AND action='revoked'").get(child.username,'uat.general-admin'));
  now = startsAt + UAT_WINDOW_MS;
  const beforeExpiredProbe = snapshot();
  assert.equal((await readiness()).status,503,'readiness blocked at exact deadline');
  assert.equal(snapshot(),beforeExpiredProbe,'expired read-only probe does not write expiry audit');
  assert.equal((await login(request('/api/login',{username:'uat.general-admin',password}))).status,401);
  assert.equal(auth.decodeSession(cookie),null);
  for (const [name,handler] of customerRoutes) assert.equal((await withSession(cookie,()=>(handler.POST||handler.GET)(request(`/api/customer/${name}`,{})))).status,401,'expired customer UAT access denied');
  assert.equal((await withSession(cookie,()=>tracking.GET(new NextRequest('https://uat.example.invalid/api/track?id=private-id')))).status,401);
  for (const [handler,path] of [[submissions,'/api/submit'],[earlyAccess,'/api/early-access'],[privacy,'/api/privacy/requests']]) assert.equal((await withSession(cookie,()=>handler.POST(request(path,{})))).status,401,'expired UAT session cannot submit forms');
  assert.equal((await withSession(teamCookie,()=>team.POST(request('/api/uat/accounts',child)))).status,403,'expired administrator cannot create accounts');
  assert.equal((await withSession(cookie,accounts.GET)).status,403);
  console.log(JSON.stringify({ok:true,temporaryUsernameLogin:true,delegatedStaffAccounts:true,cohortExpiryInherited:true,absoluteDeadline:true,securityGuards:true,noPermanentAccounts:true,noMfaChanges:true,syntheticOnly:true}));
} finally { Date.now = realNow; db.close(); rmSync(root,{recursive:true,force:true}); }
