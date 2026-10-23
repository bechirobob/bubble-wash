import 'server-only';
import {randomUUID} from 'node:crypto';
import {getDatabase} from '../data-store.ts';
import {deliveryApproved,responseRecipient} from './policy.ts';
import {renderEmail} from './email.ts';
import {validate} from './model.ts';
type Database=ReturnType<typeof getDatabase>;
export type DeliveryOutcome={status:'accepted';messageId:string}|{status:'not-accepted';retryable:boolean}|{status:'uncertain'};
export type ResearchTransport=(message:ReturnType<typeof renderEmail>&{idempotencyKey:string})=>Promise<DeliveryOutcome>;
type Row={response_id:string;attempts:number;payload:string};
const maxAttempts=5,leaseMs=120_000,delays=[60_000,300_000,900_000,3_600_000];
// Internal engine accepts a transport explicitly for deterministic tests. It contains no network client,
// credential reads or runtime entry point. Nothing promotes held rows to pending in this candidate.
export async function deliverPendingResearch(db:Database,transport:ResearchTransport,now:number|(()=>number)=Date.now,limit=5){
 const clock=typeof now==='function'?now:()=>now;
 const time=new Date(clock()).toISOString();
 const expired=db.prepare("UPDATE research_notification_outbox SET state='failed',last_error_kind='uncertain-expired-lease',lease_token=NULL,lease_until=NULL WHERE state='sending' AND lease_until<=?").run(time).changes;
 const rows=db.prepare(`SELECT o.response_id,o.attempts,r.payload FROM research_notification_outbox o JOIN research_responses r ON r.id=o.response_id
  WHERE o.state='pending' AND o.recipient=? AND (o.next_attempt_at IS NULL OR o.next_attempt_at<=?)
  ORDER BY r.created_at LIMIT ?`).all(responseRecipient,time,Number.isFinite(limit)?Math.min(20,Math.max(1,Math.floor(limit))):5)as Row[];
 const counts={sent:0,deferred:0,review:Number(expired)};
 for(const row of rows){
  if(row.attempts>=maxAttempts){db.prepare("UPDATE research_notification_outbox SET state='failed',last_error_kind='attempt-limit' WHERE response_id=? AND state='pending'").run(row.response_id);counts.review++;continue;}
  const token=randomUUID();
  const claimNow=clock(),claimTime=new Date(claimNow).toISOString();
  const claim=db.prepare("UPDATE research_notification_outbox SET state='sending',attempts=attempts+1,lease_token=?,lease_until=? WHERE response_id=? AND state='pending' AND recipient=? AND attempts=? AND (next_attempt_at IS NULL OR next_attempt_at<=?)").run(token,new Date(claimNow+leaseMs).toISOString(),row.response_id,responseRecipient,row.attempts,claimTime);
  if(claim.changes!==1)continue;
  let message:ReturnType<typeof renderEmail>;
  try{message=renderEmail(validate(JSON.parse(row.payload)));}catch{db.prepare("UPDATE research_notification_outbox SET state='failed',last_error_kind='invalid-response',lease_token=NULL,lease_until=NULL WHERE response_id=? AND lease_token=?").run(row.response_id,token);counts.review++;continue;}
  let outcome:DeliveryOutcome;
  try{outcome=await transport({...message,idempotencyKey:'bubblewash-research/'+row.response_id});}catch{outcome={status:'uncertain'};}
  if(outcome.status==='accepted'&&typeof outcome.messageId==='string'&&outcome.messageId.length>0&&outcome.messageId.length<=200){
   const stored=db.prepare("UPDATE research_notification_outbox SET state='sent',provider_message_id=?,sent_at=?,last_error_kind=NULL,lease_token=NULL,lease_until=NULL WHERE response_id=? AND lease_token=?").run(outcome.messageId,new Date(clock()).toISOString(),row.response_id,token);if(stored.changes===1)counts.sent++;else counts.review++;
  }else if(outcome.status==='not-accepted'&&outcome.retryable&&row.attempts+1<maxAttempts){
   const stored=db.prepare("UPDATE research_notification_outbox SET state='pending',next_attempt_at=?,last_error_kind='rejected-retryable',lease_token=NULL,lease_until=NULL WHERE response_id=? AND lease_token=?").run(new Date(clock()+delays[Math.min(row.attempts,delays.length-1)]).toISOString(),row.response_id,token);if(stored.changes===1)counts.deferred++;else counts.review++;
  }else{
   db.prepare("UPDATE research_notification_outbox SET state='failed',last_error_kind=?,lease_token=NULL,lease_until=NULL WHERE response_id=? AND lease_token=?").run(outcome.status==='not-accepted'?'rejected':'uncertain-provider-outcome',row.response_id,token);counts.review++;
  }
 }
 return counts;
}
// Future maintenance integration must keep this code gate and separately approve a scoped provider
// adapter. A confirmed recipient is not approval to reuse an owner-enrollment API credential.
export async function processResearchNotifications(transport?:ResearchTransport,database?:Database){
 if(!deliveryApproved||!transport)return {enabled:false,sent:0,deferred:0,review:0};
 return {enabled:true,...await deliverPendingResearch(database??getDatabase(),transport)};
}

