import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { allocateVendorCode, vendorCodeForId, preferredVendorCode, formatVendorCode } from '../src/lib/vendor-codes.ts';
import { createBookingReferenceSchema, bookingReferenceSchemaState } from '../src/lib/booking-reference-schema.ts';
function fixture(action) {const db=new Database(':memory:');createBookingReferenceSchema(db);try {action(db,(id,name)=>db.transaction(()=>allocateVendorCode(db,id,name)).immediate());} finally {db.close();}}

test('vendor preferred code uses normalized first three ASCII letters and neutral short/non-Latin fallback',()=>{
  for(const [name,expected] of [['Élite Laundry','ELI'],['A & B Clothing','ABC'],['  Bubble wash ','BUB'],['Q','VND'],['AB','VND'],['12345','VND'],['中文洗衣','VND'],['','VND']]) assert.equal(preferredVendorCode(name),expected);
});

test('name collisions use deterministic suffixes, then later prefixes without overwriting',()=>fixture((db,save)=>{
  const codes=[];for(let i=0;i<27;i++)codes.push(save(`vendor-${i}`,'Abc Laundry'));
  assert.deepEqual(codes.slice(0,4),['ABC','ABA','ABB','ABD']);
  assert.equal(codes[25],'ABZ');assert.equal(codes[26],'ACA');assert.equal(new Set(codes).size,27);
  assert.equal(save('vendor-0','Renamed elsewhere'),'ABC');assert.equal(vendorCodeForId(db,'vendor-0'),'ABC');
  assert.equal(bookingReferenceSchemaState(db),'ready');
}));

test('collision search wraps full namespace; neutral fallback is deterministic and unique',()=>fixture((db,save)=>{
  const codes=[];for(let i=0;i<27;i++)codes.push(save(`last-${i}`,'Zzz Laundry'));
  assert.equal(codes[0],'ZZZ');assert.equal(codes[1],'ZZA');assert.equal(codes[26],'AAA');
  assert.equal(save('short-a','A'),'VND');assert.equal(save('short-b','中文'),'VNA');
  assert.equal(save('short-a','Actual Name Later'),'VND');
}));

test('name-derived code is independent of high-water sequence and existing assignments remain fixed',()=>fixture((db,save)=>{
  db.prepare('INSERT INTO vendor_codes(sequence,vendor_id,code) VALUES (1,?,?)').run('preexisting','QRS');
  assert.equal(bookingReferenceSchemaState(db),'ready');
  assert.equal(save('preexisting','New Name'),'QRS');assert.equal(save('new','Alpha Laundry'),'ALP');
  assert.equal(db.prepare("SELECT sequence FROM vendor_codes WHERE vendor_id='new'").get().sequence,2);
  assert.throws(()=>allocateVendorCode(db,'outside','Test'),/transaction/);
  assert.throws(()=>db.transaction(()=>{allocateVendorCode(db,'failed','Test');throw new Error('rollback');}).immediate());
  assert.equal(save('after-failure','Test'),'TES');
}));

test('exhaustive search finds final unused name code then fails closed with no reuse or partial write',()=>fixture((db,save)=>{
  const insert=db.prepare('INSERT INTO vendor_codes(sequence,vendor_id,code) VALUES (?,?,?)');
  db.transaction(()=>{for(let n=1;n<17576;n++)insert.run(n,`reserved-${n}`,formatVendorCode(n));}).immediate();
  assert.equal(save('last','Abc Laundry'),'ZZZ');
  const before=db.serialize();assert.throws(()=>save('overflow','Something'),/exhausted/);assert.deepEqual(db.serialize(),before);
  assert.equal(bookingReferenceSchemaState(db),'ready');
}));
