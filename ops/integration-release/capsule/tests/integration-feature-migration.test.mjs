// Local synthetic DBs only. Explicit source supplies already-reviewed modules.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { featureSchemaModel, inspectFeatureSchema, migrateFeatureSchema, preflightFeatureSchema, verifyFeatureSchema } from '../scripts/migrate-integration-features.mjs';
const source=process.env.BUBBLEWASH_TEST_REVIEWED_SOURCE;
assert.ok(source && path.isAbsolute(source),'Explicit reviewed local candidate source required');
const model=await featureSchemaModel(source), Database=model.Database;
const directory=mkdtempSync(path.join(tmpdir(),'bw-features-'));
after(()=>rmSync(directory,{recursive:true,force:true}));
const features=['driver_location_stops','operational_work_ownership','operational_command_receipts','vendor_capacity_confirmations','mobile_operations_receipts'];
const optional='mobile_customer_requests';
let serial=0;
function executeSchema(db,name,schema=model.expected.get(name)){
 const objects=JSON.parse(schema);
 for(const type of ['table','index'])for(const row of objects)if(row.type===type && row.sql && row.name!=='sqlite_sequence')db.exec(row.sql);
}
function fixture({complete=false,legacy=false,allInherited=false,customer=false}={}){
 const file=path.join(directory,`fixture-${serial++}.sqlite`),db=new Database(file);
 for(const name of model.required)executeSchema(db,name);
 if(allInherited)for(const name of model.expected.keys())if(!model.required.has(name)&&!features.includes(name)&&name!==optional)executeSchema(db,name);
 if(complete)for(const name of features)executeSchema(db,name,name==='operational_work_ownership'&&legacy?model.oldSchema:undefined);
 else if(legacy)executeSchema(db,'operational_work_ownership',model.oldSchema);
 if(customer)executeSchema(db,optional);
 db.pragma('user_version=17');db.pragma('application_id=1234');
 db.prepare('INSERT INTO submissions(rowid,id,created_at,source,data) VALUES (?,?,?,?,?)').run(410,'old-booking','time','fixture','{"submissionType":"pickup-booking"}');
 db.prepare("INSERT INTO staff_accounts VALUES ('owner@example.invalid','Owner','admin','','owner-hash','owner-version','active','','','time'),('invited@example.invalid','Invited','admin','','','invite-version','invited','preserved-token-hash','2099-01-02T00:00:00.000Z','time')").run();
 db.prepare("INSERT INTO staff_owner_capabilities VALUES ('owner@example.invalid',1),('invited@example.invalid',1)").run();
 db.prepare("INSERT INTO admin_mfa_settings VALUES ('owner@example.invalid','preserved-mfa','enrolled',NULL,NULL,'time','time')").run();
 db.prepare("INSERT INTO research_responses VALUES ('response','key','hash','consumer','version','time','{}')").run();
 db.prepare("INSERT INTO research_notification_outbox(response_id,state,attempts,provider_message_id) VALUES ('response','sent',1,'preserved-provider')").run();
 db.prepare("INSERT INTO driver_live_locations VALUES ('expired','old-booking',5.6,-0.1,10,'2000-01-01','2000-01-01')").run();
 db.prepare("INSERT INTO rate_limits VALUES ('expired',12,0)").run();
 if(customer)db.prepare("INSERT INTO mobile_customer_requests VALUES ('old-booking','request','payload','{\"receipt\":true}')").run();
 if(legacy)db.prepare("INSERT INTO operational_work_ownership(rowid,item_id,owner_email,due_at,note,revision,updated_at) VALUES (777,'item','owner@example.invalid','date','preserved',4,'time')").run();
 return {file,db};
}
function snapshot(db){
 const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
 const rows=Object.fromEntries(schema.filter(r=>r.type==='table').map(r=>[r.name,db.prepare('SELECT rowid,* FROM "'+r.name+'" ORDER BY rowid').safeIntegers(true).raw(true).all()]));
 return {schema,rows,user:db.pragma('user_version',{simple:true}),app:db.pragma('application_id',{simple:true})};
}
function unchangedOld(before,after,ownershipUpgrade=false){
 assert.equal(after.user,before.user);assert.equal(after.app,before.app);
 for(const [name,rows] of Object.entries(before.rows))assert.deepEqual(ownershipUpgrade&&name==='operational_work_ownership'?after.rows[name].map(r=>r.slice(0,-1)):after.rows[name],rows,name);
 for(const row of before.schema)if(!(ownershipUpgrade&&row.name==='operational_work_ownership'))assert.ok(after.schema.some(x=>JSON.stringify(x)===JSON.stringify(row)),row.name);
}
function run(file,mode=false){return spawnSync(process.execPath,['--conditions=react-server','--experimental-strip-types',path.resolve(import.meta.dirname,'../scripts/migrate-integration-features.mjs'),...(mode?[mode===true?'--preflight':mode]:[]),'--database',file,'--source',source],{env:{PATH:process.env.PATH,NODE_NO_WARNINGS:'1',BUBBLEWASH_DATABASE_PATH:path.join(directory,'never-created.sqlite')},encoding:'utf8',timeout:15000});}

test('five exact tables only; all existing rows/rowids/metadata preserved; repeat is no-op',()=>{
 const {db}=fixture({allInherited:true});try{const before=snapshot(db);assert.deepEqual(migrateFeatureSchema(db,model),{createdTables:5,ownershipColumnAdded:false,locationColumnsAdded:false,optionalCustomerTableCreated:false});const after=snapshot(db);unchangedOld(before,after);assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(optional),undefined);for(const name of features)assert.equal(db.prepare('SELECT count(*) n FROM '+name).get().n,0);assert.equal(inspectFeatureSchema(db,model,true).size,model.expected.size-1);assert.deepEqual(migrateFeatureSchema(db,model),{createdTables:0,ownershipColumnAdded:false,locationColumnsAdded:false,optionalCustomerTableCreated:false});assert.deepEqual(snapshot(db),after);}finally{db.close();}
});
test('existing exact optional customer receipts are preserved, never created or rewritten',()=>{
 const {db}=fixture({complete:true,customer:true});try{const before=snapshot(db);migrateFeatureSchema(db,model);assert.deepEqual(snapshot(db),before);}finally{db.close();}
});
test('only exact historical six-column ownership gains empty default without replacing rows',()=>{
 const {db}=fixture({legacy:true,customer:true});try{const before=snapshot(db);assert.deepEqual(migrateFeatureSchema(db,model),{createdTables:4,ownershipColumnAdded:true,locationColumnsAdded:false,optionalCustomerTableCreated:false});const after=snapshot(db);unchangedOld(before,after,true);assert.equal(db.prepare('SELECT rowid,order_id FROM operational_work_ownership').get().rowid,777);assert.equal(db.prepare('SELECT order_id FROM operational_work_ownership').get().order_id,'');migrateFeatureSchema(db,model);assert.deepEqual(snapshot(db),after);}finally{db.close();}
});
for(const [name,sql] of [
 ['missing research', 'DROP TABLE research_notification_outbox; DROP TABLE research_responses'],
 ['missing owner capability','DROP TABLE staff_owner_capabilities'],
 ['unknown table','CREATE TABLE unexpected(id TEXT)'],
 ['unknown index','CREATE INDEX unexpected_index ON submissions(source)'],
 ['unknown trigger','CREATE TRIGGER unexpected_trigger AFTER INSERT ON submissions BEGIN DELETE FROM rate_limits; END'],
 ['unknown view','CREATE VIEW unexpected_view AS SELECT id FROM submissions'],
 ['partial feature columns','CREATE TABLE driver_location_stops(driver_id TEXT PRIMARY KEY)'],
 ['foreign feature constraint','CREATE TABLE driver_location_stops(driver_id TEXT PRIMARY KEY, captured_before TEXT)'],
 ['foreign optional schema','CREATE TABLE mobile_customer_requests(order_id TEXT PRIMARY KEY)'],
 ['arbitrary missing ownership column','CREATE TABLE operational_work_ownership(item_id TEXT PRIMARY KEY,owner_email TEXT,note TEXT,revision INTEGER,updated_at TEXT)'],
 ['core missing index','DROP INDEX idx_driver_live_locations_captured_at'],
 ['unfinished outbox','ALTER TABLE notification_outbox RENAME COLUMN lease_token TO altered_token'],
 ]) test(name+' refuses before any persistent mutation',()=>{const {db}=fixture();try{db.exec(sql);const before=snapshot(db);assert.throws(()=>migrateFeatureSchema(db,model));assert.deepEqual(snapshot(db),before);}finally{db.close();}});
test('failure after first DDL rolls back all new tables and preserves old rows',()=>{
 const {db}=fixture();try{const before=snapshot(db);const original=db.exec;let calls=0;db.exec=function(sql){if(++calls===2)throw Error('Synthetic second DDL failure');return original.call(this,sql);};assert.throws(()=>migrateFeatureSchema(db,model));db.exec=original;assert.equal(calls,2);assert.deepEqual(snapshot(db),before);}finally{db.close();}
});
test('source-binding failure at precommit rolls the entire additive transaction back',()=>{
 const {db}=fixture();try{const before=snapshot(db);let checks=0;assert.throws(()=>migrateFeatureSchema(db,{...model,unchanged(){if(++checks===2)throw Error('Synthetic source drift');}}));assert.equal(checks,2);assert.deepEqual(snapshot(db),before);}finally{db.close();}
});
test('post-DDL unrelated row mutation is detected and transaction rolled back',()=>{
 const {db}=fixture();try{const before=snapshot(db),original=db.exec;let changed=false;db.exec=function(sql){const result=original.call(this,sql);if(!changed){changed=true;this.prepare("UPDATE staff_accounts SET token_hash='must-rollback' WHERE status='invited'").run();}return result;};assert.throws(()=>migrateFeatureSchema(db,model));db.exec=original;assert.deepEqual(snapshot(db),before);}finally{db.close();}
});
test('all existing feature rows including large rowids and blobs remain exact',()=>{
 const {db}=fixture({complete:true,customer:true});try{
 db.prepare('INSERT INTO operational_command_receipts(rowid,scope,request_key,payload_hash,response,created_at) VALUES (?,?,?,?,?,?)').run(9007199254740992n,'scope','key','hash',Buffer.from([0,255,7]),'time');
 db.prepare("INSERT INTO operational_work_ownership VALUES ('item','owner@example.invalid','due','note',3,'time','old-booking')").run();
 db.prepare("INSERT INTO vendor_capacity_confirmations VALUES ('vendor','time','actor')").run();
 db.prepare("INSERT INTO mobile_operations_receipts VALUES ('scope','request','hash','{}','time')").run();
 db.prepare("INSERT INTO driver_location_stops VALUES ('driver','time','89a2112d-3c1d-48d1-a9d2-baaeddd532b9','old-booking')").run();
 const before=snapshot(db);migrateFeatureSchema(db,model);assert.deepEqual(snapshot(db),before);
 }finally{db.close();}
});
test('CLI uses explicit existing DB, no env initializer, fixed redacted result',()=>{
 const {file,db}=fixture();try{const before=snapshot(db);const result=run(file);assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{ok:true,status:'exact-post-feature-ready',migration:'exact-integration-features-v1',createdTables:5,ownershipColumnAdded:false,locationColumnsAdded:false,optionalCustomerTableCreated:false});unchangedOld(before,snapshot(db));assert.equal(existsSync(path.join(directory,'never-created.sqlite')),false);const after=snapshot(db);assert.equal(run(file).status,0);assert.deepEqual(snapshot(db),after);}finally{db.close();}
});
test('CLI missing DB refuses without file creation or private-path output',()=>{
 const file=path.join(directory,'missing.sqlite'),result=run(file);assert.equal(result.status,1);assert.equal(existsSync(file),false);assert.equal(result.stdout,'');assert.deepEqual(JSON.parse(result.stderr),{ok:false,status:'feature-schema-refused',automaticRetry:false});
});
test('feature schema matches actual candidate-created tables, not a duplicate schema fixture',()=>{
 const file=path.join(directory,'actual-candidate.sqlite');
 const code=`import {getDatabase,appendSubmissionRecord,startDriverLiveLocation,upsertDriverLiveLocation} from './src/lib/data-store.ts';import {automationDatabase} from './src/lib/automation-store.ts';import {createCustomerRequest} from './src/lib/customer-requests.ts';import {vendorCapacityCommand} from './src/lib/vendor-capacity-command.ts';const db=getDatabase();globalThis.fetch=async()=>{throw Error('Network forbidden')};automationDatabase();const generation=startDriverLiveLocation('synthetic','synthetic-booking');upsertDriverLiveLocation({driverId:'synthetic',orderId:'synthetic-booking',latitude:5.6,longitude:-0.1,accuracyMeters:10,capturedAt:new Date().toISOString(),receivedAt:new Date().toISOString()},generation);appendSubmissionRecord({id:'synthetic-booking',createdAt:new Date().toISOString(),data:{submissionType:'pickup-booking',name:'Synthetic'}});createCustomerRequest('synthetic-booking',{action:'quality',note:'Synthetic metadata fixture'},'synthetic-request-key');await vendorCapacityCommand(new Request('https://fixture.invalid/',{method:'POST'}),{email:'vendor@example.invalid',name:'Synthetic',role:'vendor',entityId:'nonexistent'}, {capacityRemaining:1,availabilityStatus:'available',idempotencyKey:'synthetic-command-key'});const names=${JSON.stringify([...features,optional])};console.log(JSON.stringify(Object.fromEntries(names.map(name=>[name,db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name=? ORDER BY type,name').all(name)]))));db.close();`;
 const result=spawnSync(process.execPath,['--conditions=react-server','--experimental-strip-types','--experimental-loader=./tests/alias-loader.mjs','--input-type=module','-e',code],{cwd:source,env:{PATH:process.env.PATH,NODE_NO_WARNINGS:'1',BUBBLEWASH_DATABASE_PATH:file},encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr);const metadata=JSON.parse(result.stdout);for(const name of [...features,optional])assert.deepEqual(JSON.parse(model.expected.get(name)),metadata[name]);
});

function legacyFixture(){
 const file=path.join(directory,`legacy-${serial++}.sqlite`),db=new Database(file);
 for(const name of model.preRequired)executeSchema(db,name,model.preExpected.get(name));
 db.prepare("INSERT INTO staff_accounts VALUES ('owner@example.invalid','Owner','admin','','hash','version','active','','','time')").run();db.prepare("INSERT INTO staff_owner_capabilities VALUES ('owner@example.invalid',1)").run();
 return {file,db};
}
test('read-only preflight admits exact legacy outbox and absent labels without writes',()=>{
 const {file,db}=legacyFixture();try{const before=snapshot(db);assert.deepEqual(preflightFeatureSchema(db,model),{ok:true,status:'exact-pre-migration-ready',databaseChanged:false});const result=run(file,true);assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{ok:true,status:'exact-pre-migration-ready',databaseChanged:false});assert.deepEqual(snapshot(db),before);}finally{db.close();}
});
for(const [name,sql] of [['unknown table','CREATE TABLE foreign_table(id TEXT)'],['trigger',"CREATE TRIGGER bad AFTER INSERT ON staff_accounts BEGIN DELETE FROM submissions; END"],['partial labels',"CREATE TABLE booking_references(sequence INTEGER)"],['missing research','DROP TABLE research_notification_outbox; DROP TABLE research_responses'],['missing owner','DROP TABLE staff_owner_capabilities'],['partial outbox',"ALTER TABLE notification_outbox ADD COLUMN delivery_state TEXT"]])test('preflight '+name+' stops both legacy CLI invocations and mutation',()=>{
 const {file,db}=legacyFixture();try{db.exec(sql);const before=snapshot(db);let legacyCalls=0;const preflight=run(file,true);if(preflight.status===0){legacyCalls++;throw Error('Must not invoke either legacy CLI');}assert.equal(preflight.status,1);assert.equal(legacyCalls,0);assert.deepEqual(snapshot(db),before);}finally{db.close();}
});
test('preflight rejects already-migrated outbox/maps rather than silently treating recovery as initial deployment',()=>{
 const {file,db}=fixture();try{const before=snapshot(db);assert.throws(()=>preflightFeatureSchema(db,model));assert.equal(run(file,true).status,1);assert.deepEqual(snapshot(db),before);}finally{db.close();}
});
test('read-only preflight admits exact known optional and old ownership state without upgrading',()=>{
 const {file,db}=legacyFixture();try{executeSchema(db,'operational_work_ownership',model.oldSchema);executeSchema(db,optional);db.prepare("INSERT INTO operational_work_ownership VALUES ('item','owner@example.invalid','due','note',2,'time')").run();const before=snapshot(db);assert.equal(run(file,true).status,0);assert.deepEqual(snapshot(db),before);}finally{db.close();}
});

test('readonly verify reports complete feature admission without schema/data/file changes',()=>{
 const {file,db}=fixture({complete:true,customer:true});try{const before=snapshot(db),bytes=readFileSync(file);assert.deepEqual(verifyFeatureSchema(db,model),{ok:true,status:'exact-post-feature-ready',databaseChanged:false});const result=run(file,'--verify');assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{ok:true,status:'exact-post-feature-ready',databaseChanged:false});assert.deepEqual(snapshot(db),before);assert.deepEqual(readFileSync(file),bytes);}finally{db.close();}
});
for(const [name,mutate] of [['missing feature',db=>db.exec('DROP TABLE driver_location_stops')],['wrong feature',db=>db.exec('ALTER TABLE operational_work_ownership ADD COLUMN unexpected TEXT')],['trigger',db=>db.exec('CREATE TRIGGER unexpected AFTER INSERT ON submissions BEGIN DELETE FROM rate_limits; END')]])test('readonly verify refuses '+name+' without completing or mutating anything',()=>{
 const {file,db}=fixture({complete:true});try{mutate(db);const before=snapshot(db),bytes=readFileSync(file);assert.equal(run(file,'--verify').status,1);assert.deepEqual(snapshot(db),before);assert.deepEqual(readFileSync(file),bytes);}finally{db.close();}
});
test('readonly verify refuses initial legacy state and never invokes any migration',()=>{
 const {file,db}=legacyFixture();try{const before=snapshot(db);assert.equal(run(file,'--verify').status,1);assert.deepEqual(snapshot(db),before);}finally{db.close();}
});

test('exact legacy location stop state gains two inactive defaults preserving old rowids/values',()=>{
 const {db}=fixture();try {
  executeSchema(db,'driver_location_stops',model.oldLocationSchema);
  db.prepare("INSERT INTO driver_location_stops(rowid,driver_id,captured_before) VALUES (719,'driver','2099-01-01')").run();
  const before=snapshot(db), result=migrateFeatureSchema(db,model), after=snapshot(db);
  assert.equal(result.locationColumnsAdded,true);assert.equal(result.createdTables,4);
  assert.deepEqual(after.rows.driver_location_stops.map(row=>row.slice(0,-2)),before.rows.driver_location_stops);
  assert.deepEqual(db.prepare('SELECT generation,order_id FROM driver_location_stops').get(),{generation:'',order_id:''});
  for(const name of Object.keys(before.rows))if(name!=='driver_location_stops')assert.deepEqual(after.rows[name],before.rows[name]);
  assert.equal(verifyFeatureSchema(db,model).ok,true);assert.equal(migrateFeatureSchema(db,model).locationColumnsAdded,false);assert.deepEqual(snapshot(db),after);
 }finally{db.close();}
});
test('legacy stop state is admitted readonly before migration but cannot pass complete verification',()=>{
 const {file,db}=legacyFixture();try{executeSchema(db,'driver_location_stops',model.oldLocationSchema);db.prepare("INSERT INTO driver_location_stops VALUES ('driver','time')").run();const before=snapshot(db);assert.equal(run(file,true).status,0);assert.equal(run(file,'--verify').status,1);assert.deepEqual(snapshot(db),before);}finally{db.close();}
});
test('partial generation upgrade is not an admitted legacy variant',()=>{
 const {db}=fixture();try{executeSchema(db,'driver_location_stops',model.oldLocationSchema);db.exec("ALTER TABLE driver_location_stops ADD COLUMN generation TEXT NOT NULL DEFAULT ''");const before=snapshot(db);assert.throws(()=>migrateFeatureSchema(db,model));assert.deepEqual(snapshot(db),before);}finally{db.close();}
});
test('failure between the two location ALTERs rolls back both and every new feature table',()=>{
 const {db}=fixture();try{executeSchema(db,'driver_location_stops',model.oldLocationSchema);db.prepare("INSERT INTO driver_location_stops VALUES ('driver','time')").run();const before=snapshot(db),original=db.exec;db.exec=function(sql){if(sql.startsWith('ALTER TABLE driver_location_stops ADD COLUMN order_id'))throw Error('Synthetic second ALTER failure');return original.call(this,sql);};assert.throws(()=>migrateFeatureSchema(db,model));db.exec=original;assert.deepEqual(snapshot(db),before);}finally{db.close();}
});
