// Local operator module only: deliberately no CLI, workflow, or host transport.
// Caller must verify isolation and obtain action-time approval before invocation.
// Require a dedicated DB handle: getDatabase() performs unrelated housekeeping.
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { issueUatCohort } from '../src/lib/uat-accounts.ts';
import { assertUatEnvironment } from '../src/lib/uat-environment.ts';
import { sealHandover } from './uat-sealed-handover.mjs';

const roles = ['admin', 'vendor', 'driver', 'support'];
const table = 'uat_second_cohort_handover';
const schema = 'bubblewash-uat-second-cohort/v1';
const exists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const reject = () => { throw new Error('Second cohort refused; inspect state before retrying.'); };
const fingerprint = publicKey => sealHandover({ probe: true }, publicKey).recipientSha256;
function checkedDatabase(database) {
  assertUatEnvironment();
  // The supplied connection must target the same isolated file the guard checked.
  if (!database || typeof database.name !== 'string' ||
      realpathSync(database.name) !== realpathSync(process.env.BUBBLEWASH_DATABASE_PATH)) reject();
  return database;
}

// Opaque precondition, never return hashes/passwords or roster data to the caller.
// Include audit and roster changes so an approval cannot silently target new state.
export function secondCohortState(database) {
  const db = checkedDatabase(database);
  return createHash('sha256').update(JSON.stringify([
    ['staff_uat_accounts', 'username'], ['staff_uat_audit', 'id'],
    ['vendor_availability', 'vendor_id'], ['driver_availability', 'driver_id'],
    ['uat_sealed_handover', 'id'],
  ].map(([name, order]) => exists(db, name)
    ? db.prepare(`SELECT * FROM ${name} ORDER BY ${order}`).all() : null))).digest('hex');
}

function validate(request) {
  if (!request || request.approved !== true || request.ready !== true ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.operationId) ||
      !/^[0-9a-f]{64}$/.test(request.expectedStateSha256) || typeof request.publicKey !== 'string') reject();
}

export function issueSecondCohort(request, database) {
  assertUatEnvironment();
  // Copy scalar inputs once; no caller getters are read during the transaction.
  const input = { ...request };
  validate(input);
  const { operationId, expectedStateSha256, publicKey, notBefore, approvedUntil } = input;
  const recipientSha256 = fingerprint(publicKey);
  const db = checkedDatabase(database);
  return db.transaction(() => {
    const now = Date.now();
    if (!Number.isSafeInteger(notBefore) || !Number.isSafeInteger(approvedUntil) ||
        now < notBefore || now >= approvedUntil || approvedUntil - notBefore > 300_000 ||
        exists(db, table) || secondCohortState(db) !== expectedStateSha256) reject();
    // This operation is exclusively the second cohort. Never bootstrap missing
    // originals, revive revoked rows, or infer that an absent receipt is a retry.
    if (!exists(db, 'staff_uat_accounts')) reject();
    for (const role of roles) {
      const old = db.prepare('SELECT role, entity_id FROM staff_uat_accounts WHERE username=?').get(`review-${role}`);
      if (old?.role !== role || old.entity_id !== (['vendor', 'driver'].includes(role) ? `uat-${role}-one` : '')) reject();
    }
    if (db.prepare("SELECT 1 FROM staff_uat_accounts WHERE username LIKE 'review2-%' LIMIT 1").get()) reject();
    const accounts = roles.map(role => ({ username: `review2-${role}`, name: `UAT second cohort ${role}`, role,
      password: randomBytes(24).toString('base64url'),
      ...(['vendor', 'driver'].includes(role) ? { entityId: `uat-${role}-one` } : {}) }));
    try {
      const receipt = issueUatCohort(accounts, `second-cohort:${operationId}`, db);
      const sealed = sealHandover({ schema, operationId, expectedStateSha256, recipientSha256,
        uat_origin: 'https://uat.bubblewash.co', issued_at: new Date(receipt.issuedAt).toISOString(),
        expires_at: new Date(receipt.expiresAt).toISOString(),
        accounts: Object.fromEntries(accounts.map(a => [a.role, { username: a.username, password: a.password }])) }, publicKey);
      // Recheck after password hashing; an expired approval rolls back everything.
      const completedAt = Date.now();
      if (receipt.issuedAt < notBefore || completedAt < receipt.issuedAt || completedAt >= approvedUntil) reject();
      db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY CHECK(id=1), operation_id TEXT NOT NULL UNIQUE,
        state_sha256 TEXT NOT NULL, recipient_sha256 TEXT NOT NULL, envelope TEXT NOT NULL)`);
      db.prepare(`INSERT INTO ${table} VALUES (1,?,?,?,?)`).run(operationId, expectedStateSha256, recipientSha256, JSON.stringify(sealed));
      return sealed;
    } finally { for (const account of accounts) account.password = ''; }
  }).immediate();
}

export function retrieveSecondCohort(request, database) {
  assertUatEnvironment();
  const input = { ...request };
  validate(input);
  const recipient = fingerprint(input.publicKey);
  const db = checkedDatabase(database);
  if (!exists(db, table)) reject();
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=1`).get();
  if (!row || row.operation_id !== input.operationId || row.state_sha256 !== input.expectedStateSha256 || row.recipient_sha256 !== recipient) reject();
  const envelope = JSON.parse(row.envelope);
  if (envelope.schema !== 'bubblewash-uat-handover/v1' || envelope.recipientSha256 !== recipient) reject();
  // Recovery never invokes issuance and does not require the state/window still
  // to match. Recipient must verify the encrypted operation binding on decryption.
  return envelope;
}
