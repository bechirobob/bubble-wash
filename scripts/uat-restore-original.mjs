// Operator-only restoration; never imported by the application or exposed over HTTP.
// Request and receipt stay on private stdin/stdout. No identifiers in the receipt.
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, statSync, realpathSync, readdirSync, readlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assertUatEnvironment } from '../src/lib/uat-environment.ts';
import { createPasswordHash, matchesKnownDemoPassword } from '../src/lib/passwords.ts';

const ORIGINAL_START = Date.parse('2026-10-26T23:19:33.802Z');
const WINDOW = 604800000;
const OPERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PREFLIGHT_AGE = 300000;
const ROLES = ['admin', 'vendor', 'driver', 'support'];
const require = condition => { if (!condition) throw new Error('UAT restoration refused.'); };
const EXPECTED_SCHEMA = {"staff_uat_accounts": "CREATE TABLE staff_uat_accounts (username TEXT PRIMARY KEY COLLATE NOCASE, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','vendor','driver','support')), entity_id TEXT NOT NULL, password_hash TEXT NOT NULL, credential_version TEXT NOT NULL, starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK (expires_at - starts_at = 604800000), status TEXT NOT NULL CHECK (status IN ('active','revoked','expired')), created_at INTEGER NOT NULL)", "staff_uat_audit": "CREATE TABLE staff_uat_audit (id TEXT PRIMARY KEY, username TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, occurred_at INTEGER NOT NULL, starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)"};
function assertSchema(db) {
  for (const [name, sql] of Object.entries(EXPECTED_SCHEMA)) {
    const row = db.prepare("SELECT type, sql FROM sqlite_master WHERE name=?").get(name);
    require(row?.type === 'table' && row.sql === sql);
  }
  require(!db.prepare("SELECT 1 FROM sqlite_master WHERE (type='trigger' OR (type='index' AND sql IS NOT NULL)) AND tbl_name IN ('staff_uat_accounts','staff_uat_audit') LIMIT 1").get());
}
function state(db) {
  assertSchema(db);
  const snapshot = {
    accounts: db.prepare('SELECT * FROM staff_uat_accounts ORDER BY username LIMIT 1001').all(),
    audit: db.prepare('SELECT * FROM staff_uat_audit ORDER BY id LIMIT 10001').all(),
    vendors: db.prepare('SELECT * FROM vendor_availability ORDER BY vendor_id LIMIT 1001').all(),
    drivers: db.prepare('SELECT * FROM driver_availability ORDER BY driver_id LIMIT 1001').all(),
  };
  require(snapshot.accounts.length <= 1000 && snapshot.audit.length <= 10000 && snapshot.vendors.length <= 1000 && snapshot.drivers.length <= 1000);
  return snapshot;
}
function eligible(snapshot, now) {
  const original = snapshot.audit.filter(a => a.action === 'created' && a.actor === 'approved-uat-issuance' &&
    a.starts_at === ORIGINAL_START && a.expires_at === ORIGINAL_START + WINDOW);
  require(original.length === 4 && new Set(original.map(a => a.username)).size === 4);
  const targets = original.map(a => snapshot.accounts.find(row => row.username === a.username));
  require(targets.every(a => a && ['active', 'expired'].includes(a.status) && a.starts_at === ORIGINAL_START &&
    a.expires_at === ORIGINAL_START + WINDOW && now >= a.expires_at));
  require(ROLES.every(role => targets.filter(a => a.role === role).length === 1));
  require(targets.every(a => a.role === 'vendor' ? Boolean(a.entity_id) && snapshot.vendors.some(v => v.vendor_id === a.entity_id) :
    a.role === 'driver' ? Boolean(a.entity_id) && snapshot.drivers.some(d => d.driver_id === a.entity_id) : a.entity_id === ''));

  require(!snapshot.audit.some(a => targets.some(t => t.username === a.username) &&
    ['revoked', 'restored-original-before', 'restored-original-after'].includes(a.action)));
  return targets;
}
const fingerprint = snapshot => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
export function inspectOriginalUat(db, now = Date.now()) {
  assertUatEnvironment();
  const snapshot = state(db);
  eligible(snapshot, now);
  return { ok: true, eligible: 4, fingerprint: fingerprint(snapshot), inspectedAt: now, originalStartsAt: ORIGINAL_START,
    originalExpiresAt: ORIGINAL_START + WINDOW };
}
export function restoreOriginalUat(db, request, databaseGuard = () => {}) {
  assertUatEnvironment();
  require(request && OPERATION.test(request.operationId) && Number.isSafeInteger(request.inspectedAt) &&
    Object.keys(request).every(k => ['action','operationId','inspectedAt','fingerprint','accounts','expectedDatabaseIdentity'].includes(k)) &&
    /^[a-f0-9]{64}$/.test(request.fingerprint) &&
    Array.isArray(request.accounts) && request.accounts.length === 4);
  require(request.accounts.every(a => a && typeof a.username === 'string' && typeof a.password === 'string' &&
    a.password.length >= 14 && a.password.length <= 200 && ROLES.includes(a.role) &&
    Object.keys(a).sort().join(',') === 'password,role,username'));
  require(new Set(request.accounts.map(a => a.username)).size === 4);
  // Hash before taking the writer lock; never put plaintext in SQL or audit records.
  const hashes = request.accounts.map(a => createPasswordHash(a.password));
  require(hashes.every(hash => !matchesKnownDemoPassword(hash)));
  return db.transaction(() => {
    databaseGuard();
    const now = Date.now();
    require(now >= request.inspectedAt && now - request.inspectedAt <= MAX_PREFLIGHT_AGE);
    const snapshot = state(db);
    require(fingerprint(snapshot) === request.fingerprint);
    const targets = eligible(snapshot, now);
    require(targets.every(a => request.accounts.some(input => input.username === a.username && input.role === a.role)));
    const actor = 'approved-uat-restoration:' + request.operationId;
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
      insert.run(randomUUID(), account.username, 'restored-original-before', actor, now, account.starts_at, account.expires_at);
      insert.run(randomUUID(), account.username, 'restored-original-after', actor, now, now, now + WINDOW);
    }
    const committed = state(db).accounts.filter(a => targets.some(t => t.username === a.username));
    // Private account-state commitment stays in the existing audit table, never in receipts/logs.
    db.prepare('INSERT INTO staff_uat_audit (id,username,action,actor,occurred_at,starts_at,expires_at) VALUES (?,?,?,?,?,?,?)').run(
      randomUUID(), 'system:uat-restoration', 'restored-original-receipt:' + fingerprint(committed), actor, now, now, now + WINDOW);
    const receipt = restorationReceipt(db, request.operationId);
    require(receipt.state === 'committed');
    databaseGuard();
    return { ...receipt, readOnly: false };

  }).immediate();
}

export function restorationReceipt(db, operationId) {
  assertUatEnvironment();
  require(OPERATION.test(operationId));
  return db.transaction(() => {
    const snapshot = state(db);
    const actor = 'approved-uat-restoration:' + operationId;
    const all = snapshot.audit.filter(a => a.action.startsWith('restored-original-'));
    const entries = all.filter(a => a.actor === actor);
    const base = { ok: true, readOnly: true, automaticRetry: false };
    if (!entries.length) {
      if (!all.length) {
        try { eligible(snapshot, Date.now()); return { ...base, state: 'not-observed' }; }
        catch { return { ...base, state: 'uncertain-stop' }; }
      }
      const foreignActors = [...new Set(all.map(a => a.actor))];
      if (foreignActors.length !== 1 || !foreignActors[0].startsWith('approved-uat-restoration:')) return { ...base, state: 'uncertain-stop' };
      const foreignId = foreignActors[0].slice('approved-uat-restoration:'.length);
      if (!OPERATION.test(foreignId)) return { ...base, state: 'uncertain-stop' };
      const foreign = restorationReceipt(db, foreignId);
      return { ...base, state: ['committed','committed-state-changed'].includes(foreign.state) ? 'different-operation' : 'uncertain-stop' };
    }
    const before = entries.filter(a => a.action === 'restored-original-before');
    const after = entries.filter(a => a.action === 'restored-original-after');
    const marker = entries.filter(a => /^restored-original-receipt:[a-f0-9]{64}$/.test(a.action) && a.username === 'system:uat-restoration');
    const original = snapshot.audit.filter(a => a.action === 'created' && a.actor === 'approved-uat-issuance' && a.starts_at === ORIGINAL_START && a.expires_at === ORIGINAL_START + WINDOW);
    const identities = original.map(a => a.username).sort();
    const sameTargets = rows => rows.length === 4 && JSON.stringify(rows.map(a => a.username).sort()) === JSON.stringify(identities);
    if (entries.length !== 9 || all.length !== 9 || original.length !== 4 || new Set(identities).size !== 4 || !sameTargets(before) || !sameTargets(after) || marker.length !== 1)
      return { ...base, state: 'uncertain-stop' };
    const stamp = marker[0];
    if (!Number.isSafeInteger(stamp.starts_at) || !Number.isSafeInteger(stamp.expires_at) || stamp.starts_at < ORIGINAL_START + WINDOW || stamp.expires_at - stamp.starts_at !== WINDOW || stamp.occurred_at !== stamp.starts_at ||
      !before.every(a => a.starts_at === ORIGINAL_START && a.expires_at === ORIGINAL_START + WINDOW && a.occurred_at === stamp.starts_at) ||
      !after.every(a => a.starts_at === stamp.starts_at && a.expires_at === stamp.expires_at && a.occurred_at === stamp.starts_at)) return { ...base, state: 'uncertain-stop' };
    const current = snapshot.accounts.filter(a => identities.includes(a.username));
    const unchanged = current.length === 4 && fingerprint(current) === stamp.action.slice('restored-original-receipt:'.length);
    return { ...base, state: unchanged ? 'committed' : 'committed-state-changed', restored: 4,
      startsAt: stamp.starts_at, expiresAt: stamp.expires_at, oldSessionsInvalidated: true };
  })();
}

export function databaseIdentityGuard(databasePath, identity) {
    require(identity && Object.keys(identity).sort().join(',') === 'device,inode' &&
      typeof identity.device === 'string' && /^[0-9]{1,20}$/.test(identity.device) &&
      typeof identity.inode === 'string' && /^[0-9]{1,20}$/.test(identity.inode));
    function guardDatabase(opened = false) {
      require(realpathSync(databasePath) === databasePath);
      const info = lstatSync(databasePath, { bigint: true });
      require(info.isFile() && info.nlink === 1n && String(info.dev) === identity.device && String(info.ino) === identity.inode);
      if (opened) {
        const descriptors = readdirSync('/proc/self/fd').filter(fd => {
          try { return readlinkSync('/proc/self/fd/' + fd) === databasePath; } catch { return false; }
        });
        require(descriptors.length === 1);
        const actual = statSync('/proc/self/fd/' + descriptors[0], { bigint: true });
        require(String(actual.dev) === identity.device && String(actual.ino) === identity.inode);
      }
    }
    return guardDatabase;
}

export async function runOperator() {
  try {
    assertUatEnvironment();
    require(process.argv.length <= 2);
    // Exact deployed paths only. Host isolation and source verification precede this operator.
    require(process.env.BUBBLEWASH_PUBLIC_URL === 'https://uat.bubblewash.co' &&
      process.env.BUBBLEWASH_DATABASE_PATH === '/var/lib/bubblewash-uat/uat.sqlite' &&
      process.env.BUBBLEWASH_UAT_DATA_ROOT === '/var/lib/bubblewash-uat');
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; require(Buffer.byteLength(input) <= 8192); }
    const request = JSON.parse(input); input = '';
    require(['inspect', 'restore', 'receipt'].includes(request.action));
    const guardDatabase = databaseIdentityGuard(process.env.BUBBLEWASH_DATABASE_PATH, request.expectedDatabaseIdentity);
    guardDatabase();
    const { default: Database } = await import('better-sqlite3');
    // Never invoke getDatabase(): it can initialize/migrate unrelated application schema.
    const db = new Database(process.env.BUBBLEWASH_DATABASE_PATH, { readonly: request.action !== 'restore', fileMustExist: true });
    try {
      guardDatabase(true);
      db.pragma('trusted_schema = OFF');
      if (request.action !== 'restore') db.pragma('query_only = ON');
      const receipt = request.action === 'inspect' ? inspectOriginalUat(db) : request.action === 'receipt' ? restorationReceipt(db, request.operationId) : restoreOriginalUat(db, request, () => guardDatabase(true));
      guardDatabase(true);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runOperator();
