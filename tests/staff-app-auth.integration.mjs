import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPasswordHash } from '../src/lib/passwords.ts';
const dir=mkdtempSync(join(tmpdir(),'bubblewash-staff-app-auth-'));
Object.assign(process.env,{NODE_ENV:'production',BUBBLEWASH_DATABASE_PATH:join(dir,'synthetic.sqlite'),BUBBLEWASH_SESSION_SECRET:'synthetic-staff-app-host-test-secret-only',BUBBLEWASH_STAFF_AUTH_DISABLED:'false',BUBBLEWASH_DISABLE_DEMO_LOGIN:'true',BUBBLEWASH_ADMIN_MFA_REQUIRED:'false'});
const password='synthetic-staff-app-password-123';
process.env.BUBBLEWASH_ADMIN_EMAIL='admin@example.invalid';process.env.BUBBLEWASH_ADMIN_PASSWORD_HASH=createPasswordHash(password);
const {inviteStaffAccount,activateStaffAccount}=await import('../src/lib/staff-accounts.ts');
for(const role of ['vendor','driver','support']){
 const token=inviteStaffAccount({email:`${role}@example.invalid`,name:`Synthetic ${role}`,role,entityId:`synthetic-${role}`},'test');
 assert.equal(activateStaffAccount(token,password),true);
}
const {POST:login}=await import('../src/app/api/login/route.ts');
const {POST:logout}=await import('../src/app/api/logout/route.ts');
const host='staff.bubblewash.co';
const request=(path,body,origin=`https://${host}`)=>new Request(`https://${host}${path}`,{method:'POST',headers:{host,origin,'content-type':'application/json'},body:JSON.stringify(body)});
try {
 for(const [role,next] of [['admin','/admin'],['vendor','/vendors'],['driver','/drivers'],['support','/support']]){
  const response=await login(request('/api/login',{email:`${role}@example.invalid`,password,next:'/admin'}));
  assert.equal(response.status,200,role);const body=await response.json();assert.equal(body.user.role,role);assert.equal(body.next,next);
  const cookie=response.headers.get('set-cookie');assert.match(cookie,/HttpOnly/i);assert.match(cookie,/Secure/i);assert.match(cookie,/SameSite=Lax/i);assert.match(cookie,/Path=\//i);assert.doesNotMatch(cookie,/Domain=/i);
 }
 for(const origin of ['https://bubblewash.co','https://staff.bubblewash.co.evil.invalid','http://staff.bubblewash.co']){
  assert.equal((await login(request('/api/login',{email:'admin@example.invalid',password},origin))).status,403);
  assert.equal((await logout(request('/api/logout',{},origin))).status,403);
 }
 const signedOut=await logout(request('/api/logout',{}));assert.equal(signedOut.status,200);assert.doesNotMatch(signedOut.headers.get('set-cookie'),/Domain=/i);assert.match(signedOut.headers.get('set-cookie'),/bubblewash_staff_session=;/);
 console.log(JSON.stringify({ok:true,roles:4,crossOriginRejections:6,hostOnlyCookies:true,logout:true,syntheticOnly:true}));
} finally { const {getDatabase}=await import('../src/lib/data-store.ts');getDatabase().close();rmSync(dir,{recursive:true,force:true}); }
