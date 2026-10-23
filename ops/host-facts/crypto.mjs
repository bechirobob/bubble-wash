import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, readFileSync, writeFileSync, fsyncSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAGIC = Buffer.from('BWHFACT1');
export const LIMIT = 2 * 1024 * 1024;
const PURPOSE = 'bubblewash-host-facts/v1';
const FLAGS = new Set(['unit-unavailable','manager-unavailable','pending-reload','unsafe-source','metadata-incomplete','space-unavailable','space-exhausted','php-incomplete','launch-executable-unresolved','operator-exclusion-unresolved','staging-capacity-unassessed','generator-overrides-unobserved','installer-env-metadata-unavailable','installer-env-owner-mode-unsafe','installer-env-attributes-present','installer-env-binding-unverified','deployment-lock-unverified','tool-unavailable','php-indicators-observed','php-no-indicators-observed-incomplete','installer-metadata-preconditions-observed','installer-metadata-preconditions-unverified']);
const requireValue = value => { if (!value) throw Error('inspection cryptography refused'); };
const keys = (value, expected) => requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === expected.sort().join(','));
export function header(raw) {
  requireValue(raw.length <= 8192);
  const value = JSON.parse(raw.toString('ascii'));
  keys(value, ['schema','context','summary']);
  requireValue(value.schema === PURPOSE);
  keys(value.context, ['sourceSha','runId','runAttempt']);
  requireValue(/^[a-f0-9]{40}$/.test(value.context.sourceSha) && /^[1-9][0-9]{0,19}$/.test(value.context.runId) && /^[1-9][0-9]{0,19}$/.test(value.context.runAttempt));
  keys(value.summary, ['schema','result','flags']);
  requireValue(value.summary.schema === 'bubblewash-host-facts-summary/v1' && value.summary.result === 'captured');
  const flags = value.summary.flags;
  requireValue(Array.isArray(flags) && flags.every(x => typeof x === 'string' && FLAGS.has(x)) && JSON.stringify(flags) === JSON.stringify([...new Set(flags)].sort()));
  // The producer emits sorted ASCII JSON. This also rejects duplicate keys,
  // alternate encodings and non-ASCII public metadata before authentication.
  const sorted = x => Array.isArray(x) ? x.map(sorted) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k,sorted(x[k])])) : x;
  requireValue(Buffer.from(JSON.stringify(sorted(value)), 'ascii').equals(raw));
  return value;
}
export function readKey(filename, appUid) {
  requireValue(path.isAbsolute(filename) && path.normalize(filename) === filename);
  for (let item = path.dirname(filename);; item = path.dirname(item)) {
    const info = lstatSync(item);
    requireValue(info.isDirectory() && [0,appUid].includes(info.uid) && !(info.mode & 0o022));
    if (item === '/') break;
  }
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, {bigint:true});
    requireValue(before.isFile() && before.nlink === 1n && [0n,BigInt(appUid)].includes(before.uid) && !(before.mode & 0o077n) && before.size >= 44n && before.size <= 45n);
    const data = Buffer.alloc(46); let size = 0;
    while (size < data.length) { const count = readSync(fd,data,size,data.length-size,null); if (!count) break; size += count; }
    const after = fstatSync(fd,{bigint:true});
    requireValue(['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'].every(k => before[k] === after[k]));
    const raw = data.subarray(0,size).toString('ascii');
    requireValue(/^[A-Za-z0-9+/]{43}=\n?$/.test(raw));
    const key = Buffer.from(raw.trimEnd(),'base64');
    requireValue(key.length === 32 && key.toString('base64') === raw.trimEnd());
    return key;
  } finally { closeSync(fd); }
}
const derived = key => { requireValue(Buffer.isBuffer(key) && key.length === 32); return createHmac('sha256',key).update(PURPOSE).digest(); };
export function seal(rawHeader, plain, key) {
  header(rawHeader); requireValue(plain.length > 0 && plain.length <= LIMIT);
  const length = Buffer.alloc(4); length.writeUInt32BE(rawHeader.length);
  const aad = Buffer.concat([MAGIC,length,rawHeader]); const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm',derived(key),nonce); cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plain),cipher.final()]);
  return Buffer.concat([aad,nonce,cipher.getAuthTag(),encrypted]);
}
export function unseal(envelope, key, expected) {
  requireValue(envelope.length <= LIMIT + 8232 && envelope.subarray(0,8).equals(MAGIC));
  const length = envelope.readUInt32BE(8); requireValue(length > 0 && length <= 8192 && envelope.length > 12+length+28);
  const rawHeader = envelope.subarray(12,12+length), meta = header(rawHeader);
  requireValue(JSON.stringify(meta.context) === JSON.stringify(expected));
  const at = 12+length; const decipher = createDecipheriv('aes-256-gcm',derived(key),envelope.subarray(at,at+12));
  decipher.setAAD(envelope.subarray(0,at)); decipher.setAuthTag(envelope.subarray(at+12,at+28));
  return {rawHeader,plain:Buffer.concat([decipher.update(envelope.subarray(at+28)),decipher.final()])};
}
async function input() {
  let count=0; const chunks=[];
  for await (const chunk of process.stdin) { count+=chunk.length; requireValue(count <= LIMIT+8193); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export async function main(args) {
  if (args[0] === 'encrypt' && args.length === 3) {
    const key=readKey(args[1],Number(args[2])); const raw=await input(); const split=raw.indexOf(10); requireValue(split > 0);
    process.stdout.write(seal(raw.subarray(0,split),raw.subarray(split+1),key)); return;
  }
  if (args[0] === 'decrypt' && args.length === 8) {
    // Deliberate private local output only, never stdout. Key is never exported.
    const expected={runAttempt:args[7],runId:args[6],sourceSha:args[5]};
    const info=lstatSync(args[3]); requireValue(info.isFile() && !info.isSymbolicLink() && info.size <= LIMIT+8232);
    const result=unseal(readFileSync(args[3]),readKey(args[1],Number(args[2])),expected);
    const fd=openSync(args[4],constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try { writeFileSync(fd,Buffer.concat([result.rawHeader,Buffer.from('\n'),result.plain])); fsyncSync(fd); } finally {closeSync(fd);}
    return;
  }
  throw Error('invalid inspection crypto mode');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write('Inspection cryptography failed.\n'); process.exitCode=1; });
}
