import 'server-only';
import {createHash,randomUUID} from 'node:crypto';
import {getDatabase} from '../data-store.ts';
import {validate,type Submission} from './model.ts';
import {deliveryApproved,responseRecipient} from './policy.ts';
export function saveResponse(input:Submission,database?:ReturnType<typeof getDatabase>){
 const value=validate(input); // Reject minors/invalid fields before opening storage.
 const db=database??getDatabase();
 const payload=JSON.stringify({...value,answers:Object.fromEntries(Object.entries(value.answers).sort(([a],[b])=>a.localeCompare(b)))});
 const hash=createHash('sha256').update(payload).digest('hex');
 return db.transaction(()=>{
  const old=db.prepare('SELECT payload_hash FROM research_responses WHERE submission_key=?').get(value.submissionKey)as{payload_hash:string}|undefined;
  if(old){if(old.payload_hash!==hash)throw new Error('SUBMISSION_CONFLICT');return {duplicate:true};}
  const id=randomUUID();
  db.prepare('INSERT INTO research_responses(id,submission_key,payload_hash,instrument,schema_version,created_at,payload)VALUES(?,?,?,?,?,?,?)').run(id,value.submissionKey,hash,value.instrument,value.schemaVersion,new Date().toISOString(),payload);
  db.prepare("INSERT INTO research_notification_outbox(response_id,state,recipient)VALUES(?,?,?)").run(id,deliveryApproved?'pending':'held',responseRecipient);
  return {duplicate:false};
 })();
}

