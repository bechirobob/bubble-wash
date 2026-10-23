import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { migrateNotificationOutbox } from '../src/lib/notification-outbox-schema.ts';
const source=readFileSync(new URL('../src/lib/data-store.ts',import.meta.url),'utf8');
const ddl=source.match(/function initializeDatabaseSchema\([^)]*\) \{\s*db\.exec\(`([\s\S]*?)`\);\s*\}/)[1];
for(const commit of [false,true])test(`nested outbox migration remains usable after caller ${commit?'commit':'rollback'}`,()=>{
 const db=new Database(':memory:');db.exec(ddl);
 try {
  const migrate=db.transaction(()=>{migrateNotificationOutbox(db);if(!commit)throw Error('caller rolled back');});
  if(commit)migrate();else assert.throws(migrate,/caller rolled back/);
  assert.equal(db.prepare('PRAGMA table_info(notification_outbox)').all().some(row=>row.name==='delivery_state'),commit);
  migrateNotificationOutbox(db);
  assert.deepEqual(db.prepare('SELECT delivery_state FROM notification_outbox').all(),[]);
  const schema=db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
  migrateNotificationOutbox(db);assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),schema);
 }finally{db.close();}
});
