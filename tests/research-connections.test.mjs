import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {saveResponse} from '../src/lib/research/store.ts';
import {deliverPendingResearch} from '../src/lib/research/delivery.ts';
import {schemaVersion,launchApproved,deliveryApproved} from '../src/lib/research/policy.ts';

const schema=readFileSync(new URL('../db/proposed/research-v1.sql',import.meta.url),'utf8');
const now=Date.parse('2026-10-23T17:00:00Z');
const input=(suffix='d')=>({adultEligible:true,instrument:'consumer',schemaVersion,submissionKey:`f9ba5dce-ae1c-4014-a167-a29c6f6c489${suffix}`,identity:{name:'Synthetic Adult',organisation:'',email:'adult@example.test',phone:'+233240000000'},consent:true,answers:{'icp-student':'No','icp-business':'No','icp-corporate':'No','icp-household':'No',A1:'25 to 34'},reference:'offline-test'});
function fixture(t){
 const dir=mkdtempSync(path.join(tmpdir(),'research-connections-'));
 const a=new Database(path.join(dir,'fixture.sqlite'));
 a.pragma('journal_mode = WAL');a.pragma('foreign_keys = ON');a.exec(schema);
 const b=new Database(path.join(dir,'fixture.sqlite'));b.pragma('foreign_keys = ON');
 t.after(()=>{a.close();b.close();rmSync(dir,{recursive:true,force:true});});
 assert.equal(launchApproved,false);assert.equal(deliveryApproved,false);
 return {a,b};
}
function seed(db,count=1){
 saveResponse(input(),db);if(count===2)saveResponse(input('e'),db);
 db.prepare("UPDATE research_notification_outbox SET state='pending',recipient='info@bubblewash.co'").run();
}
function barrier(){let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};}

test('two connections deduplicate an identical submission and preserve one atomic outbox row',t=>{
 const {a,b}=fixture(t);
 assert.deepEqual(saveResponse(input(),a),{duplicate:false});
 assert.deepEqual(saveResponse(input(),b),{duplicate:true});
 for(const db of [a,b]){
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM research_responses').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM research_notification_outbox').get().n,1);
 }
});

test('second connection rejects same-key changed payload without changing original response',t=>{
 const {a,b}=fixture(t);saveResponse(input(),a);
 const before=a.prepare('SELECT * FROM research_responses').get();
 const changed=input();changed.answers.A1='35 to 44';
 assert.throws(()=>saveResponse(changed,b),/SUBMISSION_CONFLICT/);
 assert.deepEqual(b.prepare('SELECT * FROM research_responses').get(),before);
 assert.equal(b.prepare('SELECT COUNT(*) AS n FROM research_notification_outbox').get().n,1);
});

test('outbox insertion failure rolls back response atomically across connections',t=>{
 const {a,b}=fixture(t);
 a.exec("CREATE TRIGGER reject_fixture_outbox BEFORE INSERT ON research_notification_outbox BEGIN SELECT RAISE(ABORT,'fixture outbox unavailable'); END;");
 assert.throws(()=>saveResponse(input(),a),/fixture outbox unavailable/);
 assert.equal(b.prepare('SELECT COUNT(*) AS n FROM research_responses').get().n,0);
 assert.equal(b.prepare('SELECT COUNT(*) AS n FROM research_notification_outbox').get().n,0);
});

test('two connection workers cannot transport the same claimed response twice',async t=>{
 const {a,b}=fixture(t);seed(a);const gate=barrier();let calls=0;
 const first=deliverPendingResearch(a,async()=>{calls++;await gate.promise;return {status:'accepted',messageId:'first'};},now);
 try{
  assert.equal(b.prepare('SELECT state FROM research_notification_outbox').get().state,'sending');
  assert.deepEqual(await deliverPendingResearch(b,async()=>{calls++;return {status:'accepted',messageId:'second'};},now+1),{sent:0,deferred:0,review:0});
 }finally{gate.release();}
 assert.equal((await first).sent,1);assert.equal(calls,1);
 assert.equal(b.prepare('SELECT provider_message_id FROM research_notification_outbox').get().provider_message_id,'first');
});

test('two connection stale multirow selection cannot bypass another worker retry schedule',async t=>{
 const {a,b}=fixture(t);seed(a,2);const gate=barrier();let firstCalls=0,otherCalls=0;
 const first=deliverPendingResearch(a,async()=>{firstCalls++;await gate.promise;return {status:'accepted',messageId:'first'};},now);
 try{
  const other=await deliverPendingResearch(b,async()=>{otherCalls++;return {status:'not-accepted',retryable:true};},now+1);
  assert.equal(other.deferred,1);
 }finally{gate.release();}
 assert.equal((await first).sent,1);assert.equal(firstCalls,1);assert.equal(otherCalls,1);
 const pending=b.prepare("SELECT attempts,next_attempt_at FROM research_notification_outbox WHERE state='pending'").get();
 assert.equal(pending.attempts,1);assert.equal(Date.parse(pending.next_attempt_at),now+60001);
 await deliverPendingResearch(a,async()=>{throw new Error('must not send before due time');},now+60000);
 assert.equal(b.prepare("SELECT attempts FROM research_notification_outbox WHERE state='pending'").get().attempts,1);
 assert.equal((await deliverPendingResearch(b,async()=>({status:'accepted',messageId:'retry'}),now+60001)).sent,1);
 assert.equal(a.prepare("SELECT COUNT(*) AS n FROM research_notification_outbox WHERE state='sent'").get().n,2);
});

test('expiry from a second connection makes late acceptance review-only without resending',async t=>{
 const {a,b}=fixture(t);seed(a);const gate=barrier();let calls=0;
 const first=deliverPendingResearch(a,async()=>{calls++;await gate.promise;return {status:'accepted',messageId:'late'};},now);
 try{
  assert.equal((await deliverPendingResearch(b,async()=>{calls++;return {status:'accepted',messageId:'unexpected'};},now+120001)).review,1);
 }finally{gate.release();}
 assert.deepEqual(await first,{sent:0,deferred:0,review:1});assert.equal(calls,1);
 assert.equal(b.prepare('SELECT state FROM research_notification_outbox').get().state,'failed');
});
