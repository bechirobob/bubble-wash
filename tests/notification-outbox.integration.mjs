import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';

const directory = mkdtempSync(path.join(tmpdir(), 'bubblewash-notifications-'));
process.env.BUBBLEWASH_DATABASE_PATH = path.join(directory, 'isolated.sqlite');
// Seed the previously deployed schema to verify a non-destructive upgrade.
const legacy = new Database(process.env.BUBBLEWASH_DATABASE_PATH);
legacy.exec(`CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  target TEXT NOT NULL CHECK (target IN ('customer', 'operations')),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
  provider_id TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sent_at TEXT
);
INSERT INTO notification_outbox
  (id, dedupe_key, channel, target, payload, status, attempts, next_attempt_at, created_at, updated_at)
VALUES ('legacy-failed', 'legacy-failed', 'email', 'customer', '{}', 'failed', 1, '2026-01-01', '2026-01-01', '2026-01-01'),
       ('legacy-sent', 'legacy-sent', 'email', 'customer', '{}', 'sent', 1, '2026-01-01', '2026-01-01', '2026-01-01'),
       ('legacy-pending', 'legacy-pending', 'email', 'customer', '{}', 'pending', 0, '2026-01-01', '2026-01-01', '2026-01-01');`);
legacy.close();

// A network escape is never permitted by this suite.
globalThis.fetch = async () => { throw new Error('Unexpected provider request'); };
const store = await import('../src/lib/data-store.ts');
const notifications = await import('../src/lib/notifications.ts');
const policy = await import('../src/lib/notification-policy.ts');
const migratedFailed = store.readNotification('legacy-failed');
const migratedSent = store.readNotification('legacy-sent');
const migratedPending = store.readNotification('legacy-pending');
const db = store.getDatabase();
let calls = [];

beforeEach(() => {
  db.prepare('DELETE FROM notification_outbox').run();
  calls = [];
  Object.assign(process.env, {
    NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED: 'true',
    RESEND_API_KEY: 'mock_resend_not_a_real_credential',
    BUBBLEWASH_EMAIL_FROM: 'Bubble Wash <mock@example.invalid>',
    WHATSAPP_ACCESS_TOKEN: 'mock_whatsapp_not_a_real_credential',
    WHATSAPP_PHONE_NUMBER_ID: 'mock-phone',
    WHATSAPP_API_VERSION: 'v23.0',
    WHATSAPP_PRIVACY_TEMPLATE: 'mock_privacy',
    WHATSAPP_EARLY_ACCESS_TEMPLATE: 'mock_early_access',
    WHATSAPP_OPERATIONS_TEMPLATE: 'mock_operations',
  });
  globalThis.fetch = async (url, init) => {
    calls.push({ url, ...init });
    return Response.json(url.includes('resend') ? { id: 'mock-accepted-email' } : { messages: [{ id: 'mock-accepted-whatsapp' }] });
  };
});
after(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function enqueue(channel = 'email', purpose = 'privacy', dedupeKey = randomUUID()) {
  return store.enqueueNotification({ id: `NQ-${randomUUID()}`, dedupeKey, channel, target: 'customer',
    payload: { toEmail: 'mock@example.invalid', toWhatsApp: '233550000000', subject: 'Mock only', text: 'Never sent to a real provider.', purpose } });
}
function due(id) {
  db.prepare("UPDATE notification_outbox SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);
}
function attemptInput(record, now = Date.now()) {
  const providerRequest = JSON.stringify({ url: record.channel === 'email' ? 'https://api.resend.com/emails' : 'https://graph.facebook.com/v23.0/mock-phone/messages', body: '{}' });
  return { id: record.id, leaseToken: record.leaseToken, providerRequest,
    idempotencyKey: record.channel === 'email' ? 'mock-stable-key' : '',
    accountHash: createHash('sha256').update(record.channel === 'email' ? process.env.RESEND_API_KEY : `${process.env.WHATSAPP_ACCESS_TOKEN}:${process.env.WHATSAPP_PHONE_NUMBER_ID}`).digest('hex'), now };
}

// No simulated result, including an HTTP 200, is delivery evidence.
test('legacy migration preserves rows and quarantines unprotected prior attempts', () => {
  assert.equal(migratedFailed.deliveryState, 'manual_review');
  assert.match(migratedFailed.lastError, /Legacy outbox row/);
  assert.equal(migratedPending.deliveryState, 'manual_review', 'legacy worker may have sent before recording an attempt');
  assert.equal(migratedPending.status, 'failed');
  assert.equal(migratedSent.deliveryState, 'accepted');
  assert.equal(migratedSent.status, 'sent');
});

test('provider acceptance is distinct from delivery, and duplicates stay immutable', async () => {
  const row = enqueue();
  const [result] = await notifications.processNotificationOutbox();
  assert.equal(result.status, 'accepted');
  assert.equal(result.sent, true);
  assert.equal(result.accepted, true);
  assert.equal(result.delivered, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].headers['Idempotency-Key'], /^bubblewash\/[a-f0-9]{64}$/);
  const duplicate = store.enqueueNotification({ ...row, id: 'different-id', payload: { text: 'Attempted replacement' } });
  assert.equal(duplicate.id, row.id);
  assert.deepEqual(duplicate.payload, row.payload);
  assert.deepEqual(await notifications.processNotificationOutbox(), []);
  assert.equal(calls.length, 1);
  assert.equal(store.readNotification(row.id).attempts, 1);
  assert.match(notifications.notificationSummary([result]), /accepted by the provider \(delivery not confirmed\)/);
  assert.equal(notifications.notificationOutboxSummary().delivered, 0);
});

test('two concurrent workers in separate processes only submit one request', async () => {
  const row = enqueue();
  const workers = [0, 1].map(() => fork(path.join(process.cwd(), 'tests/helpers/notification-outbox-worker.mjs'), [], {
    env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    execArgv: ['--conditions=react-server', '--experimental-strip-types', '--experimental-loader=./tests/alias-loader.mjs'],
  }));
  try {
    await Promise.all(workers.map(async (worker) => {
      const [message] = await once(worker, 'message');
      assert.equal(message.ready, true);
    }));
    const completed = workers.map(async (worker) => {
      const [message] = await once(worker, 'message');
      assert.equal(message.error, undefined);
      return message;
    });
    for (const worker of workers) worker.send('start');
    const results = await Promise.all(completed);
    assert.equal(results.reduce((count, result) => count + result.calls, 0), 1);
    assert.equal(results.reduce((count, result) => count + result.results.length, 0), 1);
    assert.equal(store.readNotification(row.id).deliveryState, 'accepted');
    assert.equal(store.readNotification(row.id).attempts, 1);
  } finally {
    for (const worker of workers) worker.kill();
  }
});

test('timeout after possible email acceptance reuses exact payload/key, despite config changes', async () => {
  const row = enqueue();
  globalThis.fetch = async (url, init) => {
    calls.push({ url, ...init });
    if (calls.length === 1) throw new DOMException('Provider may have accepted', 'TimeoutError');
    return Response.json({ id: 'mock-same-accepted-message' });
  };
  const [initial] = await notifications.processNotificationOutbox(1);
  assert.equal(initial.status, 'retrying');
  assert.equal(initial.sent, false);
  assert.equal(store.readNotification(row.id).attempts, 1);
  assert.deepEqual(await notifications.processNotificationOutbox(), [], 'backoff is respected');
  process.env.BUBBLEWASH_EMAIL_FROM = 'Changed <changed@example.invalid>';
  due(row.id);
  const [retry] = await notifications.processNotificationOutbox();
  assert.equal(retry.status, 'accepted');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body, calls[0].body);
  assert.equal(calls[1].headers['Idempotency-Key'], calls[0].headers['Idempotency-Key']);
  assert.equal(store.readNotification(row.id).attempts, 2);
});

test('uncertain WhatsApp timeout requires manual review and never blindly replays', async () => {
  const row = enqueue('whatsapp');
  globalThis.fetch = async () => { calls.push({}); throw new DOMException('Timed out', 'TimeoutError'); };
  const [result] = await notifications.processNotificationOutbox();
  assert.equal(result.status, 'manual_review');
  assert.equal(result.manualFollowUp, true);
  assert.equal(result.accepted, false);
  due(row.id);
  assert.deepEqual(await notifications.processNotificationOutbox(), []);
  assert.equal(calls.length, 1);
  assert.equal(store.readNotification(row.id).attempts, 1);
});

test('a crashed lease before a provider attempt is recoverable for either channel', () => {
  for (const channel of ['email', 'whatsapp']) {
    const row = enqueue(channel);
    const now = Date.now();
    const first = store.claimNotification({ id: row.id, now });
    const second = store.claimNotification({ id: row.id, now: now + policy.NOTIFICATION_LEASE_MS + 1 });
    assert.notEqual(second.leaseToken, first.leaseToken);
    assert.equal(second.attempts, 0);
  }
});

test('crashed email after beginning a request can be reclaimed; stale worker cannot settle it', () => {
  const row = enqueue();
  const now = Date.now();
  const first = store.claimNotification({ id: row.id, now });
  const firstAttempt = store.beginNotificationAttempt(attemptInput(first, now));
  assert.equal(firstAttempt.attempts, 1);
  assert.equal(store.beginNotificationAttempt(attemptInput(first, now)), null, 'one attempt per lease');
  assert.equal(store.claimNotification({ id: row.id, now: now + 1 }), null, 'live lease excludes another worker');
  const later = now + policy.NOTIFICATION_LEASE_MS + 1;
  const second = store.claimNotification({ id: row.id, now: later });
  assert.notEqual(second.leaseToken, first.leaseToken);
  assert.equal(second.providerIdempotencyKey, firstAttempt.providerIdempotencyKey);
  assert.equal(store.updateNotificationDelivery({ id: row.id, leaseToken: first.leaseToken, status: 'accepted', providerId: 'stale-result', now: later }), false);
  assert.equal(store.readNotification(row.id).deliveryState, 'processing');
  assert.equal(store.beginNotificationAttempt(attemptInput(second, later)).attempts, 2);
  assert.equal(store.updateNotificationDelivery({ id: row.id, leaseToken: second.leaseToken, status: 'accepted', providerId: 'current-result', now: later }), true);
  assert.equal(store.readNotification(row.id).providerId, 'current-result');
});

test('crashed WhatsApp after possible submission is quarantined, not reclaimed', () => {
  const row = enqueue('whatsapp');
  const now = Date.now();
  const first = store.claimNotification({ id: row.id, now });
  store.beginNotificationAttempt(attemptInput(first, now));
  assert.equal(store.claimNotification({ id: row.id, now: now + policy.NOTIFICATION_LEASE_MS + 1 }), null);
  assert.equal(store.readNotification(row.id).deliveryState, 'manual_review');
  assert.equal(store.readNotification(row.id).attempts, 1);
});

test('email retry cannot cross the provider 24-hour idempotency window', async () => {
  const row = enqueue();
  const now = Date.now();
  const first = store.claimNotification({ id: row.id, now });
  store.beginNotificationAttempt(attemptInput(first, now));
  assert.equal(store.claimNotification({ id: row.id, now: now + 24 * 60 * 60_000 }), null);
  assert.equal(store.readNotification(row.id).deliveryState, 'manual_review');
  assert.deepEqual(await notifications.processNotificationOutbox(), []);
  assert.equal(calls.length, 0);
});

test('retry scheduling and pre-send guard stop at the conservative window boundary', () => {
  const row = enqueue();
  const now = Date.now();
  const first = store.claimNotification({ id: row.id, now });
  store.beginNotificationAttempt(attemptInput(first, now));
  store.updateNotificationDelivery({ id: row.id, leaseToken: first.leaseToken, status: 'uncertain', now,
    retryAfterMs: policy.RESEND_SAFE_RETRY_WINDOW_MS });
  assert.equal(store.readNotification(row.id).deliveryState, 'manual_review');
  const another = enqueue();
  due(another.id);
  const claimed = store.claimNotification({ id: another.id, now });
  db.prepare('UPDATE notification_outbox SET first_attempt_at = ? WHERE id = ?')
    .run(new Date(now - policy.RESEND_SAFE_RETRY_WINDOW_MS).toISOString(), another.id);
  assert.equal(store.beginNotificationAttempt(attemptInput(claimed, now)), null);
});

test('retryable explicit rejections stop after exactly eight attempts', async () => {
  const row = enqueue();
  globalThis.fetch = async () => { calls.push({}); return Response.json({ message: 'Rate limit' }, { status: 429 }); };
  for (let index = 0; index < policy.NOTIFICATION_MAX_ATTEMPTS; index += 1) {
    due(row.id);
    const [result] = await notifications.processNotificationOutbox(1);
    assert.equal(result.status, index === policy.NOTIFICATION_MAX_ATTEMPTS - 1 ? 'exhausted' : 'retrying');
  }
  due(row.id);
  assert.deepEqual(await notifications.processNotificationOutbox(), []);
  assert.equal(calls.length, policy.NOTIFICATION_MAX_ATTEMPTS);
  assert.equal(store.readNotification(row.id).attempts, policy.NOTIFICATION_MAX_ATTEMPTS);
  assert.equal(notifications.notificationOutboxSummary().exhausted, 1);
  assert.equal(notifications.notificationOutboxSummary().manualFollowUp, 1);
});

test('uncertain email at the attempt bound becomes manual review, not a safe failure claim', async () => {
  const row = enqueue();
  globalThis.fetch = async () => { calls.push({}); throw new TypeError('Mock connection lost'); };
  for (let index = 0; index < policy.NOTIFICATION_MAX_ATTEMPTS; index += 1) {
    due(row.id);
    await notifications.processNotificationOutbox(1);
  }
  assert.equal(store.readNotification(row.id).deliveryState, 'manual_review');
  due(row.id);
  assert.deepEqual(await notifications.processNotificationOutbox(), []);
  assert.equal(calls.length, 8);
});

test('feature off blocks both newly queued and previously queued commercial sends', async () => {
  const row = enqueue('email', 'operations');
  process.env.NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED = 'false';
  assert.deepEqual(await notifications.processNotificationOutbox(), []);
  const results = notifications.queueSubmissionNotifications({ id: 'BW-FEATURE-OFF', createdAt: new Date().toISOString(), data: { submissionType: 'pickup-booking' } });
  assert.equal(results[0].manualFollowUp, true);
  assert.equal(store.readNotification(row.id).attempts, 0);
  assert.equal(store.readNotification(row.id).deliveryState, 'queued');
  assert.equal(store.notificationOutboxMetrics().pending, 1);
  assert.equal(calls.length, 0);
  assert.match(notifications.notificationSummary(results), /Manual customer follow-up/);
});

test('existing privacy and early-access exceptions remain available with commercial gate off', async () => {
  process.env.NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED = 'false';
  enqueue('email', 'privacy');
  enqueue('whatsapp', 'early_access');
  const results = await notifications.processNotificationOutbox();
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.accepted && !result.delivered));
  assert.equal(calls.length, 2);
});

test('immediate dispatch duplicate respects backoff and does not bypass failed attempt bounds', async () => {
  globalThis.fetch = async () => { calls.push({}); throw new TypeError('Mock lost response'); };
  const input = { id: 'PR-MOCK', name: 'Test', contact: 'mock@example.invalid', requestType: 'access' };
  const [first] = await notifications.dispatchPrivacyRequestConfirmation(input);
  const [second] = await notifications.dispatchPrivacyRequestConfirmation(input);
  assert.equal(first.status, 'retrying');
  assert.equal(second.status, 'retrying');
  assert.equal(calls.length, 1);
});

test('missing configuration is skipped with follow-up, not falsely queued or attempted', async () => {
  delete process.env.RESEND_API_KEY;
  const row = enqueue();
  const [result] = await notifications.processNotificationOutbox();
  assert.equal(result.status, 'skipped');
  assert.equal(result.queued, false);
  assert.equal(result.manualFollowUp, true);
  assert.equal(store.readNotification(row.id).attempts, 0);
  assert.equal(calls.length, 0);
  assert.equal(notifications.notificationOutboxSummary().skipped, 1);
});

test('credential change cannot silently move a deduped retry to a different provider account', async () => {
  const row = enqueue();
  globalThis.fetch = async () => { calls.push({}); throw new TypeError('Mock lost response'); };
  await notifications.processNotificationOutbox();
  process.env.RESEND_API_KEY = 'different_mock_account_key';
  due(row.id);
  const [result] = await notifications.processNotificationOutbox();
  assert.equal(result.status, 'manual_review');
  assert.equal(calls.length, 1);
  assert.match(result.error, /credentials changed/);
});

test('non-deduped provider success without ID and 5xx outcomes require manual review', async () => {
  for (const response of [Response.json({ ok: true }), Response.json({ error: { message: 'Internal error' } }, { status: 500 })]) {
    const row = enqueue('whatsapp');
    globalThis.fetch = async () => { calls.push({}); return response; };
    const [result] = await notifications.processNotificationOutbox();
    assert.equal(result.status, 'manual_review');
    assert.equal(result.accepted, false);
    assert.equal(store.readNotification(row.id).attempts, 1);
  }
  assert.equal(calls.length, 2);
});

test('permanent rejection requires review, without retry storm', async () => {
  const row = enqueue();
  globalThis.fetch = async () => { calls.push({}); return Response.json({ message: 'Invalid address' }, { status: 422 }); };
  const [result] = await notifications.processNotificationOutbox();
  assert.equal(result.status, 'manual_review');
  due(row.id);
  assert.deepEqual(await notifications.processNotificationOutbox(), []);
  assert.equal(calls.length, 1);
});

test('summary does not hide skipped, exhausted, or manual outcomes behind queued messages', () => {
  const base = { channel: 'email', target: 'customer', sent: false };
  const summary = notifications.notificationSummary([
    { ...base, queued: true, status: 'retrying' },
    { ...base, skipped: 'Missing contact', manualFollowUp: true },
    { ...base, exhausted: true, manualFollowUp: true },
    { ...base, status: 'manual_review', manualFollowUp: true },
  ]);
  assert.match(summary, /queued/);
  assert.match(summary, /1 skipped/);
  assert.match(summary, /1 exhausted retries/);
  assert.match(summary, /1 require manual review/);
});


test('provider acceptance requires a begun request and a provider message ID', () => {
  const row = enqueue();
  const claimed = store.claimNotification({ id: row.id });
  assert.equal(store.updateNotificationDelivery({ id: row.id, leaseToken: claimed.leaseToken, status: 'accepted', providerId: 'mock-unstarted' }), false);
  assert.equal(store.beginNotificationAttempt({ ...attemptInput(claimed), idempotencyKey: '' }), null);
  store.beginNotificationAttempt(attemptInput(claimed));
  assert.equal(store.updateNotificationDelivery({ id: row.id, leaseToken: claimed.leaseToken, status: 'accepted' }), false);
  assert.equal(store.readNotification(row.id).deliveryState, 'processing');
});

test('lease-expired late responses never overwrite terminal review state', async () => {
  const row = enqueue('whatsapp');
  globalThis.fetch = async () => {
    calls.push({});
    db.prepare("UPDATE notification_outbox SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(row.id);
    assert.deepEqual(await notifications.processNotificationOutbox(), []);
    return Response.json({ messages: [{ id: 'mock-late-acceptance' }] });
  };
  const [result] = await notifications.processNotificationOutbox();
  assert.equal(result.status, 'manual_review');
  assert.equal(result.accepted, false, 'stale worker cannot claim a recorded acceptance');
  assert.equal(calls.length, 1);
});


test('malformed provider errors are safely recorded without losing the lease outcome', async () => {
  enqueue();
  globalThis.fetch = async () => Response.json({ error: { message: { malformed: true } } }, { status: 422 });
  const [result] = await notifications.processNotificationOutbox();
  assert.equal(result.status, 'manual_review');
  assert.match(result.error, /HTTP 422/);
});
