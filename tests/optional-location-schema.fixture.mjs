import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const directory=mkdtempSync(join(tmpdir(),'bubblewash-optional-schema-'));
const cwd=process.cwd();
for(const key of Object.keys(process.env))if(/^(BUBBLEWASH_|NEXT_PUBLIC_BUBBLEWASH_|RESEND_|WHATSAPP_|PAYSTACK_)/.test(key))delete process.env[key];
Object.assign(process.env,{NODE_ENV:'production',BUBBLEWASH_DATABASE_DRIVER:'sqlite',BUBBLEWASH_DATABASE_PATH:join(directory,'synthetic.sqlite'),BUBBLEWASH_DISABLE_DEMO_LOGIN:'true',BUBBLEWASH_SESSION_SECRET:'synthetic-only-schema-test-secret-over-32-characters'});
process.chdir(directory);
globalThis.fetch=async()=>{throw new Error('No network permitted');};
const store=await import('../src/lib/data-store.ts');
const {inspectFreshReset}=await import('../scripts/reset-fresh-start.mjs');
try {
 const db=store.getDatabase();
 const exists=()=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='driver_location_stops'").get());
 assert.equal(exists(),false);
 assert.equal(store.readDriverLocationStop('synthetic-driver'),null);assert.equal(exists(),false);
 const cutoff=new Date().toISOString();
 if(process.argv[2]==='share')assert.equal(store.upsertDriverLiveLocation({driverId:'synthetic-driver',orderId:'synthetic-order',latitude:5.6,longitude:-0.1,accuracyMeters:10,capturedAt:cutoff,receivedAt:cutoff}),true);
 else store.stopDriverLiveLocation('synthetic-driver',cutoff);
 assert.equal(exists(),true);
 const before=db.prepare('SELECT * FROM driver_live_locations').all();
 assert.throws(()=>inspectFreshReset(db,process.env,directory),/unreviewed table/);
 assert.deepEqual(db.prepare('SELECT * FROM driver_live_locations').all(),before);
 store.stopDriverLiveLocation('synthetic-driver',cutoff);
 assert.equal(store.readDriverLocationStop('synthetic-driver'),cutoff);
 assert.equal(store.upsertDriverLiveLocation({driverId:'synthetic-driver',orderId:'synthetic-order',latitude:5.6,longitude:-0.1,accuracyMeters:10,capturedAt:cutoff,receivedAt:cutoff}),false);
 console.log(`PASS optional location schema: first ${process.argv[2]}, startup/read unchanged, activated reset refused, late share blocked`);
}finally{process.chdir(cwd);rmSync(directory,{recursive:true,force:true});}
