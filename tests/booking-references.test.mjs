import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { bookingReferenceSchema, allocateBookingReference, formatBookingReference, parseBookingReference, internalOrderForBookingReference } from '../src/lib/booking-references.ts';

function connection(path = ':memory:') {
  const db = new DatabaseSync(path); db.exec('PRAGMA busy_timeout=10000');
  return { db, adapter: { prepare: db.prepare.bind(db), get inTransaction() { return db.isTransaction; } } };
}
function allocate(db, adapter, id) { db.exec('BEGIN IMMEDIATE'); try { const value = allocateBookingReference(adapter,id); db.exec('COMMIT'); return value; } catch(e) { db.exec('ROLLBACK'); throw e; } }
test('three digits grow naturally without reset or wrapping', () => {
  assert.equal(formatBookingReference(1),'BW-001'); assert.equal(formatBookingReference(999),'BW-999');
  assert.equal(formatBookingReference(1000),'BW-1000'); assert.equal(formatBookingReference(10000),'BW-10000');
  for(const n of [0,-1,1.2,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>formatBookingReference(n));
});
test('canonical parsing rejects aliases, malformed and unsafe values', () => {
  assert.equal(parseBookingReference(' bw-001 '),1); assert.equal(parseBookingReference('BW-1000'),1000);
  for(const ref of ['BW-000','BW-1','BW-0001','BW-ABC-001','BW-1e3','BW-9007199254740992']) assert.equal(parseBookingReference(ref),null);
});
test('allocation requires transaction and explicit installed schema', () => {
  const {db,adapter}=connection(); assert.throws(()=>allocateBookingReference(adapter,'hidden-id'));
  assert.throws(()=>allocate(db,adapter,'hidden-id')); db.close();
});
test('idempotent retries return same reference without consuming sequence', () => {
  const {db,adapter}=connection(); db.exec(bookingReferenceSchema);
  assert.equal(allocate(db,adapter,'internal-a'),'BW-001');
  assert.equal(allocate(db,adapter,'internal-a'),'BW-001');
  assert.equal(allocate(db,adapter,'internal-b'),'BW-002');
  assert.equal(internalOrderForBookingReference(adapter,'BW-002'),'internal-b');
  assert.equal(internalOrderForBookingReference(adapter,'BW-999'),null); db.close();
});
test('failed booking rolls back allocation; committed deleted numbers are not reused', () => {
  const {db,adapter}=connection(); db.exec(bookingReferenceSchema);
  db.exec('BEGIN IMMEDIATE'); assert.equal(allocateBookingReference(adapter,'failed'),'BW-001'); db.exec('ROLLBACK');
  assert.equal(allocate(db,adapter,'first'),'BW-001');
  db.prepare('DELETE FROM booking_references WHERE order_id=?').run('first');
  assert.equal(allocate(db,adapter,'second'),'BW-002'); db.close();
});
test('durable sequence crosses 999 and survives reopening', () => {
  const dir=mkdtempSync(join(tmpdir(),'bw-reference-')); const path=join(dir,'fixture.sqlite');
  try { let {db,adapter}=connection(path);db.exec(bookingReferenceSchema);
    db.prepare('INSERT INTO booking_references (sequence,order_id) VALUES (?,?)').run(998,'seed');
    assert.equal(allocate(db,adapter,'a'),'BW-999'); db.close();
    ({db,adapter}=connection(path)); assert.equal(allocate(db,adapter,'b'),'BW-1000'); db.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('independent writers allocate unique references and converge on a retried booking', async () => {
  const dir=mkdtempSync(join(tmpdir(),'bw-reference-parallel-'));const path=join(dir,'fixture.sqlite');
  try {const {db}=connection(path);db.exec(bookingReferenceSchema);db.close();
    const moduleUrl=new URL('../src/lib/booking-references.ts',import.meta.url).href;
    const code=`import {DatabaseSync} from 'node:sqlite'; import {allocateBookingReference} from ${JSON.stringify(moduleUrl)};
      const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=10000');
      const adapter={prepare:db.prepare.bind(db),get inTransaction(){return db.isTransaction}};
      for(let i=0;i<15;i++){db.exec('BEGIN IMMEDIATE');allocateBookingReference(adapter,process.argv[2]+'-'+i);allocateBookingReference(adapter,'shared');db.exec('COMMIT');}db.close();`;
    await Promise.all(Array.from({length:4},(_,i)=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',code,path,String(i)],{stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',d=>error+=d);child.on('error',reject);child.on('exit',n=>n===0?resolve():reject(new Error(error)));})));
    const {db:verify}=connection(path);const row=verify.prepare('SELECT count(*) n,count(DISTINCT sequence) unique_n,max(sequence) last_n FROM booking_references').get();
    assert.equal(row.n,61);assert.equal(row.unique_n,61);assert.equal(row.last_n,61);verify.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
