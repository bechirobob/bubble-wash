import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
const {sessions,firstId,directory}=JSON.parse(readFileSync('/tmp/bubblewash-results-fixture-proof.json','utf8'));
const origin='http://localhost:3217';
const request=(path,role)=>fetch(origin+path,{redirect:'manual',headers:role?{cookie:`bubblewash_staff_session=${sessions[role]}`}:{}});
const db=new Database(directory+'/synthetic.sqlite');const before=db.prepare('SELECT * FROM research_notification_outbox ORDER BY response_id').all();
const schemaBefore=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
const checks=[];
for(const role of [null,'master','vendor','driver','support']){
 for(const path of ['/api/admin/research/results','/api/admin/research/responses',`/api/admin/research/responses/${firstId}`]){const response=await request(path,role);assert.equal(response.status,403,`${role} ${path}`);assert.match(response.headers.get('cache-control'),/private.*no-store/);assert.equal((await response.text()).includes('Demo'),false);}
 checks.push(`${role??'anonymous'} denied on aggregate, list and detail`);
}
const response=await request('/api/admin/research/results','owner');assert.equal(response.status,200);const data=await response.json();
assert.equal(data.totals.saved,84);assert.equal(data.totals.analysis,78);assert.equal(data.question.answered,73);assert.equal(data.question.blank,5);assert.equal(data.totals.repeated,2);assert.equal('responses' in data,false);assert.equal(JSON.stringify(data).includes('@example.invalid'),false);assert.equal(JSON.stringify(data).includes('Demo'),false);assert.equal(JSON.stringify(data).includes('Synthetic research response'),false);checks.push('owner aggregate: 84 saved / 78 core / 73 answered, no respondent PII or text');
const quota=await(await request('/api/admin/research/results?sample=quota','owner')).json();assert.equal(quota.totals.analysis,72);checks.push('quota sample excludes six outside Accra and six None/Other areas');
const all=await(await request('/api/admin/research/results?sample=all','owner')).json();assert.equal(all.totals.analysis,84);
const multi=await(await request('/api/admin/research/results?question=C1','owner')).json();assert.equal(multi.question.answered,78);assert.equal(multi.question.values[0].percent,100);checks.push('multi-select denominator remains responses, not number of selections');
const list=await(await request('/api/admin/research/responses?page=2','owner')).json();assert.equal(list.responses.length,12);assert.equal(list.pagination.page,2);assert.equal(JSON.stringify(list).includes('@example.invalid'),false);checks.push('owner paginated list contains names, no contacts or answer text');
const detail=await(await request(`/api/admin/research/responses/${firstId}`,'owner')).json();assert.match(detail.identity.email,/@example.invalid$/);assert.ok(detail.answers.length);checks.push('separate owner detail contains expected synthetic contacts and answers');
assert.equal((await request('/api/admin/research/results?instrument=bogus','owner')).status,400);assert.equal((await request('/api/admin/research/responses/not-a-uuid','owner')).status,404);checks.push('invalid filters and IDs rejected');
assert.deepEqual(db.prepare('SELECT * FROM research_notification_outbox ORDER BY response_id').all(),before);assert.equal(db.prepare('SELECT COUNT(*) n FROM research_responses').get().n,84);checks.push('all reads leave response and email-outbox rows unchanged');
assert.deepEqual(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),schemaBefore);checks.push('results reads leave the live-baseline database schema unchanged');
db.prepare("UPDATE staff_accounts SET status='suspended' WHERE email='owner@example.invalid'").run();
for(const path of ['/api/admin/research/results','/api/admin/research/responses',`/api/admin/research/responses/${firstId}`])assert.equal((await request(path,'owner')).status,403);
db.prepare("UPDATE staff_accounts SET status='active' WHERE email='owner@example.invalid'").run();db.close();checks.push('suspended owner session immediately loses all three read endpoints');
console.log(JSON.stringify({ok:true,syntheticOnly:true,checks},null,2));
