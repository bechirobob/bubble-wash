import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createCipheriv } from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { seal, unseal, header, readKey, LIMIT } from '../ops/host-facts/crypto.mjs';
const context={runAttempt:'1',runId:'123',sourceSha:'a'.repeat(40)};
const meta={context,schema:'bubblewash-host-facts/v1',summary:{flags:['operator-exclusion-unresolved'],result:'captured',schema:'bubblewash-host-facts-summary/v1'}};
const raw=Buffer.from(JSON.stringify(meta)),key=randomBytes(32),plain=Buffer.from('{"inode":18446744073709551000,"private":"not-for-public"}');
test('authenticated purpose-separated roundtrip preserves original bytes',()=>{
  const first=seal(raw,plain,key),second=seal(raw,plain,key);
  assert.notDeepEqual(first,second);assert.ok(!first.includes(plain));
  assert.deepEqual(unseal(first,key,context).plain,plain);
  assert.throws(()=>unseal(first,randomBytes(32),context));
  assert.throws(()=>unseal(first,key,{...context,runId:'124'}));
});
test('every header nonce tag ciphertext change refuses',()=>{
  const encrypted=seal(raw,plain,key);
  for(const index of [0,8,12,12+raw.length,24+raw.length,40+raw.length]) {
    const bad=Buffer.from(encrypted);bad[index]^=1;assert.throws(()=>unseal(bad,key,context));
  }
  assert.throws(()=>unseal(encrypted.subarray(0,30),key,context));
});
test('backup master key cannot decrypt purpose-derived envelope',()=>{
  const encrypted=seal(raw,plain,key),at=12+raw.length;
  const cipher=createCipheriv('aes-256-gcm',key,encrypted.subarray(at,at+12));
  cipher.setAAD(encrypted.subarray(0,at));
  assert.notDeepEqual(Buffer.concat([cipher.update(plain),cipher.final()]),encrypted.subarray(at+28));
});
test('strict public header rejects injection duplicate fields unknown flags',()=>{
  for(const value of [{...meta,extra:'SECRET'},{...meta,summary:{...meta.summary,flags:['/private/SECRET']}},{...meta,context:{...context,sourceSha:'main'}}])assert.throws(()=>header(Buffer.from(JSON.stringify(value))));
  assert.throws(()=>header(Buffer.from(JSON.stringify(meta).replace('"schema":"bubblewash-host-facts/v1"','"schema":"wrong","schema":"bubblewash-host-facts/v1"'))));
});
test('bounds enforced before encryption and parsing',()=>{
  assert.throws(()=>seal(raw,Buffer.alloc(LIMIT+1),key));assert.throws(()=>header(Buffer.alloc(8193)));
  assert.throws(()=>seal(raw,Buffer.alloc(0),key));
});
test('key ancestry symlink permissions and size fail closed',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'facts-key-'));
  try{
    const file=path.join(dir,'key');writeFileSync(file,key.toString('base64'),{mode:0o600});
    // Make the synthetic ancestor unsafe explicitly; tmpdir may be private.
    chmodSync(dir,0o777);assert.throws(()=>readKey(file,process.getuid()));
    chmodSync(dir,0o700);
    chmodSync(file,0o644);assert.throws(()=>readKey(file,process.getuid()));
    symlinkSync(file,path.join(dir,'link'));assert.throws(()=>readKey(path.join(dir,'link'),process.getuid()));
    writeFileSync(file,'A'.repeat(1024));assert.throws(()=>readKey(file,process.getuid()));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

const ordered = x => Array.isArray(x) ? x.map(ordered) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k=>[k,ordered(x[k])])) : x;
const diagnostic = () => ({environment:Object.fromEntries(['accountValid','regularFile','ownerMatches','primaryGroupMatches','modePrivate','singleLink','canonicalPath','ancestorDirectories','ancestorOwners','ancestorModes','attributesAbsent'].map(k=>[k,null])),
  units:['maintenance-timer','maintenance-service','application-service'].map(unit=>({unit,stage:'command-failed',unitSources:['not-assessed'],executableSource:'not-assessed',propertyIssue:'not-assessed',missingProperties:[]})),
  php:{packages:[{name:'php8.3-fpm',version:'8.3.6-0ubuntu0.24.04.2'}],packagesComplete:true,servicesInspected:false,phpServicePresent:null,phpServiceActive:null,webServicePresent:null,listenersInspected:false,phpTcpListenerPresent:null,phpNonLoopbackListenerPresent:null}});
const diagnosticHeader = d => Buffer.from(JSON.stringify(ordered({...meta,summary:{...meta.summary,diagnostics:d}})));
test('diagnostic header roundtrips authenticated and altered observations fail',()=>{
  const d=diagnostic(),h=diagnosticHeader(d),sealed=seal(h,plain,key);
  assert.deepEqual(header(unseal(sealed,key,context).rawHeader).summary.diagnostics,d);
  const changed=Buffer.from(sealed),pos=changed.indexOf(Buffer.from('command-failed'));
  changed[pos]='X'.charCodeAt(0);assert.throws(()=>unseal(changed,key,context));
});
test('diagnostic strict privacy allowlist rejects paths identities counts and invalid packages',()=>{
  for(const mutate of [d=>d.environment.path='/secret',d=>d.environment.ownerMatches=1001,
    d=>d.units[0].stage='raw error',d=>d.units[0].unit='root',d=>d.units[0].unitSources=['/private'],
    d=>d.php.phpTcpListenerPresent=10,d=>d.php.packages[0].name='php8.3-secret',
    d=>d.php.packages[0].version='8.3/secret',d=>d.php.packages[0].version='8.3\n',d=>d.php.packages[0].name='php8.3-fpm\n',d=>d.php.packages[0].version='8.3\nsecret',
    d=>d.php.packages=Array(25).fill(d.php.packages[0])]) {
    const d=diagnostic();mutate(d);assert.throws(()=>header(diagnosticHeader(d)));
  }
});
