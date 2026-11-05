// Synthetic local handlers only. No production credentials, accounts or network calls.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NextRequest } from 'next/server';
import { createPasswordHash } from '../src/lib/passwords.ts';
import { totpCode } from '../src/lib/totp.ts';
const required=process.argv.includes('--global-off')?'false':'true';
const dir=mkdtempSync(join(tmpdir(),'bw-abigail-mfa-'));
for(const key of Object.keys(process.env))if(key.startsWith('BUBBLEWASH_')||key.startsWith('NEXT_PUBLIC_BUBBLEWASH_'))delete process.env[key];
const legacy='JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
Object.assign(process.env,{NODE_ENV:'production',BUBBLEWASH_DATABASE_PATH:join(dir,'synthetic.sqlite'),BUBBLEWASH_DISABLE_DEMO_LOGIN:'true',BUBBLEWASH_STAFF_AUTH_DISABLED:'false',BUBBLEWASH_ADMIN_MFA_REQUIRED:required,NEXT_PUBLIC_BUBBLEWASH_ADMIN_MFA_REQUIRED:required,BUBBLEWASH_TRUST_PROXY_HEADERS:'true',BUBBLEWASH_ADMIN_EMAIL:'master@example.invalid',BUBBLEWASH_ADMIN_PASSWORD_HASH:createPasswordHash('synthetic-master-password-123'),BUBBLEWASH_ADMIN_TOTP_SECRET:legacy,BUBBLEWASH_MFA_ENCRYPTION_KEY:Buffer.alloc(32,23).toString('base64'),BUBBLEWASH_SESSION_SECRET:'synthetic-isolation-session-key-123456'});
let network=0;globalThis.fetch=async()=>{network++;throw Error('External request prohibited by fixture');};
const {getDatabase}=await import('../src/lib/data-store.ts');
const {initializeStaffAccountsSchema}=await import('../src/lib/staff-accounts.ts');
const mfa=await import('../src/lib/admin-mfa.ts');
const auth=await import('../src/lib/auth.ts');
const {POST:login}=await import('../src/app/api/login/route.ts');
const {POST:enroll}=await import('../src/app/api/admin/mfa/enroll/route.ts');
const db=getDatabase();let id=1;
const email='abigail@bubblewash.co',password='synthetic-abigail-password-123';
const request=(path,body)=>new NextRequest('https://bubblewash.co'+path,{method:'POST',headers:{host:'bubblewash.co',origin:'https://bubblewash.co','content-type':'application/json','x-forwarded-for':`192.0.2.${id++}`},body:JSON.stringify(body)});
const signIn=(address,pass,totp)=>login(request('/api/login',{email:address,password:pass,...(totp?{totp}:{})}));
try{
 initializeStaffAccountsSchema(db);
 for(const address of [email,'unrelated@example.invalid'])db.prepare("INSERT INTO staff_accounts VALUES (?, 'Synthetic administrator', 'admin', '', ?, ?, 'active', '', '', ?)").run(address,createPasswordHash(password),address+'-version',new Date().toISOString());
 const unrelatedBefore=db.prepare('SELECT * FROM staff_accounts WHERE email != ?').all(email);
 assert.equal(mfa.adminTotpSecret(email),'');assert.equal(mfa.adminMfaEnrollmentExists(email),false);
 assert.equal(mfa.adminTotpSecret('unrelated@example.invalid'),legacy);assert.equal(mfa.adminTotpSecret('master@example.invalid'),legacy);
 assert.equal(mfa.verifyAdminMfaCredential(email,totpCode(legacy)),false);
 assert.equal((await signIn(email,password)).status,required==='true'?503:200);
 assert.equal((await signIn(email,password,totpCode(legacy))).status,required==='true'?503:200);
 assert.equal((await signIn('unrelated@example.invalid',password)).status,required==='true'?401:200);
 assert.equal((await signIn('unrelated@example.invalid',password,totpCode(legacy))).status,200);
 assert.equal((await signIn('master@example.invalid','synthetic-master-password-123',totpCode(legacy))).status,200);
 const started=await enroll(request('/api/admin/mfa/enroll',{action:'start',email,password}));assert.equal(started.status,200);
 const {enrollment}=await started.json();const step=Math.floor(Date.now()/30000);
 assert.notEqual(enrollment.manualKey,legacy);
 const confirmation=await enroll(request('/api/admin/mfa/enroll',{action:'confirm',email,password,code:totpCode(enrollment.manualKey,step)}));assert.equal(confirmation.status,200);
 const {recoveryCodes}=await confirmation.json();const cookie=confirmation.cookies.get(auth.sessionCookieName)?.value;assert.equal(auth.decodeSession(cookie).allStaffAccess,false);
 const personalCodes=[-1,0,1].map(offset=>totpCode(enrollment.manualKey,step+offset));
 const masterOnly=[-1,0,1].map(offset=>totpCode(legacy,step+offset)).find(code=>!personalCodes.includes(code));assert.ok(masterOnly);
 assert.equal(mfa.verifyAdminMfaCredential(email,masterOnly),false);
 assert.equal((await signIn(email,password,masterOnly)).status,required==='true'?401:200);
 assert.equal((await signIn(email,password)).status,required==='true'?401:200);
 assert.equal((await signIn(email,password,totpCode(enrollment.manualKey,step+1))).status,200);
 if(required==='true'){
  assert.equal((await signIn(email,password,recoveryCodes[0])).status,200);
  assert.equal((await signIn(email,password,recoveryCodes[0])).status,401);
 }else{
  assert.equal(mfa.verifyAdminMfaCredential(email,recoveryCodes[0]),true);
  assert.equal(mfa.verifyAdminMfaCredential(email,recoveryCodes[0]),false);
 }
 assert.equal(mfa.adminTotpSecret(email),enrollment.manualKey);
 assert.equal(mfa.adminTotpSecret('unrelated@example.invalid'),legacy);assert.equal(mfa.adminTotpSecret('master@example.invalid'),legacy);
 assert.deepEqual(db.prepare('SELECT * FROM staff_accounts WHERE email != ?').all(email),unrelatedBefore);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM admin_mfa_settings WHERE admin_email != ?').get(email).n,0);
 assert.equal(process.env.BUBBLEWASH_ADMIN_TOTP_SECRET,legacy);assert.equal(process.env.BUBBLEWASH_ADMIN_MFA_REQUIRED,required);assert.equal(network,0);
 console.log(JSON.stringify({ok:true,globalMfa:required,scope:'Abigail rejects shared authenticator; own enrollment/TOTP/recovery; normal global policy unchanged; master/unrelated identities unchanged; zero external requests'}));
}finally{db.close();rmSync(dir,{recursive:true,force:true});}
