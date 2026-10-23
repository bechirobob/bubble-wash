// Synthetic loopback HTTP proof only; production browser acceptance remains separate.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
for(const open of [false,true]){
 const child=spawn(process.execPath,['--conditions=react-server','--experimental-strip-types','--experimental-loader=./tests/alias-loader.mjs','tests/browser/start-fixture.mjs'],{cwd:process.cwd(),env:{PATH:process.env.PATH,HOME:process.env.HOME,BUBBLEWASH_TEST_RESEARCH_OPEN:String(open)},stdio:'ignore'});
 const endpoint='http://localhost:3100/api/research/responses';
 const post=(body,origin='http://localhost:3100')=>fetch(endpoint,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','x-forwarded-for':'2001:db8::9876'},body:typeof body==='string'?body:JSON.stringify(body)});
 try{
  let ready=false;for(let i=0;i<150;i++){try{if((await fetch('http://localhost:3100/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  const landing=await fetch('http://localhost:3100/survey');assert.equal(landing.status,200);assert.match(await landing.text(),open?/Questionnaires/:/not accepting responses/);
  if(!open){for(const body of ['{}','not-json','x'.repeat(70000)])assert.equal((await post(body)).status,503);continue;}
  for(const id of ['consumer','consumer-interview','business-interview','vendor-interview']){const r=await fetch('http://localhost:3100/survey/'+id);assert.equal(r.status,200);assert.match(await r.text(),/18/);}
  assert.equal((await post('{}','https://outside.example.invalid')).status,403);
  assert.equal((await post('x'.repeat(70000))).status,413);
  assert.equal((await post({adultEligible:false})).status,400);
  const payload={adultEligible:true,instrument:'consumer',schemaVersion:'bubblewash-research-3',submissionKey:randomUUID(),identity:{name:'SYNTHETIC ONLY',organisation:'',email:'synthetic@example.invalid',phone:'0200000000'},consent:true,answers:{'icp-student':'No','icp-business':'No','icp-corporate':'No','icp-household':'No',A1:'25 to 34'},reference:'local-baseline-http'};
  assert.equal((await post(payload)).status,200);
  for(let i=0;i<4;i++){const r=await post(payload);assert.equal(r.status,200);assert.equal((await r.json()).duplicate,true);}
  assert.equal((await post(payload)).status,429);
 }finally{child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
}
console.log(JSON.stringify({ok:true,scope:'Baseline production build; closed/open synthetic survey HTTP, all four forms, origin/size/minor/idempotency/rate guards; external egress blocked; no live email'}));
