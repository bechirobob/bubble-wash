// Explicit two-source continuity test. Both sources and all data are local fixtures.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--fallback' || !path.isAbsolute(args[1])) throw new Error('Expected --fallback /absolute/path/to/reviewed/source');
const candidate = path.resolve(import.meta.dirname, '..');
const fallback = args[1];
const temporary = mkdtempSync(path.join(tmpdir(), 'bubblewash-label-rollback-'));
const file = path.join(temporary, 'synthetic.sqlite');
const environment = { ...process.env, BUBBLEWASH_DATABASE_PATH:file, BUBBLEWASH_SESSION_SECRET:'local-only-synthetic-session-secret-value', NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED:'false', RESEND_API_KEY:'', PAYSTACK_SECRET_KEY:'', NODE_NO_WARNINGS:'1' };
const fixture = `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getDatabase, enqueueNotification } from './src/lib/data-store.ts';
import { initializeStaffAccountsSchema } from './src/lib/staff-accounts.ts';
import { operationalDatabase, saveBookingOnce } from './src/lib/operational-store.ts';
import { upsertVendorAvailability } from './src/lib/availability-store.ts';
import { migrateBookingReferences } from './src/lib/booking-reference-schema.ts';
const db = operationalDatabase(); initializeStaffAccountsSchema(db);
const payload={submissionType:'pickup-booking',name:'Synthetic',email:'synthetic@example.invalid'};
if (process.env.FIXTURE_STEP==='initialize') {
  db.exec("CREATE TABLE staff_owner_capabilities (email TEXT PRIMARY KEY COLLATE NOCASE REFERENCES staff_accounts(email), all_staff_access INTEGER NOT NULL CHECK (all_staff_access = 1))");
  db.prepare("INSERT INTO staff_accounts VALUES ('owner@example.invalid','Owner','admin','','preserved-hash','preserved-version','active','','','time')").run();
  db.prepare("INSERT INTO staff_owner_capabilities VALUES ('owner@example.invalid',1)").run();
  db.prepare("INSERT INTO admin_mfa_settings VALUES ('owner@example.invalid','preserved-ciphertext','enrolled',NULL,NULL,'time','time')").run();
  db.prepare("INSERT INTO submissions VALUES ('legacy','time','synthetic',?)").run(JSON.stringify(payload));
  const hash=createHash('sha256').update(JSON.stringify(Object.entries(payload).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');
  db.prepare("INSERT INTO booking_requests VALUES ('legacy-request',?,'legacy','time')").run(hash);
  db.exec('DROP TABLE booking_references; DROP TABLE vendor_codes');
  migrateBookingReferences(db);
} else {
  const step=process.env.FIXTURE_STEP;
  const save=(id,key)=>saveBookingOnce({id,createdAt:'time',data:payload},key,record=>enqueueNotification({id:'N-'+record.id,dedupeKey:'D-'+record.id,channel:'email',target:'customer',payload:record.data}));
  const legacy=save('unused','legacy-request'); assert.equal(legacy.bookingReference,null);
  const first=save('candidate-one','candidate-request'); assert.equal(first.bookingReference,'BW-001');
  const current=save(step+'-new',step+'-request');
  const one=upsertVendorAvailability({vendorId:'stable-vendor',vendorName:step,capacityRemaining:1,availabilityStatus:'available',updatedBy:'synthetic'});
  const two=upsertVendorAvailability({vendorId:step+'-vendor',vendorName:step,capacityRemaining:1,availabilityStatus:'available',updatedBy:'synthetic'});
  console.log(JSON.stringify({reference:current.bookingReference,stableVendorCode:one.vendorCode,newVendorCode:two.vendorCode,legacyReference:legacy.bookingReference}));
}
db.close();`;
function run(source, step) {
  const result=spawnSync(process.execPath,['--conditions=react-server','--experimental-strip-types','--experimental-loader=./tests/alias-loader.mjs','--input-type=module','-e',fixture],{cwd:source,env:{...environment,FIXTURE_STEP:step},encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout):null;
}
function protectedState() {
  const db=new Database(file,{readonly:true});
  try { return ['staff_accounts','staff_owner_capabilities','admin_mfa_settings','admin_mfa_recovery_codes'].map(table=>[table,db.prepare(`SELECT * FROM ${table}`).all()]); } finally {db.close();}
}
try {
  run(candidate,'initialize');
  const before=protectedState();
  assert.deepEqual(run(candidate,'first'),{reference:'BW-002',stableVendorCode:'FIR',newVendorCode:'FIA',legacyReference:null});
  assert.deepEqual(run(fallback,'rollback'),{reference:'BW-003',stableVendorCode:'FIR',newVendorCode:'ROL',legacyReference:null});
  assert.deepEqual(run(candidate,'return'),{reference:'BW-004',stableVendorCode:'FIR',newVendorCode:'RET',legacyReference:null});
  assert.deepEqual(protectedState(),before);
  const db=new Database(file,{readonly:true});
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM booking_references').get().n,4);
    assert.equal(db.prepare('SELECT count(*) n FROM notification_outbox').get().n,4);
    assert.equal(db.prepare("SELECT count(*) n FROM notification_outbox WHERE json_extract(payload,'$.bookingReference') IS NULL").get().n,0);
    assert.equal(db.prepare("SELECT count(*) n FROM booking_references WHERE order_id='legacy'").get().n,0);
  } finally { db.close(); }
  console.log(JSON.stringify({ok:true,scope:'candidate-to-rollback-to-candidate',newBookings:4,stableVendorCodes:4,ownerMfaPreserved:true,historicalBackfill:false}));
} finally {rmSync(temporary,{recursive:true,force:true});}
