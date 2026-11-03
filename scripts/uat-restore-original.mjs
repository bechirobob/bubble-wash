// Operator-only restoration; never imported by the application or exposed over HTTP.
// Request and receipt stay on private stdin/stdout. No identifiers in the receipt.
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assertUatEnvironment } from '../src/lib/uat-environment.ts';
import { createPasswordHash, matchesKnownDemoPassword } from '../src/lib/passwords.ts';

const ORIGINAL_START = Date.parse('2026-10-26T23:19:33.802Z');
const WINDOW = 604800000;
const ROLES = ['admin', 'vendor', 'driver', 'support'];
const require = condition => { if (!condition) throw new Error('UAT restoration refused.'); };
function state(db) {
  return {
    accounts: db.prepare('SELECT * FROM staff_uat_accounts ORDER BY username').all(),
    audit: db.prepare('SELECT * FROM staff_uat_audit ORDER BY id').all(),
  };
}
function eligible(snapshot, now) {
  const original = snapshot.audit.filter(a => a.action === 'created' && a.actor === 'approved-uat-issuance' &&
    a.starts_at === ORIGINAL_START && a.expires_at === ORIGINAL_START + WINDOW);
  require(original.length === 4 && new Set(original.map(a => a.username)).size === 4);
  const targets = original.map(a => snapshot.accounts.find(row => row.username === a.username));
  require(targets.every(a => a && ['active', 'expired'].includes(a.status) && a.starts_at === ORIGINAL_START &&
    a.expires_at === ORIGINAL_START + WINDOW && now >= a.expires_at));
  require(ROLES.every(role => targets.filter(a => a.role === role).length === 1));
  require(!snapshot.audit.some(a => targets.some(t => t.username === a.username) &&
    ['revoked', 'restored-original-before', 'restored-original-after'].includes(a.action)));
  return targets;
}
const fingerprint = snapshot => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
export function inspectOriginalUat(db, now = Date.now()) {
  assertUatEnvironment();
  const snapshot = state(db);
  eligible(snapshot, now);
  return { ok: true, eligible: 4, fingerprint: fingerprint(snapshot), originalStartsAt: ORIGINAL_START,
    originalExpiresAt: ORIGINAL_START + WINDOW };
}
export function restoreOriginalUat(db, request) {
  assertUatEnvironment();
  require(request && /^[a-f0-9]{64}$/.test(request.fingerprint) &&
    Array.isArray(request.accounts) && request.accounts.length === 4);
  require(request.accounts.every(a => a && typeof a.username === 'string' && typeof a.password === 'string' &&
    a.password.length >= 14 && a.password.length <= 200));
  require(new Set(request.accounts.map(a => a.username)).size === 4);
  // Hash before taking the writer lock; never put plaintext in SQL or audit records.
  const hashes = request.accounts.map(a => createPasswordHash(a.password));
  require(hashes.every(hash => !matchesKnownDemoPassword(hash)));
  return db.transaction(() => {
    const now = Date.now();
    const snapshot = state(db);
    require(fingerprint(snapshot) === request.fingerprint);
    const targets = eligible(snapshot, now);
    require(targets.every(a => request.accounts.some(input => input.username === a.username)));
    for (const account of targets) {
      if (account.role === 'vendor') require(db.prepare('SELECT 1 FROM vendor_availability WHERE vendor_id=?').get(account.entity_id));
      if (account.role === 'driver') require(db.prepare('SELECT 1 FROM driver_availability WHERE driver_id=?').get(account.entity_id));
      const index = request.accounts.findIndex(a => a.username === account.username);
      const changed = db.prepare(`UPDATE staff_uat_accounts SET password_hash=?, credential_version=?, starts_at=?, expires_at=?, status='active'
        WHERE username=? AND credential_version=? AND status=? AND starts_at=? AND expires_at=?`).run(
        hashes[index], randomUUID(), now, now + WINDOW, account.username, account.credential_version,
        account.status, account.starts_at, account.expires_at).changes;
      require(changed === 1);
      const insert = db.prepare('INSERT INTO staff_uat_audit (id,username,action,actor,occurred_at,starts_at,expires_at) VALUES (?,?,?,?,?,?,?)');
      insert.run(randomUUID(), account.username, 'restored-original-before', 'approved-uat-restoration', now, account.starts_at, account.expires_at);
      insert.run(randomUUID(), account.username, 'restored-original-after', 'approved-uat-restoration', now, now, now + WINDOW);
    }
    return { ok: true, restored: 4, startsAt: now, expiresAt: now + WINDOW, oldSessionsInvalidated: true };
  }).immediate();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertUatEnvironment();
    require(process.argv.length === 2);
    // Exact deployed paths only. Host isolation and source verification precede this operator.
    require(process.env.BUBBLEWASH_PUBLIC_URL === 'https://uat.bubblewash.co' &&
      process.env.BUBBLEWASH_DATABASE_PATH === '/var/lib/bubblewash-uat/uat.sqlite' &&
      process.env.BUBBLEWASH_UAT_DATA_ROOT === '/var/lib/bubblewash-uat');
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; require(Buffer.byteLength(input) <= 8192); }
    const request = JSON.parse(input); input = '';
    require(['inspect', 'restore'].includes(request.action));
    const { default: Database } = await import('better-sqlite3');
    // Never invoke getDatabase(): it can initialize/migrate unrelated application schema.
    const db = new Database(process.env.BUBBLEWASH_DATABASE_PATH, { readonly: request.action === 'inspect', fileMustExist: true });
    try {
      const receipt = request.action === 'inspect' ? inspectOriginalUat(db) : restoreOriginalUat(db, request);
      process.stdout.write(JSON.stringify(receipt) + '\n');
    } finally {
      for (const account of request.accounts ?? []) account.password = '';
      db.close();
    }
  } catch {
    process.stderr.write('UAT restoration refused; inspect privately before any retry.\n');
    process.exitCode = 1;
  }
}
