// Recipient-side helper only. No network, key generation, or plaintext stdout.
import { createPublicKey,createPrivateKey,createHash,privateDecrypt,createDecipheriv,constants } from 'node:crypto';
import { openSync,closeSync,writeFileSync,fsyncSync,realpathSync,statSync,constants as fsConstants } from 'node:fs';
import path from 'node:path';
const require=value=>{if(!value)throw Error('Second cohort handover refused.');};
export function unsealSecondCohort(raw, privateKey, expected) {
  require(Buffer.isBuffer(raw) && raw.length>0 && raw.length<=16384);
  require(expected && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(expected.operationId) && (expected.expectedStateSha256===undefined || /^[0-9a-f]{64}$/.test(expected.expectedStateSha256)) && /^[0-9a-f]{64}$/.test(expected.recipientSha256));
  const envelope=JSON.parse(raw);
  require(Object.keys(envelope).sort().join()==='ciphertext,iv,recipientSha256,schema,tag,wrappedKey' && envelope.schema==='bubblewash-uat-handover/v1' && envelope.recipientSha256===expected.recipientSha256);
  const key=createPrivateKey(privateKey),publicKey=createPublicKey(key);
  require(publicKey.asymmetricKeyType==='rsa' && publicKey.asymmetricKeyDetails.modulusLength>=3072 &&
    createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex')===expected.recipientSha256);
  const decode=name=>{require(typeof envelope[name]==='string');const bytes=Buffer.from(envelope[name],'base64');require(bytes.toString('base64')===envelope[name]);return bytes;};
  const iv=decode('iv'),tag=decode('tag'),wrapped=decode('wrappedKey'),ciphertext=decode('ciphertext');
  require(iv.length===12 && tag.length===16 && wrapped.length===Math.ceil(publicKey.asymmetricKeyDetails.modulusLength/8) && ciphertext.length>0 && ciphertext.length<8192);
  const secret=privateDecrypt({key,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},wrapped);
  let plaintext;
  try {
    const decipher=createDecipheriv('aes-256-gcm',secret,iv);decipher.setAAD(Buffer.from(envelope.schema));decipher.setAuthTag(tag);
    plaintext=Buffer.concat([decipher.update(ciphertext),decipher.final()]);const value=JSON.parse(plaintext);
    require(Object.keys(value).sort().join()==='accounts,expectedStateSha256,expires_at,issued_at,operationId,recipientSha256,schema,uat_origin');
    require(value.schema==='bubblewash-uat-second-cohort/v1' && value.operationId===expected.operationId && /^[0-9a-f]{64}$/.test(value.expectedStateSha256) && (expected.expectedStateSha256===undefined || value.expectedStateSha256===expected.expectedStateSha256) && value.recipientSha256===expected.recipientSha256 && value.uat_origin==='https://uat.bubblewash.co');
    const issued=Date.parse(value.issued_at),expires=Date.parse(value.expires_at);
    require(Number.isSafeInteger(issued) && expires-issued===604800000 && new Date(issued).toISOString()===value.issued_at && new Date(expires).toISOString()===value.expires_at);
    require(Object.keys(value.accounts).sort().join()==='admin,driver,support,vendor');
    for(const [role,account] of Object.entries(value.accounts))require(Object.keys(account).sort().join()==='password,username' && account.username===`review2-${role}` && typeof account.password==='string' && /^[A-Za-z0-9_-]{32}$/.test(account.password));
    require(new Set(Object.values(value.accounts).map(a=>a.password)).size===4);
    return value;
  } finally {secret.fill(0);plaintext?.fill(0);}
}
export function savePrivateHandover(raw,privateKey,expected,destination) {
  // Only invoke in the approved user-only destination; no public/shared artifact.
  require(path.isAbsolute(destination) && realpathSync(path.dirname(destination))===path.dirname(destination));
  const directory=statSync(path.dirname(destination));
  require(directory.isDirectory() && directory.uid===process.geteuid() && (directory.mode&0o077)===0);
  const value=unsealSecondCohort(raw,privateKey,expected);
  const fd=openSync(destination,fsConstants.O_WRONLY|fsConstants.O_CREAT|fsConstants.O_EXCL|fsConstants.O_NOFOLLOW,0o600);
  try {writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);for(const a of Object.values(value.accounts))a.password='';}
}
