// Cross-candidate synthetic rollback; every provider request is intercepted.
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const root=process.cwd();
const directory=mkdtempSync(path.join(tmpdir(),'bubblewash-fallback-worker-'));
Object.assign(process.env, {BUBBLEWASH_DATABASE_PATH:path.join(directory,'synthetic.sqlite'),NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED:'false',RESEND_API_KEY:'synthetic-not-a-real-credential',BUBBLEWASH_EMAIL_FROM:'Synthetic <test@example.invalid>'});
process.chdir(directory);
let calls=0;
globalThis.fetch=async (url, options)=>{
 assert.equal(url,'https://api.resend.com/emails');
 assert.match(options.headers['Idempotency-Key'],/^bubblewash\//);
 const body=JSON.parse(options.body); assert.deepEqual(body.to,['new@example.invalid']);
 calls++; return Response.json({id:'synthetic-accepted'});
};
const expanded=await import('../../bubblewash-web-5dc997-candidate/src/lib/data-store.ts');
const db=expanded.getDatabase();
const now=new Date().toISOString();
db.prepare('INSERT INTO notification_outbox (id,dedupe_key,channel,target,payload,status,attempts,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('legacy-uncertain','legacy-uncertain','email','customer',JSON.stringify({purpose:'privacy',toEmail:'old@example.invalid'}),'failed',1,now,now,now);
expanded.readNotification('legacy-uncertain');
expanded.enqueueNotification({id:'new-privacy',dedupeKey:'new-privacy',channel:'email',target:'customer',payload:{purpose:'privacy',toEmail:'new@example.invalid',subject:'Synthetic',text:'No real message'}});
db.prepare('INSERT INTO submissions VALUES (?,?,?,?)').run('new-order',now,'synthetic','{"status":"confirmed"}');
const old=db.prepare("SELECT rowid AS sqlite_rowid,* FROM notification_outbox WHERE id='legacy-uncertain'").get();
const orders=db.prepare('SELECT * FROM submissions').all();
db.close();
const fallback=await import('../src/lib/data-store.ts');
const notifications=await import('../src/lib/notifications.ts');
try {
 const results=await notifications.processNotificationOutbox(20);
 assert.equal(calls,1); assert.equal(results.length,1); assert.equal(results[0].accepted,true);
 assert.deepEqual(await notifications.processNotificationOutbox(20),[]); assert.equal(calls,1);
 assert.deepEqual(fallback.getDatabase().prepare("SELECT rowid AS sqlite_rowid,* FROM notification_outbox WHERE id='legacy-uncertain'").get(),old);
 assert.deepEqual(fallback.getDatabase().prepare('SELECT * FROM submissions').all(),orders);
 assert.equal(fallback.readNotification('new-privacy').deliveryState,'accepted');
 assert.equal(fallback.readNotification('new-privacy').providerId,'synthetic-accepted');
 console.log('PASS: expanded-candidate migration -> independent legacy-web fallback; quarantine byte-preserved, new order retained, only new eligible privacy row mock-accepted once.');
} finally {fallback.getDatabase().close();process.chdir(root);rmSync(directory,{recursive:true,force:true});}
