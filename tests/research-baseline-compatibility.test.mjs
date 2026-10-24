import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('survey tables preserve the owner-baseline schema and existing records',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'survey-baseline-'));
 process.env.BUBBLEWASH_DATABASE_PATH=path.join(dir,'synthetic.sqlite');
 const {getDatabase}=await import('../src/lib/data-store.ts');
 const db=getDatabase();
 try{
  db.prepare('INSERT INTO submissions(id,created_at,source,data) VALUES(?,?,?,?)').run('synthetic-preserved','2026-10-23T00:00:00Z','synthetic-test',JSON.stringify({submissionType:'pickup-booking',name:'Synthetic only'}));
  const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const rows=db.prepare('SELECT * FROM submissions').all();
  db.exec(readFileSync(new URL('../db/proposed/research-v1.sql',import.meta.url),'utf8'));
  assert.deepEqual(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND tbl_name NOT IN ('research_responses','research_notification_outbox') ORDER BY type,name").all(),schema);
  assert.deepEqual(db.prepare('SELECT * FROM submissions').all(),rows);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('research_responses','research_notification_outbox')").get().n,2);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='booking_references'").get().n,0);
  assert.equal(db.prepare('PRAGMA table_info(notification_outbox)').all().some(row=>row.name==='lease_token'),false);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
  assert.equal(getDatabase(),db);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

// Survey-only deployment must not inherit tinted or absent tokens from the older home page.
test('survey and intro define neutral tokens and inherit the shared accessible focus policy',()=>{
 for(const [name,scope] of [['research/research.module.css','.shell'],['BubbleWashOpening.module.css','.opening']]){
  const css=readFileSync(new URL('../src/components/'+name,import.meta.url),'utf8');
  assert.ok(css.startsWith(scope+' { --line:#dedede; --line-strong:#858585; --line-active:#333333; --focus-ring:#222222; }'));
  assert.match(css,/:focus-visible/);
  const shared=readFileSync(new URL('../src/app/globals.css',import.meta.url),'utf8');
  assert.match(shared,/:focus-visible[^{}]*\{[^}]*outline: 3px solid var\(--focus-ring\)/);
 }
});
