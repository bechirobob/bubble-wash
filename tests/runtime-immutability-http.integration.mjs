import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync, mkdtempSync, rmSync, mkdirSync, symlinkSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
const source=resolve(import.meta.dirname,'..'),temporary=mkdtempSync(join(tmpdir(),'bw-immutable-http-'));
function inventory() {
 const files={};
 const walk=(directory,relative='')=>{for(const name of readdirSync(directory).sort()) {
  const key=relative?relative+'/'+name:name;if(key==='cache')continue;
  const file=join(directory,name);if(statSync(file).isDirectory())walk(file,key);else files[key]=createHash('sha256').update(readFileSync(file)).digest('hex');
 }};walk(join(source,'.next'));return files;
}
assert.equal(JSON.parse(readFileSync(join(source,'.next/required-server-files.json'),'utf8')).config.experimental.isrFlushToDisk,false,'Built config must capture immutable cache policy');
const before=inventory();
const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const runtime=join(temporary,'runtime');mkdirSync(runtime);
for(const name of ['.next','node_modules','public','src'])symlinkSync(join(source,name),join(runtime,name),'dir');
for(const name of ['next.config.mjs','package.json'])copyFileSync(join(source,name),join(runtime,name));
const deny=join(temporary,'deny-network.mjs');writeFileSync(deny,"globalThis.fetch=async()=>{throw Error('External fetch prohibited in synthetic immutable-release test')};\n");
const env={PATH:process.env.PATH,HOME:temporary,NODE_ENV:'production',NODE_NO_WARNINGS:'1',NEXT_TELEMETRY_DISABLED:'1',BUBBLEWASH_DATABASE_PATH:join(temporary,'synthetic.sqlite'),BUBBLEWASH_SESSION_SECRET:'synthetic-immutable-runtime-session-secret-only',BUBBLEWASH_DISABLE_DEMO_LOGIN:'true',BUBBLEWASH_STAFF_AUTH_DISABLED:'false',BUBBLEWASH_BOOKINGS_DISABLED:'true',NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED:'false',NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED:'false',RESEND_API_KEY:'',PAYSTACK_SECRET_KEY:''};
const launch=()=>spawn(process.execPath,['--import',deny,join(source,'node_modules/next/dist/bin/next'),'start',runtime,'-H','127.0.0.1','-p',String(port)],{cwd:runtime,env,stdio:['ignore','pipe','pipe']});
let child=launch(),output='';
function capture(){child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);}
capture();
async function stop(){child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));}
try {
 const origin=`http://127.0.0.1:${port}`;
 let checks=0;
 for(let epoch=0;epoch<2;epoch++){
 for(let attempt=0;attempt<80;attempt++) {
  if(child.exitCode!==null)throw Error(output);
  try{if((await fetch(origin+'/api/health')).ok)break;}catch{}
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 for(let round=0;round<3;round++)for(const [path,status] of [['/',200],['/staff/activate',200],['/__immutable-release-missing',404],['/api/mobile/v1/staff/login',404]]) {
  const response=await fetch(origin+path);await response.arrayBuffer();assert.equal(response.status,status,path);checks++;
 }
 assert.deepEqual(inventory(),before,'Normal requests must not add or mutate any pinned build file outside .next/cache');
 if(epoch===0){await stop();child=launch();capture();}
 }
 console.log(JSON.stringify({checks,restartVerified:true,immutableBuildFiles:Object.keys(before).length,strictBuildManifestUnchanged:true,externalCalls:0}));
}finally {
 await stop();rmSync(temporary,{recursive:true,force:true});
}
