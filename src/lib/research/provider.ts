import 'server-only';
import {randomUUID} from 'node:crypto';
import {getDatabase} from '../data-store.ts';
import {saveResponse} from './store.ts';
import {renderEmail} from './email.ts';
import {schemaVersion} from './policy.ts';
import {deliveryApproved,responseRecipient} from './policy.ts';
import {processResearchNotifications,type ResearchTransport} from './delivery.ts';
export const researchSender='Bubble Wash <bubblewash@becoreops.com>';
// Dedicated survey credential only. Never fall back to owner-enrollment or general service keys.
export function researchEmailReady(env:Record<string,string|undefined>=process.env){
 return deliveryApproved&&env.BUBBLEWASH_RESEARCH_EMAIL_ENABLED==='true'&&Boolean(env.BUBBLEWASH_RESEARCH_RESEND_KEY?.trim());
}
function transport(key:string,send:typeof fetch,testCopy?:{responseId:string;ownerEmail:string}):ResearchTransport{
 return async message=>{
  if(!key||message.to!==responseRecipient||!/^bubblewash-research\/[a-f0-9-]{36}$/i.test(message.idempotencyKey))return {status:'not-accepted',retryable:false};
  try{
   const response=await send('https://api.resend.com/emails',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10_000),headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','Idempotency-Key':message.idempotencyKey},body:JSON.stringify({from:researchSender,to:[responseRecipient],...(testCopy&&message.idempotencyKey==='bubblewash-research/'+testCopy.responseId?{cc:[testCopy.ownerEmail]}:{}),subject:message.subject,text:message.text,html:message.html})});
   if(response.ok){const result=await response.json() as {id?:unknown};return typeof result.id==='string'&&result.id.length>0&&result.id.length<=200?{status:'accepted',messageId:result.id}:{status:'uncertain'};}
   if(response.status===429)return {status:'not-accepted',retryable:true};
   if(response.status>=500||response.status===408||response.status===409)return {status:'uncertain'};
   return {status:'not-accepted',retryable:false};
  }catch{return {status:'uncertain'};}
 };
}
export function createResearchTransport(key:string,send:typeof fetch=fetch):ResearchTransport{return transport(key,send);}
export async function dispatchResearchNotifications(){
 if(!researchEmailReady())return {enabled:false,sent:0,deferred:0,review:0};
 return processResearchNotifications(createResearchTransport(process.env.BUBBLEWASH_RESEARCH_RESEND_KEY!.trim()));
}

// Trusted operator-only action; NEVER import into a public route or normal dispatcher.
// Caller supplies the dedicated survey key and verified protected owner-email value.
// Only this fixed synthetic payload can be copied. A prior/uncertain attempt is never resent.
export async function sendSyntheticResearchTest(db:ReturnType<typeof getDatabase>,key:string,ownerEmail:string,send:typeof fetch=fetch){
 if(!key||!/^\S+@\S+\.\S+$/.test(ownerEmail)||/[\r\n,;]/.test(ownerEmail)||ownerEmail.length>254)throw new Error('Dedicated key and verified operator test recipient required.');
 const input={adultEligible:true as const,instrument:'consumer' as const,schemaVersion,submissionKey:'20b2f9aa-77dd-4c7a-8efe-b23f176c77f1',identity:{name:'TEST ONLY — SYNTHETIC SURVEY RESPONSE',organisation:'',email:'synthetic-test@example.invalid',phone:'0200000000'},consent:true as const,answers:{A1:'25 to 34',C3:'TEST ONLY. No real respondent information. Verifying durable save and the approved survey email path.'},reference:'operator-test-v1'};
 const token=randomUUID();
 const claimed=db.transaction(()=>{
  saveResponse(input,db);
  const row=db.prepare('SELECT r.id,o.state,o.attempts FROM research_responses r JOIN research_notification_outbox o ON o.response_id=r.id WHERE r.submission_key=?').get(input.submissionKey)as{id:string;state:string;attempts:number};
  if(row.attempts!==0||!['held','pending'].includes(row.state))return null;
  const result=db.prepare("UPDATE research_notification_outbox SET state='sending',attempts=1,lease_token=?,lease_until=? WHERE response_id=? AND attempts=0 AND state IN('held','pending')").run(token,new Date(Date.now()+120_000).toISOString(),row.id);
  return result.changes===1?row.id:null;
 })();
 if(!claimed)return {attempted:false,status:'already-attempted'};
 const message=renderEmail(input);
 const result=await transport(key,send,{responseId:claimed,ownerEmail})({...message,subject:'[TEST ONLY] '+message.subject,idempotencyKey:'bubblewash-research/'+claimed});
 const accepted=result.status==='accepted';
 const saved=db.prepare("UPDATE research_notification_outbox SET state=?,provider_message_id=?,sent_at=?,last_error_kind=?,lease_token=NULL,lease_until=NULL WHERE response_id=? AND lease_token=?").run(accepted?'sent':'failed',accepted?result.messageId:null,accepted?new Date().toISOString():null,accepted?null:'operator-test-review-required',claimed,token);
 return {attempted:true,status:saved.changes===1?(accepted?'accepted':'review-required'):'review-required'};
}
