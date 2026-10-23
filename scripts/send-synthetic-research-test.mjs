// Private, one-time operator adapter. No public route, initializer, or retry loop.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const releaseRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const submissionKey = '20b2f9aa-77dd-4c7a-8efe-b23f176c77f1';
const blocked = () => ({ attempted: false, status: 'blocked' });

// Pipe one small JSON object from the existing protected owner-email value.
// Never accept a terminal, command-line recipient, additional fields, or a file.
export async function readOwnerInput(input, timeoutMs = 5_000) {
  if (input.isTTY) throw new Error('Private input required.');
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => input.destroy(new Error('Private input unavailable.')), timeoutMs);
  try {
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 1_024) throw new Error('Private input invalid.');
      chunks.push(bytes);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || Object.keys(value).length !== 1
      || typeof value.ownerEmail !== 'string' || value.ownerEmail.length > 254
      || !/^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(value.ownerEmail)) {
      throw new Error('Private input invalid.');
    }
    return value.ownerEmail;
  } finally { clearTimeout(timer); }
}

function verifySchema(db, Database) {
  // DDL is evaluated only in a disposable memory DB, never in the target DB.
  const reference = new Database(':memory:');
  try {
    reference.exec(readFileSync(new URL('../db/proposed/research-v1.sql', import.meta.url), 'utf8'));
    const sql = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name IN ('research_responses','research_notification_outbox') ORDER BY type,name";
    if (JSON.stringify(db.prepare(sql).all()) !== JSON.stringify(reference.prepare(sql).all())
      || db.pragma('quick_check', { simple: true }) !== 'ok'
      || db.pragma('foreign_key_check(research_notification_outbox)').length !== 0) {
      throw new Error('Existing schema required.');
    }
  } finally { reference.close(); }
}

export async function runSyntheticResearchTest({ mode, databasePath, input, env = process.env, send = fetch }) {
  let db;
  let helperStarted = false;
  try {
    if (!['--check', '--send'].includes(mode) || process.versions.node.split('.')[0] !== '22'
      || realpathSync(process.cwd()) !== realpathSync(releaseRoot)
      || env.NODE_ENV !== 'production' || !isAbsolute(databasePath || '')
      || !isAbsolute(env.BUBBLEWASH_DATABASE_PATH || '')
      || realpathSync(databasePath) !== realpathSync(env.BUBBLEWASH_DATABASE_PATH)) return blocked();
    const ownerEmail = await readOwnerInput(input);
    const key = env.BUBBLEWASH_RESEARCH_RESEND_KEY?.trim();
    // Installed dedicated key only. Never fall back to another service credential.
    if (!key || key.length > 1_024 || /[\s\x00-\x1f\x7f]/.test(key)) return blocked();
    const { default: Database } = await import('better-sqlite3');
    db = new Database(databasePath, { readonly: mode === '--check', fileMustExist: true });
    db.pragma('foreign_keys = ON');
    if (db.pragma('foreign_keys', { simple: true }) !== 1) return blocked();
    verifySchema(db, Database);
    const prior = db.prepare('SELECT o.state,o.attempts FROM research_responses r LEFT JOIN research_notification_outbox o ON o.response_id=r.id WHERE r.submission_key=?').get(submissionKey);
    if (prior && (prior.attempts !== 0 || !['held', 'pending'].includes(prior.state))) {
      return { attempted: false, status: 'already-attempted' };
    }
    if (mode === '--check') return { attempted: false, status: 'ready' };
    const { sendSyntheticResearchTest } = await import('../src/lib/research/provider.ts');
    helperStarted = true;
    const result = await sendSyntheticResearchTest(db, key, ownerEmail, send);
    return { attempted: result.attempted, status: result.status };
  } catch {
    // Once the helper starts, a thrown error may follow a durable claim or send.
    // Unknown is NOT permission to retry. Never expose error/provider/input data.
    return helperStarted ? { attempted: null, status: 'review-required' } : blocked();
  } finally { if (db?.open) db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let result = blocked();
  try {
    const [mode, flag, databasePath, ...extra] = process.argv.slice(2);
    if (flag === '--database' && extra.length === 0) {
      result = await runSyntheticResearchTest({ mode, databasePath, input: process.stdin });
    }
  } catch { result = { attempted: null, status: 'review-required' }; }
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = ['ready', 'accepted'].includes(result.status) ? 0 : 1;
}
