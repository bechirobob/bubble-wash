import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { totpCode } from '../src/lib/totp.ts';
import { createPasswordHash } from '../src/lib/passwords.ts';

const originalCwd = process.cwd();
const directory = mkdtempSync(join(tmpdir(), 'bubblewash-automation-test-'));
for (const key of Object.keys(process.env)) if (/^(BUBBLEWASH_|NEXT_PUBLIC_BUBBLEWASH_|RESEND_|WHATSAPP_|PAYSTACK_)/.test(key)) delete process.env[key];
Object.assign(process.env, {
  NODE_ENV: 'production', BUBBLEWASH_DATABASE_PATH: join(directory, 'synthetic.sqlite'),
  BUBBLEWASH_SESSION_SECRET: 'synthetic-automation-session-secret-32-plus', BUBBLEWASH_NATIVE_API_ENABLED: 'true',
  BUBBLEWASH_OPERATIONS_AUTOMATION_ENABLED: 'true', BUBBLEWASH_STAFF_AUTH_DISABLED: 'false',
  BUBBLEWASH_DISABLE_DEMO_LOGIN: 'true', BUBBLEWASH_ADMIN_MFA_REQUIRED: 'false',
  BUBBLEWASH_VENDOR_ENTITY_ID: 'vendor-auto', BUBBLEWASH_DRIVER_ENTITY_ID: 'driver-auto',
  BUBBLEWASH_PUBLIC_URL: 'https://bubblewash.example.invalid',
  NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED: 'false', NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED: 'false',
});
for (const role of ['admin','vendor','driver','support']) {
  process.env[`BUBBLEWASH_${role.toUpperCase()}_EMAIL`] = `${role}@example.invalid`;
  process.env[`BUBBLEWASH_${role.toUpperCase()}_PASSWORD_HASH`] = createPasswordHash(`synthetic-${role}-automation-password`);
}
process.chdir(directory);
const { inviteStaffAccount, inviteOwnerAccount, activateStaffAccount } = await import('../src/lib/staff-accounts.ts');
for (const role of ['vendor','driver','support']) {
 const token = inviteStaffAccount({email:`${role}@example.invalid`,name:`Synthetic ${role}`,role,entityId:role==='vendor'?'vendor-auto':role==='driver'?'driver-auto':''},'fixture');
 assert.equal(activateStaffAccount(token,`synthetic-${role}-automation-password`),true);
}
process.env.BUBBLEWASH_MFA_ENCRYPTION_KEY=Buffer.alloc(32,23).toString('base64');
const ownerToken=inviteOwnerAccount({email:'owner@example.invalid',name:'Personal Owner'},'fixture');
assert.equal(activateStaffAccount(ownerToken,'synthetic-owner-automation-password'),true);
const runtimeRoot=join(directory,'runtime');mkdirSync(runtimeRoot);
for(const name of ['.next','node_modules','public','src'])symlinkSync(join(originalCwd,name),join(runtimeRoot,name),'dir');
for(const name of ['next.config.mjs','package.json'])copyFileSync(join(originalCwd,name),join(runtimeRoot,name));
const denyNetwork=join(directory,'deny-network.mjs');writeFileSync(denyNetwork,"globalThis.fetch=async()=>{throw new Error('Provider fetch forbidden in synthetic tests')};\n");
const server=spawn(process.execPath,['--import',denyNetwork,join(originalCwd,'node_modules/next/dist/bin/next'),'start',runtimeRoot,'-H','127.0.0.1','-p','3197'],{cwd:runtimeRoot,env:process.env,stdio:['ignore','pipe','pipe']});
let output='';server.stdout.on('data',d=>output+=d);server.stderr.on('data',d=>output+=d);
const origin='http://127.0.0.1:3197';

const { getDatabase, appendSubmissionRecord, readSubmissionRecordsForOrder, purgeOperationalData } = await import('../src/lib/data-store.ts');
const { buildOrderSummaries } = await import('../src/lib/submissions.ts');
const { automationWorklist, manageWorkOwnership, dispatchRecommendations, reconciliationWorklist } = await import('../src/lib/operations-automation.ts');
const { capacityFreshness, recordCapacityConfirmation } = await import('../src/lib/automation-store.ts');
const { upsertVendorAvailability, upsertDriverAvailability, reserveAssignmentCapacity, listVendorAvailability } = await import('../src/lib/availability-store.ts');
const { issueIntakeInvoice, recordBillingEntry } = await import('../src/lib/billing.ts');
const { plans } = await import('../src/lib/pricing.ts');
const now = Date.now(), old = new Date(now - 86400_000).toISOString();
const actors = Object.fromEntries(['admin','vendor','driver','support'].map(role => [role,{email:`${role}@example.invalid`,name:role,role,entityId:role==='vendor'?'vendor-auto':role==='driver'?'driver-auto':undefined}]));
const order1='BW-AUTOORDER0001', order2='BW-AUTOORDER0002', order3='BW-AUTOORDER0003', caseId='BW-AUTOCASE00001';
const seed = (id,data,createdAt=old) => appendSubmissionRecord({id,createdAt,source:'synthetic-automation-test',data});
for(const id of [order1,order2,order3]) seed(id,{submissionType:'pickup-booking',name:'Synthetic only',email:'customer@example.invalid',phone:'0200000000',pickupAddress:'Synthetic address MUST-NOT-LEAK',company:'Synthetic Company',area:'Osu',zone:'core',plan:plans[0].name,service:'Wash + fold'});
seed('BW-AUTOASSIGN001',{submissionType:'admin-operation',orderId:order1,orderStatus:'Washing',vendorId:'vendor-auto',vendorName:'Synthetic Laundry',driverId:'driver-auto',driverName:'Synthetic Rider'});
seed('BW-AUTOASSIGN002',{submissionType:'admin-operation',orderId:order2,orderStatus:'Driver en route',vendorId:'other-vendor',vendorName:'Other Laundry',driverId:'other-driver',driverName:'Other Rider'});
seed('BW-AUTOASSIGN003',{submissionType:'admin-operation',orderId:order3,orderStatus:'Pickup scheduled'});
seed(caseId,{submissionType:'support-ticket',orderId:order1,ticketStatus:'Open',message:'Sensitive case MUST-NOT-LEAK'});
seed('BW-AUTOCONTACT01',{submissionType:'support-ticket-action',orderId:order1,contactChannel:'Phone call',contactOutcome:'No answer',nextFollowUpAt:new Date(now-60_000).toISOString(),message:'Sensitive contact MUST-NOT-LEAK'});
upsertVendorAvailability({vendorId:'vendor-auto',vendorName:'Synthetic Laundry',serviceZones:['Osu'],serviceTypes:['Wash + fold'],capacityRemaining:7,availabilityStatus:'available',updatedBy:'synthetic'});
upsertVendorAvailability({vendorId:'other-vendor',vendorName:'Other Laundry',serviceZones:['Tema'],serviceTypes:['Dry cleaning'],capacityRemaining:99,availabilityStatus:'available',updatedBy:'synthetic'});
upsertDriverAvailability({driverId:'driver-auto',driverName:'Synthetic Rider',serviceZones:['Osu'],capacityRemaining:10,availabilityStatus:'active',updatedBy:'synthetic'});
const tokens={}; let requests=0; let groups=0;
async function call(path,{role='admin',body,expected=200,headers={},token=tokens[role]}={}) {
 const endpoint=path==='staff/availability'||path==='staff/vendor/capacity'?'vendor/capacity':path;
 const response=await fetch(`${origin}/api/${endpoint}`,{method:body===undefined?'GET':'POST',headers:{origin:'https://127.0.0.1:3197',...(body===undefined?{}:{'content-type':'application/json'}),...(token?{cookie:token}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const data=await response.json();assert.equal(response.status,expected,`${path}: ${JSON.stringify(data)}`);assert.match(response.headers.get('cache-control'),/no-store/);requests++;return data;
}
async function authPost(path,body,expected=200) {
 const response=await fetch(`${origin}/api/${path}`,{method:'POST',headers:{origin:'https://127.0.0.1:3197','content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();assert.equal(response.status,expected,JSON.stringify(data));requests++;return{response,data};
}
const itemFor = (role,id) => automationWorklist(actors[role],new URLSearchParams({itemId:id}),now).items[0];
const cmd = item => ({itemId:item.id,ownerEmail:actors.support.email,dueAt:new Date(now+3600_000).toISOString(),note:'Synthetic owned follow-up',expectedRevision:item.revision,signalVersion:item.signalVersion,idempotencyKey:randomUUID()});
try {
 for(let i=0;i<120;i++){try{if((await fetch(`${origin}/api/health`)).ok)break;}catch{}if(server.exitCode!==null)throw new Error(output);await new Promise(r=>setTimeout(r,250));}
 for(const role of ['admin','vendor','driver','support']) {const {response}=await authPost('login',{email:actors[role].email,password:`synthetic-${role}-automation-password`});tokens[role]=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');}
 const endpoints=['worklist','assignees',`dispatch?orderId=${order1}`,'reconciliation','notifications'];
 for(const endpoint of endpoints) {
  await call(`staff/automation/${endpoint}`,{token:'',expected:401});
  await call(`staff/automation/${endpoint}`,{token:'',headers:{authorization:'Bearer untrusted-native-token'},expected:401});
 }
 const ownerCredentials={email:'owner@example.invalid',password:'synthetic-owner-automation-password'};
 await authPost('login',ownerCredentials,403);
 const setup=(await authPost('admin/mfa/enroll',{...ownerCredentials,action:'start'})).data;
 const confirmation=(await authPost('admin/mfa/enroll',{...ownerCredentials,action:'confirm',code:totpCode(setup.enrollment.manualKey)})).data;
 await authPost('login',ownerCredentials,401);
 const ownerLogin=await authPost('login',{...ownerCredentials,totp:confirmation.recoveryCodes[0]});
 tokens.owner=ownerLogin.response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 const ownerPage=await fetch(`${origin}/staff/worklist`,{headers:{cookie:tokens.owner}});assert.equal(ownerPage.status,200);assert.match(await ownerPage.text(),/Personal Owner/);
 await call('staff/automation/worklist',{role:'owner'});
 for(const path of ['staff/login','staff/automation/worklist','staff/automation/ownership']) {
  const response=await fetch(`${origin}/api/mobile/v1/${path}`,{headers:{cookie:tokens.owner,authorization:'Bearer untrusted-native-token'}});assert.equal(response.status,404);requests++;
 }
 groups++;

 const admin=await call('staff/automation/worklist');
 assert.ok(admin.items.some(item=>item.kind==='order-unassigned'&&item.targetId===order3));
 assert.equal(admin.items.find(item=>item.id==='vendor-capacity:vendor-auto').title,'Confirm capacity for Synthetic Laundry');
 assert.equal(admin.items.find(item=>item.id==='vendor-capacity:other-vendor').title,'Confirm capacity for Other Laundry');
 assert.equal(admin.items.find(item=>item.id==='vendor-capacity:vendor-auto').targetId,'vendor-auto');
 assert.ok(admin.items.some(item=>item.kind==='contact-followup'&&item.overdue));
 for(const role of ['vendor','driver']) {
  const result=await call('staff/automation/worklist',{role});
  assert.ok(result.items.some(item=>item.targetId===order1));
  assert.equal(result.items.some(item=>[order2,caseId,'other-vendor'].includes(item.targetId)),false);
  assert.equal(JSON.stringify(result).includes('MUST-NOT-LEAK'),false);
  assert.ok(result.items.every(item=>!item.canManage&&!item.note&&!item.ownerEmail));
  for(const endpoint of ['assignees',`dispatch?orderId=${order1}`,'reconciliation','notifications']) await call(`staff/automation/${endpoint}`,{role,expected:403});
 }
 assert.throws(()=>automationWorklist({...actors.vendor,entityId:undefined},new URLSearchParams(),now),{status:403});
 assert.equal(itemFor('vendor',`case-followup:${caseId}`),undefined);
 assert.equal(itemFor('support','vendor-capacity:vendor-auto'),undefined); groups++;

 const caseItem=itemFor('support',`case-followup:${caseId}`), body=cmd(caseItem);
 for(const role of ['driver','vendor']) await call('staff/automation/ownership',{role,body,expected:403});
 for(const extra of [{unknown:'x'},{ownerEmail:'nobody@example.invalid'},{dueAt:'2026-10-23T09:30'},{note:''},{expectedRevision:1.5},{idempotencyKey:'short'}]) await call('staff/automation/ownership',{role:'support',body:{...body,...extra},expected:400});
 for(const headers of [{origin:'https://attacker.example.invalid'},{origin:''}])await call('staff/automation/ownership',{role:'support',body,headers,expected:403});
 await call('staff/automation/ownership',{role:'support',body:{...body,submittedByEmail:'owner@example.invalid'},expected:400});
 const saved=await call('staff/automation/ownership',{role:'support',body});
 const replay=await call('staff/automation/ownership',{role:'support',body}); assert.equal(saved.id,replay.id); assert.equal(replay.replayed,true);
 const audit=JSON.parse(getDatabase().prepare('SELECT data FROM submissions WHERE id=?').get(saved.id).data);assert.equal(audit.submittedByEmail,actors.support.email);assert.equal(audit.submittedByRole,'support');
 await call('staff/automation/ownership',{role:'support',body:{...body,note:'Different body'},expected:409});
 await call('staff/automation/ownership',{role:'support',body:{...body,idempotencyKey:randomUUID()},expected:409});
 const updated=itemFor('support',caseItem.id); assert.equal(updated.ownerEmail,actors.support.email); assert.equal(updated.revision,1);
 const toAdmin={...cmd(updated),ownerEmail:actors.admin.email}; await call('staff/automation/ownership',{role:'support',body:toAdmin,expected:403});
 await call('staff/automation/ownership',{body:toAdmin});
 await call('staff/automation/ownership',{role:'support',body:cmd(itemFor('support',caseItem.id)),expected:403});
 assert.equal(automationWorklist(actors.admin,new URLSearchParams({filter:'mine'}),now).items.some(item=>item.id===caseItem.id),true);
 assert.equal(automationWorklist(actors.support,new URLSearchParams({filter:'mine'}),now).items.some(item=>item.id===caseItem.id),false);
 const ownerCommand={...cmd(itemFor('admin',caseItem.id)),ownerEmail:'owner@example.invalid'};
 const ownerSaved=await call('staff/automation/ownership',{role:'owner',body:ownerCommand});
 const ownerAudit=JSON.parse(getDatabase().prepare('SELECT data FROM submissions WHERE id=?').get(ownerSaved.id).data);
 assert.equal(ownerAudit.submittedByEmail,'owner@example.invalid');assert.equal(ownerAudit.submittedByRole,'admin');
 const refresh=itemFor('admin',caseItem.id), race=cmd(refresh);
 const results=await Promise.allSettled([Promise.resolve().then(()=>manageWorkOwnership(actors.admin,race,now)),Promise.resolve().then(()=>manageWorkOwnership(actors.admin,{...race,idempotencyKey:randomUUID()},now))]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
 assert.equal(results.filter(result=>result.status==='rejected'&&result.reason.status===409).length,1); groups++;

 const stale=cmd(itemFor('admin',caseItem.id));
 seed('BW-AUTOCASEUPDATE',{submissionType:'support-ticket-action',ticketId:caseId,ticketStatus:'In Review'},new Date(now+1).toISOString());
 assert.throws(()=>manageWorkOwnership(actors.admin,stale,now),{status:409});
 seed('BW-AUTOCASECLOSE',{submissionType:'support-ticket-action',ticketId:caseId,ticketStatus:'Closed'},new Date(now+2).toISOString());
 assert.equal(itemFor('admin',caseItem.id),undefined);
 seed('BW-CASEDEADLINE',{submissionType:'support-ticket-action',ticketId:caseId,orderId:order2,ticketStatus:'Closed',nextFollowUpAt:new Date(now-60_000).toISOString()},new Date(now+3).toISOString());
 assert.equal(itemFor('support',`contact-followup:${order2}`),undefined);
 const contact=itemFor('support',`contact-followup:${order1}`); assert.ok(contact.overdue);
 seed('BW-AUTOCONTACT02',{submissionType:'support-ticket-action',orderId:order1,contactChannel:'Phone call',contactOutcome:'No answer',nextFollowUpAt:'2026-10-23T11:00'},new Date(now+3).toISOString());
 assert.match(itemFor('support',contact.id).detail,/no reliable timezone/);
 const queue=await call('staff/automation/worklist?filter=followups',{role:'support'}); assert.ok(queue.items.every(item=>item.kind.endsWith('followup')));
 await call('staff/automation/worklist?filter=unsupported',{expected:400}); groups++;

 const rosterBefore=getDatabase().prepare('SELECT * FROM vendor_availability ORDER BY vendor_id').all();
 const before=dispatchRecommendations(actors.admin,order3,now); assert.equal(before.vendors.find(item=>item.vendorId==='vendor-auto').recommended,false);
 assert.ok(before.vendors.find(item=>item.vendorId==='other-vendor').reasons.length>=2);
 assert.deepEqual(getDatabase().prepare('SELECT * FROM vendor_availability ORDER BY vendor_id').all(),rosterBefore);
 assert.equal(capacityFreshness('vendor-auto',now).state,'unconfirmed');
 const vendor=(await call('staff/availability',{role:'vendor'})).vendors[0];
 await call('staff/vendor/capacity',{role:'vendor',body:{capacityRemaining:vendor.capacityRemaining,availabilityStatus:'available',expectedUpdatedAt:vendor.updatedAt,expectedRevision:vendor.revision,note:'Confirm currently available slots',idempotencyKey:randomUUID()}});
 const confirmed=capacityFreshness('vendor-auto'); assert.equal(confirmed.fresh,true);
 assert.equal(automationWorklist(actors.vendor,new URLSearchParams({itemId:'vendor-capacity:vendor-auto'})).items.length,0);
 const after=dispatchRecommendations(actors.admin,order3); assert.equal(after.vendors[0].vendorId,'vendor-auto'); assert.equal(after.vendors[0].recommended,true);
 reserveAssignmentCapacity('BW-AUTOCAPACITY01','vendor-auto',undefined);
 assert.equal(capacityFreshness('vendor-auto').confirmedAt,confirmed.confirmedAt);
 assert.equal(capacityFreshness('vendor-auto',Date.parse(confirmed.confirmedAt)+12*3600_000).state,'stale');
 assert.equal(capacityFreshness('vendor-auto',Date.parse(confirmed.confirmedAt)-1).fresh,false);
 recordCapacityConfirmation('vendor-auto','synthetic',new Date(now-13*3600_000).toISOString());
 assert.ok(itemFor('vendor','vendor-capacity:vendor-auto'));
 for(const availabilityStatus of ['offboarded','training','unknown-status']) {
  upsertVendorAvailability({...listVendorAvailability().find(item=>item.vendorId==='vendor-auto'),availabilityStatus});
  recordCapacityConfirmation('vendor-auto','synthetic',new Date(now).toISOString());
  const candidate=dispatchRecommendations(actors.admin,order3,now).vendors.find(item=>item.vendorId==='vendor-auto');
  assert.equal(candidate.eligible,false);assert.equal(candidate.recommended,false);
  assert.throws(()=>reserveAssignmentCapacity(`BW-BLOCKED-${availabilityStatus}`,'vendor-auto',undefined),/no longer available/);
 }
 upsertVendorAvailability({...listVendorAvailability().find(item=>item.vendorId==='vendor-auto'),availabilityStatus:'available',capacityRemaining:4});
 recordCapacityConfirmation('vendor-auto','synthetic',new Date(now).toISOString());
 const originalRoster=listVendorAvailability().find(item=>item.vendorId==='vendor-auto');
 upsertVendorAvailability({...originalRoster,notes:'Only an internal roster note'});
 assert.equal(capacityFreshness('vendor-auto',now).fresh,true);
 upsertVendorAvailability({...originalRoster,capacityRemaining:99});
 assert.equal(capacityFreshness('vendor-auto',now).state,'unconfirmed');
 assert.equal(dispatchRecommendations(actors.admin,order3,now).vendors.find(item=>item.vendorId==='vendor-auto').recommended,false); groups++;

 seed('BW-AUTODELIVERY01',{submissionType:'driver-route-log',orderId:order1,orderStatus:'Delivered'},new Date(now+4).toISOString());
 assert.ok(reconciliationWorklist(actors.admin).items.find(item=>item.orderId===order1).reasons.includes('Invoice missing after laundry check-in'));
 const invoice=issueIntakeInvoice(order1,12);
 assert.ok(reconciliationWorklist(actors.admin).items.find(item=>item.orderId===order1).reasons.some(reason=>reason.includes('outstanding')));
 seed('BW-AUTOREFUNDCASE',{submissionType:'support-ticket',orderId:order1,customerAction:'refund',ticketStatus:'Open'});
 const financialBefore=getDatabase().prepare('SELECT * FROM billing_entries').all();
 const recon=await call('staff/automation/reconciliation'); assert.ok(recon.items.find(item=>item.orderId===order1).reasons.some(reason=>reason === 'Review the refund request. No completed refund is recorded')); assert.ok(recon.items.every(item=>item.financialActionAvailable===false));
 assert.deepEqual(getDatabase().prepare('SELECT * FROM billing_entries').all(),financialBefore);
 await call('staff/automation/reconciliation',{role:'support',expected:403});
 await call('staff/automation/notifications',{role:'support',expected:403});
 const health=await call('staff/automation/notifications'); assert.equal(health.resendAvailable,false); assert.equal(health.providerActivationAvailable,false); assert.equal(typeof health.summary.manualReview,'number');
 getDatabase().prepare(`INSERT INTO notification_outbox (id,dedupe_key,channel,target,payload,status,attempts,next_attempt_at,created_at,updated_at,delivery_state,last_error,provider_request,provider_idempotency_key,provider_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('synthetic-review','synthetic-review-key','email','customer',JSON.stringify({to:'private@example.invalid',text:'MUST-NOT-LEAK activation-secret'}),'failed',2,old,old,old,'manual_review','MUST-NOT-LEAK provider error','MUST-NOT-LEAK request','MUST-NOT-LEAK key','MUST-NOT-LEAK provider-id');
 const outboxBefore=getDatabase().prepare('SELECT * FROM notification_outbox').all();
 const review=await call('staff/automation/notifications');assert.equal(review.items[0].id,'synthetic-review');assert.doesNotMatch(JSON.stringify(review),/MUST-NOT-LEAK|private@example.invalid|activation-secret/);assert.deepEqual(getDatabase().prepare('SELECT * FROM notification_outbox').all(),outboxBefore);
 await call('staff/automation/reconciliation',{body:{action:'refund'},expected:405});
 recordBillingEntry(order1,'payment',invoice.totalMinor+1,'synthetic-only-overpayment','synthetic',true);
 assert.ok(reconciliationWorklist(actors.admin).items.find(item=>item.orderId===order1).reasons.some(reason=>reason.includes('Overpayment'))); groups++;

 for(let i=0;i<105;i++) seed(`BW-AUTOPAGE${String(i).padStart(5,'0')}`,{submissionType:'pickup-booking',area:'Tema',name:'Synthetic page',service:'Wash + fold'},new Date(now+100+i).toISOString());
 let offset=0,seen=new Set(),pages=0;
 do {const page=automationWorklist(actors.admin,new URLSearchParams({offset:String(offset)}),now+2*86400_000);page.items.forEach(item=>seen.add(item.id));offset=page.nextOffset;pages++;} while(offset!==null);
 assert.ok(pages>=2); assert.ok([...seen].some(id=>id.includes(order2)));
 assert.equal(getDatabase().prepare('SELECT count(*) AS n FROM operational_work_ownership').get().n,1); groups++;
 const historic='BW-AUTORETENTION1', yearsAgo=new Date(now-3*365*86400_000).toISOString();
 seed(historic,{submissionType:'pickup-booking',name:'Synthetic retention'},yearsAgo);
 seed('BW-AUTORETENTION2',{submissionType:'admin-operation',orderId:historic,actionType:'Close order',orderStatus:'Closed'},yearsAgo);
 seed('BW-AUTORETENTION3',{submissionType:'operations-work-action',orderId:historic,message:'Synthetic historical owner note'},yearsAgo);
 getDatabase().prepare('INSERT INTO operational_work_ownership VALUES (?,?,?,?,?,?,?)').run(`order-overdue-received:${historic}`,actors.admin.email,yearsAgo,'Synthetic old note',1,yearsAgo,historic);
 getDatabase().prepare('INSERT INTO operational_command_receipts VALUES (?,?,?,?,?)').run('synthetic-expired-scope','synthetic-expired-key','synthetic-hash','{}',yearsAgo);
 getDatabase().prepare('INSERT INTO order_holds VALUES (?,?,?)').run(historic,'Synthetic hold',yearsAgo);
 purgeOperationalData(now); assert.equal(getDatabase().prepare('SELECT count(*) AS n FROM operational_work_ownership WHERE order_id=?').get(historic).n,1);
 assert.equal(getDatabase().prepare('SELECT count(*) AS n FROM operational_command_receipts WHERE scope=?').get('synthetic-expired-scope').n,0);
 getDatabase().prepare('DELETE FROM order_holds WHERE order_id=?').run(historic);
 purgeOperationalData(now); assert.equal(getDatabase().prepare('SELECT count(*) AS n FROM operational_work_ownership WHERE order_id=?').get(historic).n,0);
 assert.equal(getDatabase().prepare('SELECT 1 FROM submissions WHERE id=?').get('BW-AUTORETENTION3'),undefined); groups++;
 assert.equal(dispatchRecommendations(actors.admin,order3,now).assignmentAvailable,true);
 seed('BW-ASSIGNDECLINE',{submissionType:'vendor-job-update',orderId:order3,jobStatus:'Declined'},new Date(now+20000).toISOString());
 assert.equal(buildOrderSummaries(readSubmissionRecordsForOrder(order3))[0].lastEventType,'vendor-job-update');
 assert.equal(buildOrderSummaries(readSubmissionRecordsForOrder(order3))[0].workflowStage.key,'exception');
 assert.equal(dispatchRecommendations(actors.admin,order3,now).assignmentAvailable,true);
 seed('BW-ASSIGNDELAY',{submissionType:'driver-route-log',orderId:order3,orderStatus:'Delayed'},new Date(now+21000).toISOString());
 assert.equal(buildOrderSummaries(readSubmissionRecordsForOrder(order3))[0].lastEventType,'driver-route-log');
 assert.equal(dispatchRecommendations(actors.admin,order3,now).assignmentAvailable,false);
 const olderCase='BW-OLDERCASE-ROOT';
 seed(olderCase,{submissionType:'support-ticket',ticketId:'CASE-CUSTOM-REFERENCE',ticketStatus:'Open',message:'Exact historical case'});
 seed('BW-OLDERCASE-ACTION',{submissionType:'support-ticket-action',ticketId:'CASE-CUSTOM-REFERENCE',ticketStatus:'In Review',message:'Exact case history'},new Date(now+30000).toISOString());
 for(let i=0;i<510;i++)seed(`BW-UNRELATED-${i}`,{submissionType:'operations-work-action',message:'Unrelated newer audit'},new Date(now+31000+i).toISOString());
 for(const role of ['admin','support']) {
   const exact=await call(`staff/automation/case?caseId=${olderCase}`,{role});
   assert.deepEqual(new Set(exact.records.map(row=>row.id)),new Set([olderCase,'BW-OLDERCASE-ACTION']));
   const alias=await call('staff/automation/case?caseId=CASE-CUSTOM-REFERENCE',{role});assert.equal(alias.records[0].id,olderCase);
 }
 for(const role of ['vendor','driver'])await call(`staff/automation/case?caseId=${olderCase}`,{role,expected:403});
 await call('staff/automation/case?caseId=missing-case',{expected:404});
 seed('BW-DUPLICATECASE',{submissionType:'support-ticket',ticketId:'CASE-CUSTOM-REFERENCE',ticketStatus:'Open'});
 await call('staff/automation/case?caseId=CASE-CUSTOM-REFERENCE',{expected:409});
 const aliasVendor='vendor-canonical';
 upsertVendorAvailability({vendorId:aliasVendor,vendorName:'Canonical Vendor',serviceZones:['Osu'],serviceTypes:['Wash + fold'],capacityRemaining:2,availabilityStatus:'available',updatedBy:'fixture'});
 const canonicalItem=itemFor('admin',`vendor-capacity:${aliasVendor}`);
 assert.throws(()=>manageWorkOwnership(actors.admin,{...cmd(canonicalItem),itemId:`vendor-capacity:${aliasVendor.toUpperCase()}`},now),{status:400});
 assert.equal(getDatabase().prepare('SELECT 1 FROM operational_work_ownership WHERE item_id=?').get(`vendor-capacity:${aliasVendor.toUpperCase()}`),undefined);
 const rollbackCase='BW-WORKLISTROLLBACK';
 seed(rollbackCase,{submissionType:'support-ticket',ticketStatus:'Open'});
 const rollbackCommand=cmd(itemFor('support',`case-followup:${rollbackCase}`));
 const receiptCount=getDatabase().prepare('SELECT count(*) AS n FROM operational_command_receipts').get().n;
 getDatabase().exec(`CREATE TEMP TRIGGER reject_worklist_audit BEFORE INSERT ON submissions WHEN NEW.source='browser-operations-work-ownership' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`);
 assert.throws(()=>manageWorkOwnership(actors.support,rollbackCommand,now),/synthetic audit failure/);
 assert.equal(getDatabase().prepare('SELECT count(*) AS n FROM operational_work_ownership WHERE item_id=?').get(rollbackCommand.itemId).n,0);
 assert.equal(getDatabase().prepare('SELECT count(*) AS n FROM operational_command_receipts').get().n,receiptCount);
 getDatabase().exec('DROP TRIGGER reject_worklist_audit');
 const rollbackSaved=manageWorkOwnership(actors.support,rollbackCommand,now);
 assert.equal(manageWorkOwnership(actors.support,rollbackCommand,now).id,rollbackSaved.id);
 seed('BW-ROLLBACKCLOSED',{submissionType:'support-ticket-action',ticketId:rollbackCase,ticketStatus:'Closed'},new Date(now+9999).toISOString());
 assert.equal(manageWorkOwnership(actors.support,rollbackCommand,now).id,rollbackSaved.id);
 assert.equal(manageWorkOwnership(actors.support,rollbackCommand,now).replayed,true);
 assert.throws(()=>manageWorkOwnership(actors.support,{...rollbackCommand,note:'Changed after closure'},now),{status:409});groups++;
 await call('staff/automation/notifications',{body:{action:'resend'},expected:405});
 console.log(`PASS: ${groups} automation scenario groups, ${requests} cookie-authenticated HTTP checks; provider fetch forbidden.`);
} finally {server.kill('SIGTERM');await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));process.chdir(originalCwd);rmSync(directory,{recursive:true,force:true});}
