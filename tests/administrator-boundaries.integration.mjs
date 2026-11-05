import { AsyncLocalStorage } from 'node:async_hooks';
globalThis.AsyncLocalStorage = AsyncLocalStorage;
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
const directory=mkdtempSync(join(tmpdir(),'bw-admin-boundaries-'));
Object.assign(process.env,{NODE_ENV:'production',BUBBLEWASH_DATABASE_PATH:join(directory,'synthetic.sqlite'),BUBBLEWASH_SESSION_SECRET:'synthetic-boundary-test-session-key',BUBBLEWASH_DISABLE_DEMO_LOGIN:'true',BUBBLEWASH_STAFF_AUTH_DISABLED:'false',BUBBLEWASH_ADMIN_MFA_REQUIRED:'false',BUBBLEWASH_PUBLIC_URL:'https://bubblewash.example.invalid',BUBBLEWASH_RESEARCH_EMAIL_ENABLED:'false'});
delete process.env.BUBBLEWASH_UAT_ENABLED;
const {NextRequest}=await import('next/server');
const {getDatabase,appendSubmissionRecord}=await import('../src/lib/data-store.ts');
const {initializeStaffAccountsSchema}=await import('../src/lib/staff-accounts.ts');
const {administratorPermissionsDdl}=await import('../ops/administrator-invitation-transition.ts');
const {createPasswordHash}=await import('../src/lib/passwords.ts');
const auth=await import('../src/lib/auth.ts');
const {workAsyncStorage}=await import('next/dist/server/app-render/work-async-storage.external.js');
const {workUnitAsyncStorage}=await import('next/dist/server/app-render/work-unit-async-storage.external.js');
const results=await import('../src/app/api/admin/research/results/route.ts');
const list=await import('../src/app/api/admin/research/responses/route.ts');
const detail=await import('../src/app/api/admin/research/responses/[id]/route.ts');
const accounts=await import('../src/app/api/staff/accounts/route.ts');
const {buildOrderSummaries,readSubmissionsForOrder}=await import('../src/lib/submissions.ts');
const {automationActionsForOrder}=await import('../src/lib/order-workflow.ts');
const advance=await import('../src/app/api/orders/advance/route.ts');
const location=await import('../src/app/api/dispatch/location/route.ts');
const pages=Object.fromEntries(await Promise.all(['admin','vendors','drivers','support','admin/surveys'].map(async path=>[path,(await import(`../src/app/${path}/page.tsx`)).default])));
const withSession=(cookie,fn)=>workAsyncStorage.run({route:'/test'},()=>workUnitAsyncStorage.run({type:'request',phase:'render',cookies:{get:name=>name===auth.sessionCookieName&&cookie?{name,value:cookie}:undefined}},fn));
const req=(path,body)=>new NextRequest('https://bubblewash.example.invalid'+path,body?{method:'POST',headers:{host:'bubblewash.example.invalid',origin:'https://bubblewash.example.invalid','content-type':'application/json'},body:JSON.stringify(body)}:{});
const db=getDatabase();let checks=0;
try {
 initializeStaffAccountsSchema(db); db.exec(administratorPermissionsDdl);
 const passwordHash=createPasswordHash('synthetic-boundaries-password-123');
 const definitions=[['ordinary','admin',0,0],['workspaces','admin',1,0],['surveys','admin',0,1],['both','admin',1,1],['vendor','vendor',1,1],['driver','driver',1,1],['support','support',1,1]];
 for(const [key,role,ops,survey] of definitions){
  db.prepare("INSERT INTO staff_accounts VALUES (?, ?, ?, ?, ?, ?, 'active', '', '', ?)").run(key+'@example.invalid',key,role,['vendor','driver'].includes(role)?key+'-entity':'',passwordHash,randomUUID(),new Date().toISOString());
  db.prepare('INSERT INTO staff_admin_permissions VALUES (?, ?, ?)').run(key+'@example.invalid',ops,survey);
 }
 const cookies=Object.fromEntries(auth.currentStaffUsers().map(u=>[u.name,auth.encodeSession(u)]));
 db.exec(readFileSync(new URL('../db/proposed/research-v1.sql',import.meta.url),'utf8'));
 const {saveResponse}=await import('../src/lib/research/store.ts');
 const {schemaVersion}=await import('../src/lib/research/policy.ts');
 saveResponse({adultEligible:true,instrument:'consumer',schemaVersion,submissionKey:randomUUID(),identity:{name:'Synthetic respondent',organisation:'',email:'respondent@example.invalid',phone:'+233240000000'},consent:true,answers:{'icp-student':'No','icp-business':'No','icp-corporate':'No','icp-household':'Yes',A1:'25 to 34',A2:'Both',A3:'East Legon'},reference:'synthetic'},db);
 const id=db.prepare('SELECT id FROM research_responses').get().id;
 const reads=[()=>results.GET(req('/api/admin/research/results')),()=>list.GET(req('/api/admin/research/responses')),()=>detail.GET(req('/api/admin/research/responses/'+id),{params:Promise.resolve({id})})];
 const researchBefore=JSON.stringify(db.prepare('SELECT * FROM research_notification_outbox').all());
 for(const key of [null,...definitions.map(d=>d[0])]){
  const allowed=['surveys','both'].includes(key);
  for(const read of reads){const response=await withSession(cookies[key],read);assert.equal(response.status,allowed?200:403,key);assert.match(response.headers.get('cache-control'),/private, no-store/);if(!allowed)assert.ok(!(await response.text()).includes('respondent@example.invalid'));checks++;}
  for(const [path,page] of Object.entries(pages)){
   const admitted=path==='admin'?['ordinary','workspaces','surveys','both'].includes(key):path==='admin/surveys'?allowed:['workspaces','both'].includes(key)||({vendors:'vendor',drivers:'driver',support:'support'}[path]===key);
   const call=()=>withSession(cookies[key],()=>page({searchParams:Promise.resolve({})}));
   if(admitted){const element=await call();assert.ok(element);if(['workspaces','both'].includes(key))assert.equal(element.props.allStaffAccess,false);}
   else await assert.rejects(call(),error=>String(error.digest).startsWith('NEXT_REDIRECT;'));
   checks++;
  }
 }
 const response=await withSession(cookies.surveys,reads[2]);assert.equal((await response.json()).identity.email,'respondent@example.invalid');checks++;
 assert.equal(JSON.stringify(db.prepare('SELECT * FROM research_notification_outbox').all()),researchBefore);
 // Normal admin security surface remains unchanged; new flags do not create owner enrollment.
 assert.equal((await withSession(cookies.both,accounts.GET)).status,200);
 assert.equal((await withSession(cookies.both,()=>accounts.POST(req('/api/staff/accounts',{email:'other@example.invalid',name:'Other',role:'admin'})))).status,400);checks+=2;
 // Even with both grants, cross-role action keys cannot be obtained by forged request properties.
 appendSubmissionRecord({id:'BW-SYNTHETIC-ORDER',createdAt:new Date().toISOString(),source:'fixture',data:{submissionType:'pickup-booking',name:'Synthetic customer',email:'customer@example.invalid',area:'Osu',pickupAddress:'Synthetic address',plan:'Weekly',paymentPreference:'Invoice me'}});
 for(const [index,actionKey] of ['vendor-accept-job','driver-start-route'].entries()){
  appendSubmissionRecord({id:'BW-SYNTHETIC-STAGE-'+index,createdAt:new Date(Date.now()+1000+index).toISOString(),source:'fixture',data:{submissionType:index===0?'admin-operation':'vendor-job-update',orderId:'BW-SYNTHETIC-ORDER',actionType:'Assign vendor',orderStatus:index===0?'Vendor assigned':'Accepted',jobStatus:index===0?'Vendor assigned':'Accepted',vendorName:'Synthetic vendor',driverName:'Synthetic driver'}});
  const order=buildOrderSummaries(await readSubmissionsForOrder('BW-SYNTHETIC-ORDER'))[0];
  assert.ok(automationActionsForOrder(order,'admin','Synthetic owner',true).some(action=>action.key===actionKey),'owner could perform the action at this stage');
  assert.ok(!automationActionsForOrder(order,'admin','both',false).some(action=>action.key===actionKey));
  const r=await withSession(cookies.both,()=>advance.POST(req('/api/orders/advance',{orderId:'BW-SYNTHETIC-ORDER',actionKey,allStaffAccess:true,role:'driver'})));
  assert.equal(r.status,400);assert.match((await r.json()).error,/not allowed/);checks++;
 }
 assert.equal((await withSession(cookies.both,()=>location.POST(req('/api/dispatch/location',{orderId:'BW-SYNTHETIC-ORDER'})))).status,403);checks++;
 // Existing signed session immediately reflects revocation and cannot restore a grant from its claims.
 db.prepare("UPDATE staff_admin_permissions SET operational_workspaces=0,survey_results=0 WHERE email='both@example.invalid'").run();
 for(const read of reads){assert.equal((await withSession(cookies.both,read)).status,403);checks++;}
 for(const path of ['vendors','drivers','support','admin/surveys']){await assert.rejects(withSession(cookies.both,()=>pages[path]({searchParams:Promise.resolve({})})),e=>String(e.digest).startsWith('NEXT_REDIRECT;'));checks++;}
 db.prepare("UPDATE staff_accounts SET status='suspended' WHERE email='surveys@example.invalid'").run();
 for(const read of reads){assert.equal((await withSession(cookies.surveys,read)).status,403);checks++;}
 console.log(JSON.stringify({ok:true,checks,scope:'real route handlers and page guards; client rendering stubbed; independent grants, PII scope, role/action/GPS isolation, revocation and suspension'}));
} finally {db.close();rmSync(directory,{recursive:true,force:true});}
