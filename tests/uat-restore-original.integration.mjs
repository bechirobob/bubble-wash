import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync, renameSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'uat-restore-test-'));
Object.assign(process.env, { NODE_ENV:'production', BUBBLEWASH_UAT_ENABLED:'true', BUBBLEWASH_UAT_ISOLATION_CONFIRMED:'true', BUBBLEWASH_PUBLIC_URL:'https://uat.example.invalid', BUBBLEWASH_DATABASE_PATH:join(directory,'uat.sqlite'), BUBBLEWASH_UAT_DATA_ROOT:directory, NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED:'false', NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED:'false', BUBBLEWASH_RESEARCH_EMAIL_ENABLED:'false', BUBBLEWASH_DISABLE_DEMO_LOGIN:'true', BUBBLEWASH_SESSION_SECRET:'synthetic-session-secret-only-for-test-123' });
const { initializeUatAccountsSchema, issueUatCohort, createUatTeamAccount, revokeUatAccount, currentUatUsers } = await import('../src/lib/uat-accounts.ts');
const { inspectOriginalUat, restoreOriginalUat, restorationReceipt, databaseIdentityGuard } = await import('../scripts/uat-restore-original.mjs');
const { encodeSession, decodeSession } = await import('../src/lib/auth.ts');
const { verifyPasswordHash } = await import('../src/lib/passwords.ts');
const realNow = Date.now;
let now = Date.parse('2026-10-26T23:19:33.802Z');
Date.now = () => now;
const db = new Database(':memory:');
const accounts = ['admin','vendor','driver','support'].map(role => ({ username:'test-'+role, name:'Synthetic '+role, role, entityId:['vendor','driver'].includes(role)?'synthetic-'+role:undefined, password:'synthetic-restoration-test-password-'+role }));
const dump = table => db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all();
try {
  const file = join(directory,'identity.sqlite');
  const original = new Database(file);original.close();
  const fileInfo = statSync(file,{bigint:true});
  const guard = databaseIdentityGuard(file,{device:String(fileInfo.dev),inode:String(fileInfo.ino)});
  guard();
  let connection = new Database(file);guard(true);connection.close();
  copyFileSync(file,file+'.clone');renameSync(file,file+'.original');renameSync(file+'.clone',file);
  connection = new Database(file);
  renameSync(file,file+'.replacement');renameSync(file+'.original',file);
  guard();
  assert.throws(()=>guard(true),'SQLite descriptor replacement detected even when path identity was restored');
  connection.close();
  initializeUatAccountsSchema(db);
  db.exec("CREATE TABLE vendor_availability(vendor_id TEXT); INSERT INTO vendor_availability VALUES ('synthetic-vendor'); CREATE TABLE driver_availability(driver_id TEXT); INSERT INTO driver_availability VALUES ('synthetic-driver'); CREATE TABLE test_records(id TEXT, value TEXT); INSERT INTO test_records VALUES ('preserve','existing test work');");
  issueUatCohort(accounts,'approved-uat-issuance',db);
  const actor = {email:'test-admin',role:'admin',temporaryAccess:true};
  createUatTeamAccount({username:'child-revoked',name:'Child',role:'support',password:'synthetic-child-password-only'},actor,db);
  createUatTeamAccount({username:'child-expired',name:'Child',role:'support',password:'synthetic-child-password-only'},actor,db);
  revokeUatAccount('child-revoked','test',db);
  assert.throws(()=>inspectOriginalUat(db),'active cohort cannot be extended');
  const originalRows = dump('staff_uat_accounts');
  const oldSessions = currentUatUsers(db).map(user => encodeSession(user));
  now += 604800000;
  currentUatUsers(db);
  const before = dump('staff_uat_accounts');
  const audit = dump('staff_uat_audit');
  const records = dump('test_records');
  const inspection = inspectOriginalUat(db);
  const operationId = '6cd01672-7084-4e80-9dbb-2172dc78707b';
  const request = { fingerprint:inspection.fingerprint, inspectedAt:inspection.inspectedAt, operationId, accounts:accounts.map(({username,password,role})=>({username,password,role})) };
  assert.equal(restorationReceipt(db,operationId).state,'not-observed');
  assert.throws(()=>restoreOriginalUat(db,{...request,inspectedAt:now-300001}),'stale preflight rejected');
  assert.throws(()=>restoreOriginalUat(db,{...request,fingerprint:'0'.repeat(64)}));
  assert.throws(()=>restoreOriginalUat(db,{...request,accounts:[...accounts.slice(0,3),accounts[0]]}));
  assert.throws(()=>restoreOriginalUat(db,{...request,accounts:[...accounts.slice(0,3),{...accounts[3],username:'child-revoked'}]}));
  db.exec("CREATE TRIGGER fail_restore BEFORE UPDATE ON staff_uat_accounts WHEN NEW.username='test-support' BEGIN SELECT RAISE(ABORT,'synthetic refusal'); END;");
  assert.throws(()=>restoreOriginalUat(db,request));
  assert.deepEqual(dump('staff_uat_accounts'),before,'mid-transaction failure rolls back all roles');
  assert.deepEqual(dump('staff_uat_audit'),audit,'failed transaction adds no audit');
  db.exec('DROP TRIGGER fail_restore');
  db.exec('SAVEPOINT foreign_key_check');
  db.exec("CREATE UNIQUE INDEX unexpected_version ON staff_uat_accounts(credential_version); CREATE TABLE unrelated_fk(value TEXT REFERENCES staff_uat_accounts(credential_version) ON UPDATE CASCADE); INSERT INTO unrelated_fk SELECT credential_version FROM staff_uat_accounts WHERE username='test-admin';");
  const unrelated = dump('unrelated_fk');
  assert.throws(()=>restoreOriginalUat(db,request),'unreviewed index/cascade refused');
  assert.deepEqual(dump('unrelated_fk'),unrelated);
  db.exec('ROLLBACK TO foreign_key_check; RELEASE foreign_key_check');
  const originalPrepare = db.prepare;
  let inserts = 0;
  db.prepare = function(sql) {
    const statement = originalPrepare.call(this,sql);
    if (sql.startsWith('INSERT INTO staff_uat_audit')) return {run(...args) {
      if (++inserts === 3) throw new Error('Synthetic failure after first account changed');
      return statement.run(...args);
    }};
    return statement;
  };
  try { assert.throws(()=>restoreOriginalUat(db,request),'failure partway through update rolls back'); }
  finally { db.prepare = originalPrepare; }
  assert.deepEqual(dump('staff_uat_accounts'),before);
  assert.deepEqual(dump('staff_uat_audit'),audit);

  db.exec('SAVEPOINT revoked_check');
  revokeUatAccount('test-support','synthetic-concurrent-revocation',db);
  assert.equal(restorationReceipt(db,operationId).state,'uncertain-stop');
  assert.throws(()=>restoreOriginalUat(db,request),'concurrent revocation invalidates inspection');
  assert.throws(()=>inspectOriginalUat(db),'revoked original never eligible');
  db.exec('ROLLBACK TO revoked_check; RELEASE revoked_check');
  db.exec('SAVEPOINT roster_check');
  db.exec('DELETE FROM vendor_availability');
  assert.throws(()=>restoreOriginalUat(db,request),'missing roster aborts restoration');
  assert.deepEqual(dump('staff_uat_accounts'),before);
  db.exec('ROLLBACK TO roster_check; RELEASE roster_check');
  db.exec('SAVEPOINT partial_receipt');
  db.prepare('INSERT INTO staff_uat_audit VALUES (?,?,?,?,?,?,?)').run('synthetic-orphan','test-admin','restored-original-before','approved-uat-restoration:6cd01672-7084-4e80-9dbb-2172dc78707c',now,now,now+604800000);
  assert.equal(restorationReceipt(db,operationId).state,'uncertain-stop');
  db.exec('ROLLBACK TO partial_receipt; RELEASE partial_receipt');
  const receipt = restoreOriginalUat(db,request);
  assert.equal(receipt.expiresAt-receipt.startsAt,604800000);
  assert.equal(receipt.startsAt,now);
  const restoredUsers = currentUatUsers(db);
  assert.equal(restoredUsers.length,4);
  for (const session of oldSessions) assert.equal(decodeSession(session,restoredUsers,db),null,'old sessions do not revive');
  for (const user of restoredUsers) {
    const session = encodeSession(user);
    assert.equal(decodeSession(session,restoredUsers,db).role,user.role,'fresh session authorizes exact role');
    const staleVersionUsers = restoredUsers.map(u => ({...u,credentialVersion:originalRows.find(a=>a.username===u.username).credential_version}));
    assert.equal(decodeSession(session,staleVersionUsers,db),null,'credential version mismatch rejected independently of deadline');
  }
  for (const row of dump('staff_uat_accounts')) {
    const old = originalRows.find(a=>a.username===row.username);
    if (row.username.startsWith('child-')) assert.deepEqual(row,before.find(a=>a.username===row.username));
    else {
      for(const key of ['username','name','role','entity_id','created_at']) assert.equal(row[key],old[key]);
      assert.notEqual(row.credential_version,old.credential_version);
      assert.ok(verifyPasswordHash(accounts.find(a=>a.username===row.username).password,row.password_hash));
    }
  }
  assert.deepEqual(dump('test_records'),records);
  assert.deepEqual(dump('staff_uat_audit').slice(0,audit.length),audit);
  assert.equal(dump('staff_uat_audit').length,audit.length+9);
  assert.equal(receipt.state,'committed');
  assert.deepEqual(restorationReceipt(db,operationId),{...receipt,readOnly:true},'lost transport acknowledgement recovered without another write');
  assert.equal(restorationReceipt(db,'6cd01672-7084-4e80-9dbb-2172dc78707c').state,'different-operation');
  db.exec('SAVEPOINT receipt_drift');
  db.prepare("UPDATE staff_uat_accounts SET role='support' WHERE username='test-driver'").run();
  assert.equal(restorationReceipt(db,operationId).state,'committed-state-changed');
  db.exec('ROLLBACK TO receipt_drift; RELEASE receipt_drift');
  assert.throws(()=>restoreOriginalUat(db,request),'replay refused');
  now += 604800000;
  assert.equal(currentUatUsers(db).length,0,'exact fresh deadline enforced');
  assert.equal(restorationReceipt(db,operationId).state,'committed-state-changed');
  assert.throws(()=>inspectOriginalUat(db),'second restoration refused');
  console.log('UAT restoration: fixed window, exact four targets, preservation, rollback, revoked exclusion and replay guards passed');
} finally { Date.now=realNow; db.close(); rmSync(directory,{recursive:true,force:true}); }
