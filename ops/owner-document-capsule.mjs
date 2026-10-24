// Operator-only capsule. Not live application source and never installed there.
import { constants, openSync, closeSync, fstatSync, readSync, readFileSync, writeSync, fsyncSync, existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv, createPublicKey, privateDecrypt, publicEncrypt, constants as cryptoConstants } from 'node:crypto';

export const PURPOSE = 'bubblewash-owner-document/v1';
export const CAPABILITY_DDL = 'CREATE TABLE IF NOT EXISTS staff_owner_capabilities (email TEXT PRIMARY KEY COLLATE NOCASE REFERENCES staff_accounts(email), all_staff_access INTEGER NOT NULL CHECK (all_staff_access = 1))';
const requireValue = value => { if (!value) throw Error('Owner document operation refused.'); };
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value==='object' ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])) : value;
const canonical = value => JSON.stringify(ordered(value));
const hash = value => createHash('sha256').update(value).digest('hex');
export function contextValid(value) {
  requireValue(value && Object.keys(value).sort().join(',') === 'controlSha,runAttempt,runId,runtimeSha');
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
    requireValue(Object.keys(plain).sort().join(',')==='activationUrl,allStaffAccess,context,createdAt,email,expiresAt,name,role,ttlHours');
    requireValue(canonical(plain.context)===canonical(expected.context) && plain.email===expected.email && plain.name===expected.name && plain.role==='admin' && plain.allStaffAccess===true && plain.ttlHours===24);
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
  return {Database,assertOwnerEmailAvailable:staff.assertOwnerEmailAvailable,initializeStaffAccountsSchema:staff.initializeStaffAccountsSchema,databaseReadiness:data.databaseReadiness};
}
export function createInvitation(request, deps, beforeCommit, encrypt=seal) {
  contextValid(request.context);keyInfo(request.publicKey); // Reject a bad handoff before opening the writer.
  requireValue(typeof request.email==='string' && request.email===request.email.trim().toLowerCase() && request.email.length<=160 && /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(request.email));
  requireValue(typeof request.name==='string' && request.name.trim()===request.name && request.name.length>0 && request.name.length<=100 && !/[\r\n\0]/.test(request.name));
  requireValue(/^github-actions:[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/.test(request.actor));
  requireValue(path.isAbsolute(request.dbPath) && path.isAbsolute(request.release) && !existsSync(path.join(request.release,'data/submissions.jsonl')));
  requireValue(request.env.NODE_ENV==='production' && request.env.BUBBLEWASH_DISABLE_DEMO_LOGIN==='true' && request.env.BUBBLEWASH_STAFF_AUTH_DISABLED==='false');
  const db=new deps.Database(request.dbPath,{fileMustExist:true});
  try {
    db.pragma('foreign_keys = ON');db.pragma('trusted_schema = OFF');db.pragma('busy_timeout = 5000');
    return db.transaction(() => {
      const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').raw().all();
      requireValue(hash(canonical(schema))===request.schemaSha256 && !schema.some(row=>row[0]==='trigger'||row[0]==='view'));
      requireValue(schema.some(row=>row[0]==='table'&&row[1]==='staff_owner_capabilities'));
      requireValue(deps.databaseReadiness(db,[deps.initializeStaffAccountsSchema,reference=>reference.exec(CAPABILITY_DDL)]));
      requireValue(!db.prepare('SELECT 1 FROM staff_credential_overrides WHERE lower(trim(login)) = ?').get(request.email));
      deps.assertOwnerEmailAvailable(request.email,db,request.env);
      const createdAt=new Date(Date.now()).toISOString(),expiresAt=new Date(Date.parse(createdAt)+86400000).toISOString();
      const token=randomBytes(32).toString('base64url');
      // Same reviewed owner insertion/write-set, with explicit 24h at creation.
      // Existing capability schema is required: never run target DDL.
      db.prepare("INSERT INTO staff_accounts (email,name,role,entity_id,password_hash,credential_version,status,token_hash,token_expires_at,updated_at) VALUES (?,?,'admin','','',?,'invited',?,?,?)").run(request.email,request.name,randomUUID(),hash(token),expiresAt,createdAt);
      db.prepare('INSERT INTO staff_owner_capabilities (email,all_staff_access) VALUES (?,1)').run(request.email);
      db.prepare('INSERT INTO submissions (id,created_at,source,data) VALUES (?,?,?,?)').run(`BW-${randomUUID()}`,createdAt,'staff-account-administration',canonical({submissionType:'staff-account-action',staffEmail:request.email,actionType:'Invite additional owner without changing existing accounts',submittedByEmail:request.actor}));
      const encrypted=encrypt({email:request.email,name:request.name,role:'admin',allStaffAccess:true,ttlHours:24,createdAt,expiresAt,context:request.context,activationUrl:`https://bubblewash.co/staff/activate#${token}`},request.publicKey,request.context);
      requireValue(Buffer.isBuffer(encrypted) && encrypted.length<=16384);
      beforeCommit(); // Parent rechecks exact source/config/DB/lock and backup before COMMIT.
      return encrypted;
    }).immediate();
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
    requireValue(args[3]==='--setup-link-file' && path.isAbsolute(args[4]) && realpathSync(path.dirname(args[4]))===path.dirname(args[4]));const fd=openSync(args[4],constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try {writeSync(fd,plain.activationUrl+'\n');fsyncSync(fd);} finally {closeSync(fd);}
    return; // No recipient, token, expiry or document contents on stdout.
  }
  requireValue(args.length===0);const request=JSON.parse(line(16384));const deps=await runtime(request.release);
  const encrypted=createInvitation(request,deps,()=>{writeSync(1,'READY\n');requireValue(line(16)==='COMMIT');});
  writeSync(1,encrypted);
}
if(process.argv[1]===new URL(import.meta.url).pathname) main(process.argv.slice(2)).catch(()=>{process.stderr.write('Owner document operation refused; inspect before any retry.\n');process.exitCode=1;});
