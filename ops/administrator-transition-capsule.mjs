// Operator-only capsule. Not live application source and never installed there.
import { constants, openSync, closeSync, fstatSync, readSync, readFileSync, writeSync, fsyncSync, existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createHash, randomBytes, createCipheriv, createDecipheriv, createPublicKey, privateDecrypt, publicEncrypt, constants as cryptoConstants } from 'node:crypto';

export const OPERATION = 'expired-owner-to-administrator';
export const PURPOSE = 'bubblewash-administrator-transition/v1';
export const CAPABILITY_DDL = 'CREATE TABLE IF NOT EXISTS staff_owner_capabilities (email TEXT PRIMARY KEY COLLATE NOCASE REFERENCES staff_accounts(email), all_staff_access INTEGER NOT NULL CHECK (all_staff_access = 1))';
const requireValue = value => { if (!value) throw Error('Administrator transition refused.'); };
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value==='object' ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])) : value;
const canonical = value => JSON.stringify(ordered(value));
const hash = value => createHash('sha256').update(value).digest('hex');
export function contextValid(value) {
  requireValue(value && Object.keys(value).sort().join(',') === 'controlSha,operation,runAttempt,runId,runtimeSha');
  requireValue(value.operation === OPERATION);
  requireValue(['controlSha','runtimeSha'].every(k => /^[a-f0-9]{40}$/.test(value[k])) && /^[1-9][0-9]{0,19}$/.test(value.runId) && value.runAttempt === '1');
}
function keyInfo(pem) {
  requireValue(typeof pem === 'string' && pem.length <= 4096 && pem.startsWith('-----BEGIN PUBLIC KEY-----'));
  const key = createPublicKey(pem);
  requireValue(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength === 3072 && key.asymmetricKeyDetails.publicExponent === 65537n);
  return {key, keySha256: hash(key.export({format:'der',type:'spki'}))};
}
export function seal(plain, publicKey, context) {
  contextValid(context); const {key, keySha256} = keyInfo(publicKey);
  const header = {schema:PURPOSE,context,keySha256}; const aad = Buffer.from(canonical(header));
  const secret = randomBytes(32), iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', secret, iv); cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(Buffer.from(canonical(plain))),cipher.final()]);
    const wrappedKey = publicEncrypt({key,padding:cryptoConstants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},secret);
    return Buffer.from(canonical({...header,wrappedKey:wrappedKey.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')}));
  } finally { secret.fill(0); }
}
export function unseal(raw, privateKey, expected) {
  requireValue(Buffer.isBuffer(raw) && raw.length <= 16384);
  const value = JSON.parse(raw.toString('utf8'));requireValue(canonical(value)===raw.toString('utf8'));
  requireValue(Object.keys(value).sort().join(',') === 'ciphertext,context,iv,keySha256,schema,tag,wrappedKey');
  contextValid(value.context); contextValid(expected.context);
  requireValue(value.schema === PURPOSE && canonical(value.context) === canonical(expected.context) && value.keySha256 === expected.keySha256);
  const decoded = name => { const bytes = Buffer.from(value[name],'base64'); requireValue(bytes.toString('base64') === value[name]); return bytes; };
  const iv=decoded('iv'),tag=decoded('tag'),wrapped=decoded('wrappedKey'),encrypted=decoded('ciphertext');
  requireValue(iv.length===12 && tag.length===16 && wrapped.length===384 && encrypted.length>0 && encrypted.length<8192);
  requireValue(hash(createPublicKey(privateKey).export({format:'der',type:'spki'})) === expected.keySha256);
  const secret=privateDecrypt({key:privateKey,padding:cryptoConstants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},wrapped);
  try {
    requireValue(secret.length===32); const decipher=createDecipheriv('aes-256-gcm',secret,iv);
    decipher.setAAD(Buffer.from(canonical({schema:PURPOSE,context:value.context,keySha256:value.keySha256})));decipher.setAuthTag(tag);
    const plain=JSON.parse(Buffer.concat([decipher.update(encrypted),decipher.final()]).toString('utf8'));
    requireValue(Object.keys(plain).sort().join(',')==='activationUrl,allStaffAccess,context,createdAt,email,expiresAt,mfaPolicy,name,operationalWorkspaceAccess,role,surveyResultsAccess,ttlHours');
    requireValue(expected.email==='abigail@bubblewash.co' && expected.name==='Abigail Kabirou');
    requireValue(canonical(plain.context)===canonical(expected.context) && plain.email===expected.email && plain.name===expected.name && plain.role==='admin' && plain.allStaffAccess===false && plain.operationalWorkspaceAccess===true && plain.surveyResultsAccess===true && plain.mfaPolicy==='normal-admin-personal-seed-only' && plain.ttlHours===24);
    const created=Date.parse(plain.createdAt),expires=Date.parse(plain.expiresAt),now=Date.now();
    requireValue(Number.isFinite(created) && expires-created===86400000 && created<=now+300000 && expires>now);
    requireValue(/^https:\/\/bubblewash\.co\/staff\/activate#[A-Za-z0-9_-]{43}$/.test(plain.activationUrl));
    return plain;
  } finally { secret.fill(0); }
}
export async function runtime(release) {
  const load=createRequire(pathToFileURL(path.join(release,'package.json')));
  const Database=load('better-sqlite3');
  const staff=await import(pathToFileURL(path.join(release,'src/lib/staff-accounts.ts')).href);
  const data=await import(pathToFileURL(path.join(release,'src/lib/data-store.ts')).href);
  const transition=await import(pathToFileURL(path.join(release,'ops/administrator-invitation-transition.ts')).href);
  return {...transition,Database,assertOwnerEmailAvailable:staff.assertOwnerEmailAvailable,initializeStaffAccountsSchema:staff.initializeStaffAccountsSchema,databaseReadiness:data.databaseReadiness};
}
export function inspectInvitation(database, email, name, deps, env) {
  requireValue(email==='abigail@bubblewash.co' && name==='Abigail Kabirou');
  const fingerprint=deps.administratorTransitionFingerprint(database);
  let eligible=false;
  try { deps.assertAdministratorTransitionState(database,env); eligible=true; } catch { /* No mutation; bounded negative result. */ }
  return {eligible,fingerprint,state:eligible?'invited':'unknown',role:eligible?'admin':'unknown',allStaffAccess:eligible};
}
function validateRenewal(request) {
  contextValid(request.context);
  requireValue(request.operation===OPERATION && request.email==='abigail@bubblewash.co' && request.name==='Abigail Kabirou');
  requireValue(typeof request.email==='string' && request.email===request.email.trim().toLowerCase() && request.email.length<=160 && /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(request.email));
  requireValue(typeof request.name==='string' && request.name.trim()===request.name && request.name.length>0 && request.name.length<=100 && !/[\r\n\0]/.test(request.name));
  requireValue(/^github-actions:[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/.test(request.actor));
  requireValue(path.isAbsolute(request.dbPath) && path.isAbsolute(request.release) && !existsSync(path.join(request.release,'data/submissions.jsonl')));
  requireValue(request.env.BUBBLEWASH_UAT_ENABLED !== 'true');
  requireValue(/^[a-f0-9]{64}$/.test(request.expectedAfterSchemaSha256));
  requireValue(request.env.NODE_ENV==='production' && request.env.BUBBLEWASH_DISABLE_DEMO_LOGIN==='true' && request.env.BUBBLEWASH_STAFF_AUTH_DISABLED==='false');
}
function verifySchema(db, request, deps) {
  const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').raw().all();
  requireValue(hash(canonical(schema))===request.schemaSha256 && !schema.some(row=>row[0]==='trigger'||row[0]==='view'));
  requireValue(schema.some(row=>row[0]==='table'&&row[1]==='staff_owner_capabilities'));
  requireValue(deps.databaseReadiness(db,[deps.initializeStaffAccountsSchema,reference=>reference.exec(CAPABILITY_DDL)]));
}
export function checkInvitation(request, deps) {
  validateRenewal(request);
  const db=new deps.Database(request.dbPath,{fileMustExist:true,readonly:true});
  try {
    db.pragma('foreign_keys = ON');db.pragma('trusted_schema = OFF');db.pragma('busy_timeout = 5000');db.pragma('query_only = ON');
    return db.transaction(()=>{verifySchema(db,request,deps);return inspectInvitation(db,request.email,request.name,deps,request.env);})();
  } finally {db.close();}
}
export function transitionInvitation(request, deps, beforeCommit, encrypt=seal) {
  validateRenewal(request);keyInfo(request.publicKey);
  requireValue(request.mode==='transition-document' && /^[a-f0-9]{64}$/.test(request.statusFingerprint));
  const db=new deps.Database(request.dbPath,{fileMustExist:true});
  try {
    db.pragma('foreign_keys = ON');db.pragma('trusted_schema = OFF');db.pragma('busy_timeout = 5000');
    let encrypted;
    // Outer immediate transaction binds schema verification to the nested shared transition.
    db.transaction(()=>{
      verifySchema(db,request,deps);
      const createdAt=new Date().toISOString();
      deps.prepareAdministratorInvitation(db,{expectedFingerprint:request.statusFingerprint,actor:request.actor,
        confirmedEmail:request.email,approved:true,operationalWorkspaces:true,surveyResults:true},request.env,Date.parse(createdAt),result=>{
        const after=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').raw().all();
        requireValue(hash(canonical(after))===request.expectedAfterSchemaSha256);
        encrypted=encrypt({email:request.email,name:request.name,role:'admin',allStaffAccess:false,
          operationalWorkspaceAccess:true,surveyResultsAccess:true,mfaPolicy:'normal-admin-personal-seed-only',
          ttlHours:24,createdAt,expiresAt:result.expiresAt,context:request.context,
          activationUrl:`https://bubblewash.co/staff/activate#${result.token}`},request.publicKey,request.context);
        requireValue(Buffer.isBuffer(encrypted)&&encrypted.length<=16384);
        beforeCommit();
      });
    }).immediate();
    return encrypted;
  } finally {db.close();}
}

function line(limit) {
  const parts=[];let total=0;
  for (;;) {const b=Buffer.alloc(1);requireValue(readSync(0,b,0,1,null)===1);if(b[0]===10)break;parts.push(b);requireValue(++total<=limit);}
  return Buffer.concat(parts).toString('utf8');
}
function privateFile(filename, limit) {
  requireValue(path.isAbsolute(filename)&&realpathSync(filename)===filename);
  const fd=openSync(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const info=fstatSync(fd,{bigint:true});requireValue(info.isFile()&&info.nlink===1n&&(info.mode&0o077n)===0n&&info.uid===BigInt(process.getuid())&&info.size<=BigInt(limit));
    const raw=readFileSync(fd),after=fstatSync(fd,{bigint:true});requireValue(BigInt(raw.length)===info.size&&['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'].every(k=>info[k]===after[k]));return raw;
  } finally {closeSync(fd);}
}
export async function main(args=[]) {
  if(args.length===5&&args[0]==='decrypt') {
    const expected=JSON.parse(line(8192));const plain=unseal(privateFile(args[2],16384),privateFile(args[1],8192),expected);
    requireValue(args[3]==='--handover-file' && path.isAbsolute(args[4]) && realpathSync(path.dirname(args[4]))===path.dirname(args[4]));const fd=openSync(args[4],constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try {writeSync(fd,canonical({activationUrl:plain.activationUrl,expiresAt:plain.expiresAt})+'\n');fsyncSync(fd);} finally {closeSync(fd);}
    return; // No recipient, token, expiry or document contents on stdout.
  }
  requireValue(args.length===0);const request=JSON.parse(line(16384));const deps=await runtime(request.release);
  if(request.mode==='check'){writeSync(1,Buffer.from(canonical(checkInvitation(request,deps))));return;}
  requireValue(request.mode==='transition-document');
  const encrypted=transitionInvitation(request,deps,()=>{writeSync(1,'READY\n');requireValue(line(16)==='COMMIT');});
  writeSync(1,encrypted);
}
if(process.argv[1]===new URL(import.meta.url).pathname) main(process.argv.slice(2)).catch(()=>{process.stderr.write('Administrator transition refused; inspect before any retry.\n');process.exitCode=1;});
