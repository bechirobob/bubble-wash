// Operator-only issuance: captured stdout contains ciphertext, never credentials.
// Installation does not issue accounts. Invoke only after host readiness approval.
import { createPublicKey, randomBytes, createCipheriv, publicEncrypt, constants, createHash } from 'node:crypto';
import { getDatabase } from '../src/lib/data-store.ts';
import { issueUatCohort } from '../src/lib/uat-accounts.ts';
import { assertUatEnvironment } from '../src/lib/uat-environment.ts';

export function sealHandover(value, publicKey) {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 3072) throw new Error('Recipient key refused.');
  const fingerprint = createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex');
  const secret = randomBytes(32), iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', secret, iv);
    const aad = Buffer.from('bubblewash-uat-handover/v1'); cipher.setAAD(aad);
    const plaintext = Buffer.from(JSON.stringify(value));
    let encrypted;
    try { encrypted = Buffer.concat([cipher.update(plaintext),cipher.final()]); }
    finally { plaintext.fill(0); }
    return {schema:aad.toString(),recipientSha256:fingerprint,wrappedKey:publicEncrypt({key,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},secret).toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')};
  } finally { secret.fill(0); }
}

export function issueSealedHandover(request) {
  assertUatEnvironment();
  if (request.approved !== true || request.ready !== true || request.action !== 'issue' || typeof request.publicKey !== 'string') throw new Error('Issuance refused.');
  // Validate recipient crypto before opening the issuance transaction.
  sealHandover({probe:true},request.publicKey);
  const db = getDatabase();
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='uat_sealed_handover'").get()) throw new Error('Handover already exists; do not reissue.');
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='staff_uat_accounts'").get() && db.prepare('SELECT 1 FROM staff_uat_accounts LIMIT 1').get()) throw new Error('Accounts already exist; do not reissue.');
    const accounts = ['admin','vendor','driver','support'].map(role=>({username:`review-${role}`,name:`UAT ${role}`,role,password:randomBytes(24).toString('base64url'),...(['vendor','driver'].includes(role)?{entityId:`uat-${role}-one`}:{})}));
    try {
      const receipt = issueUatCohort(accounts,'approved-uat-issuance',db);
      const sealed = sealHandover({uat_origin:'https://uat.bubblewash.co',issued_at:new Date(receipt.issuedAt).toISOString(),expires_at:new Date(receipt.expiresAt).toISOString(),accounts:Object.fromEntries(accounts.map(a=>[a.role,{username:a.username,password:a.password}]))},request.publicKey);
      // The encrypted handoff and accounts commit together. A failed transfer can
      // retrieve this exact envelope, never mint passwords or restart the window.
      db.exec('CREATE TABLE uat_sealed_handover (id INTEGER PRIMARY KEY CHECK(id=1), envelope TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
      db.prepare('INSERT INTO uat_sealed_handover VALUES (1,?,?,?)').run(JSON.stringify(sealed),receipt.issuedAt,receipt.expiresAt);
      return sealed;
    } finally { for (const a of accounts) a.password=''; }
  }).immediate();
}

export function retrieveSealedHandover(publicKey) {
  assertUatEnvironment();
  const expected = sealHandover({probe:true},publicKey).recipientSha256;
  const row = getDatabase().prepare('SELECT envelope FROM uat_sealed_handover WHERE id=1').get();
  if (!row) throw new Error('No sealed handoff available.');
  const envelope = JSON.parse(row.envelope);
  if (envelope.schema !== 'bubblewash-uat-handover/v1' || envelope.recipientSha256 !== expected) throw new Error('Recipient mismatch.');
  return envelope;
}

if (process.argv[1]?.endsWith('/uat-sealed-handover.mjs')) {
  try {
    if(process.argv.length!==2)throw new Error();
    let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>8192)throw new Error();}
    const request=JSON.parse(raw);raw='';
    if(request.approved!==true)throw new Error();
    const sealed=request.action==='retrieve' ? retrieveSealedHandover(request.publicKey) : issueSealedHandover(request);
    process.stdout.write(JSON.stringify(sealed)+'\n');
  } catch { process.stderr.write('UAT sealed issuance refused. Do not blindly retry.\n');process.exitCode=1; }
}
