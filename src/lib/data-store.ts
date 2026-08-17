import "server-only";

import { env } from "cloudflare:workers";
import { LIVE_LOCATION_EXPIRES_AFTER_MS, type StoredDriverLocation } from "./dispatch-location.ts";
import type { SubmissionRecord } from "@/lib/submissions";

type StoredSubmissionRow = { id: string; created_at: string; source: string | null; data: string };
type RateLimitRow = { key: string; count: number; reset_at: number };
type StoredDriverLocationRow = {
  driver_id: string;
  order_id: string;
  latitude: number;
  longitude: number;
  accuracy_meters: number;
  captured_at: string;
  received_at: string;
};

export type EarlyAccessSignup = {
  id: string;
  firstName: string;
  phone: string;
  email: string;
  area: string;
  frequency: string;
  consentAt: string;
  consentVersion: string;
  marketingStatus: "active" | "opted_out";
  createdAt: string;
  updatedAt: string;
};

export type PrivacyRequest = {
  id: string;
  requestType: "access" | "correction" | "deletion" | "marketing_opt_out";
  name: string;
  contact: string;
  orderId: string;
  status: "received" | "identity_review" | "completed" | "declined";
  createdAt: string;
  updatedAt: string;
};

export type NotificationOutboxRecord = {
  id: string;
  dedupeKey: string;
  channel: "email" | "whatsapp";
  target: "customer" | "operations";
  payload: Record<string, unknown>;
  status: "pending" | "sent" | "failed" | "skipped";
  attempts: number;
  nextAttemptAt: string;
  providerId: string;
  lastError: string;
  createdAt: string;
  updatedAt: string;
  sentAt: string;
};

type StoredEarlyAccessRow = {
  id: string;
  first_name: string;
  phone: string;
  email: string | null;
  area: string;
  frequency: string;
  consent_at: string;
  consent_version: string;
  marketing_status: "active" | "opted_out";
  created_at: string;
  updated_at: string;
};

type StoredPrivacyRequestRow = {
  id: string;
  request_type: PrivacyRequest["requestType"];
  name: string;
  contact: string;
  order_id: string | null;
  status: PrivacyRequest["status"];
  created_at: string;
  updated_at: string;
};

type StoredOutboxRow = {
  id: string;
  dedupe_key: string;
  channel: NotificationOutboxRecord["channel"];
  target: NotificationOutboxRecord["target"];
  payload: string;
  status: NotificationOutboxRecord["status"];
  attempts: number;
  next_attempt_at: string;
  provider_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
};

export function getDatabase(): D1Database {
  return env.DB;
}

function submissionFromRow(row: StoredSubmissionRow): SubmissionRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    source: row.source ?? undefined,
    data: JSON.parse(row.data) as Record<string, unknown>,
  };
}

export async function appendSubmissionRecord(record: SubmissionRecord) {
  await getDatabase().prepare("INSERT INTO submissions (id, created_at, source, data) VALUES (?, ?, ?, ?)")
    .bind(record.id, record.createdAt, record.source ?? null, JSON.stringify(record.data)).run();
}

export async function appendSubmissionRecordWithDeliveryProof(
  record: SubmissionRecord,
  input: { orderId: string; codeHash: string; usedBy: string; recipientName: string },
) {
  const db = getDatabase();
  const results = await db.batch([
    db.prepare(`
      UPDATE delivery_proofs SET used_at = ?, used_by = ?, recipient_name = ?
      WHERE order_id = ? COLLATE NOCASE AND code_hash = ? AND used_at IS NULL
    `).bind(record.createdAt, input.usedBy, input.recipientName, input.orderId, input.codeHash),
    db.prepare(`
      INSERT INTO submissions (id, created_at, source, data)
      SELECT ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM delivery_proofs
        WHERE order_id = ? COLLATE NOCASE AND code_hash = ? AND used_at = ?
      )
    `).bind(record.id, record.createdAt, record.source ?? null, JSON.stringify(record.data), input.orderId, input.codeHash, record.createdAt),
  ]);
  if ((results[0].meta.changes ?? 0) !== 1 || (results[1].meta.changes ?? 0) !== 1) {
    throw new Error("Delivery confirmation code is invalid or already used.");
  }
}

export async function readSubmissionRecords(limit = 200): Promise<SubmissionRecord[]> {
  const result = await getDatabase().prepare(
    "SELECT id, created_at, source, data FROM submissions ORDER BY created_at DESC LIMIT ?",
  ).bind(Math.max(1, Math.min(limit, 500))).all<StoredSubmissionRow>();
  return result.results.map(submissionFromRow);
}

export async function readSubmissionRecordsForOrder(orderId: string): Promise<SubmissionRecord[]> {
  const normalized = orderId.trim();
  if (!normalized) return [];
  const result = await getDatabase().prepare(`
    SELECT id, created_at, source, data FROM submissions
    WHERE id = ? COLLATE NOCASE OR json_extract(data, '$.orderId') = ? COLLATE NOCASE
    ORDER BY created_at DESC
  `).bind(normalized, normalized).all<StoredSubmissionRow>();
  return result.results.map(submissionFromRow);
}

export async function findSubmissionRecordById(id: string): Promise<SubmissionRecord | null> {
  const row = await getDatabase().prepare(
    "SELECT id, created_at, source, data FROM submissions WHERE id = ? LIMIT 1",
  ).bind(id).first<StoredSubmissionRow>();
  return row ? submissionFromRow(row) : null;
}

export async function findCheckoutByPaymentReference(reference: string): Promise<SubmissionRecord | null> {
  const row = await getDatabase().prepare(`
    SELECT id, created_at, source, data FROM submissions
    WHERE json_extract(data, '$.submissionType') = 'checkout-request'
      AND json_extract(data, '$.paymentReference') = ?
    ORDER BY created_at ASC LIMIT 1
  `).bind(reference).first<StoredSubmissionRow>();
  return row ? submissionFromRow(row) : null;
}

export async function appendPaymentVerificationOnce(input: {
  record: SubmissionRecord;
  reference: string;
  status: string;
  transactionId?: string;
  amountMinor: number;
  currency: string;
}) {
  const inserted = await getDatabase().prepare(`
    INSERT OR IGNORE INTO payment_verifications
      (reference, status, transaction_id, amount_minor, currency, record_id, verified_at,
       submission_created_at, submission_source, submission_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING reference
  `).bind(
    input.reference,
    input.status,
    input.transactionId ?? null,
    input.amountMinor,
    input.currency,
    input.record.id,
    input.record.createdAt,
    input.record.createdAt,
    input.record.source ?? null,
    JSON.stringify(input.record.data),
  ).first<{ reference: string }>();
  return inserted?.reference === input.reference;
}

export async function claimWorkflowAction(input: { claimKey: string; orderId: string; actionKey: string; orderUpdatedAt: string }) {
  const result = await getDatabase().prepare(`
    INSERT OR IGNORE INTO workflow_action_claims
      (claim_key, order_id, action_key, order_updated_at, claimed_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(input.claimKey, input.orderId, input.actionKey, input.orderUpdatedAt, new Date().toISOString()).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function releaseWorkflowActionClaim(claimKey: string) {
  await getDatabase().prepare("DELETE FROM workflow_action_claims WHERE claim_key = ?").bind(claimKey).run();
}

export async function databaseReadiness() {
  const row = await getDatabase().prepare("SELECT 1 AS ok").first<{ ok: number }>();
  return row?.ok === 1;
}

export async function consumeRateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const resetAt = now + windowMs;
  const row = await getDatabase().prepare(`
    INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
      reset_at = CASE WHEN rate_limits.reset_at <= ? THEN excluded.reset_at ELSE rate_limits.reset_at END
    RETURNING key, count, reset_at
  `).bind(key, resetAt, now, now).first<RateLimitRow>();
  if (!row) throw new Error("Rate limit state was not returned.");
  return { limited: row.count > limit, remaining: Math.max(0, limit - row.count), resetAt: row.reset_at };
}

export async function issueLoginChallenge(nonce: string, email: string, expiresAt: number, createdAt = Date.now()) {
  const result = await getDatabase().prepare(`
    INSERT INTO login_challenges (nonce, email, expires_at, used_at, created_at)
    VALUES (?, ?, ?, NULL, ?)
  `).bind(nonce, email, expiresAt, createdAt).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function claimLoginChallenge(nonce: string, email: string, now = Date.now()) {
  const result = await getDatabase().prepare(`
    UPDATE login_challenges SET used_at = ?
    WHERE nonce = ? AND email = ? COLLATE NOCASE
      AND used_at IS NULL AND expires_at >= ?
  `).bind(now, nonce, email, now).run();
  return (result.meta.changes ?? 0) === 1;
}

function earlyAccessFromRow(row: StoredEarlyAccessRow): EarlyAccessSignup {
  return {
    id: row.id,
    firstName: row.first_name,
    phone: row.phone,
    email: row.email ?? "",
    area: row.area,
    frequency: row.frequency,
    consentAt: row.consent_at,
    consentVersion: row.consent_version,
    marketingStatus: row.marketing_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function upsertEarlyAccessSignup(input: Omit<EarlyAccessSignup, "createdAt" | "updatedAt" | "marketingStatus">) {
  const db = getDatabase();
  const existing = await db.prepare("SELECT id FROM early_access_signups WHERE phone = ? LIMIT 1")
    .bind(input.phone).first<{ id: string }>();
  const now = new Date().toISOString();
  const row = await db.prepare(`
    INSERT INTO early_access_signups
      (id, first_name, phone, email, area, frequency, consent_at, consent_version, marketing_status, created_at, updated_at)
    VALUES (?, ?, ?, NULLIF(?, ''), ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(phone) DO UPDATE SET first_name = excluded.first_name, email = excluded.email,
      area = excluded.area, frequency = excluded.frequency, consent_at = excluded.consent_at,
      consent_version = excluded.consent_version, marketing_status = 'active', updated_at = excluded.updated_at
    RETURNING *
  `).bind(input.id, input.firstName, input.phone, input.email, input.area, input.frequency, input.consentAt, input.consentVersion, now, now)
    .first<StoredEarlyAccessRow>();
  if (!row) throw new Error("Early-access signup was not stored.");
  return { signup: earlyAccessFromRow(row), updated: Boolean(existing) };
}

export async function optOutEarlyAccess(contact: string) {
  const normalized = contact.trim().toLowerCase();
  if (!normalized) return 0;
  const result = await getDatabase().prepare(`
    UPDATE early_access_signups SET marketing_status = 'opted_out', updated_at = ?
    WHERE lower(phone) = ? OR lower(COALESCE(email, '')) = ?
  `).bind(new Date().toISOString(), normalized, normalized).run();
  return result.meta.changes ?? 0;
}

function privacyRequestFromRow(row: StoredPrivacyRequestRow): PrivacyRequest {
  return {
    id: row.id,
    requestType: row.request_type,
    name: row.name,
    contact: row.contact,
    orderId: row.order_id ?? "",
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createPrivacyRequest(input: Omit<PrivacyRequest, "status" | "createdAt" | "updatedAt">) {
  const now = new Date().toISOString();
  const row = await getDatabase().prepare(`
    INSERT INTO privacy_requests (id, request_type, name, contact, order_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULLIF(?, ''), 'received', ?, ?) RETURNING *
  `).bind(input.id, input.requestType, input.name, input.contact, input.orderId, now, now).first<StoredPrivacyRequestRow>();
  if (!row) throw new Error("Privacy request was not stored.");
  return privacyRequestFromRow(row);
}

function outboxFromRow(row: StoredOutboxRow): NotificationOutboxRecord {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    channel: row.channel,
    target: row.target,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    providerId: row.provider_id ?? "",
    lastError: row.last_error ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at ?? "",
  };
}

export async function enqueueNotification(input: Pick<NotificationOutboxRecord, "id" | "dedupeKey" | "channel" | "target" | "payload">) {
  const now = new Date().toISOString();
  const row = await getDatabase().prepare(`
    INSERT INTO notification_outbox
      (id, dedupe_key, channel, target, payload, status, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key = excluded.dedupe_key RETURNING *
  `).bind(input.id, input.dedupeKey, input.channel, input.target, JSON.stringify(input.payload), now, now, now).first<StoredOutboxRow>();
  if (!row) throw new Error("Notification was not queued.");
  return outboxFromRow(row);
}

export async function readDueNotifications(limit = 20) {
  const result = await getDatabase().prepare(`
    SELECT * FROM notification_outbox
    WHERE status IN ('pending', 'failed') AND next_attempt_at <= ? AND attempts < 8
    ORDER BY created_at ASC LIMIT ?
  `).bind(new Date().toISOString(), Math.max(1, Math.min(limit, 100))).all<StoredOutboxRow>();
  return result.results.map(outboxFromRow);
}

export async function updateNotificationDelivery(input: {
  id: string;
  status: "sent" | "failed" | "skipped";
  providerId?: string;
  error?: string;
  retryAfterMs?: number;
}) {
  const now = new Date();
  await getDatabase().prepare(`
    UPDATE notification_outbox
    SET status = ?, attempts = attempts + 1, next_attempt_at = ?, provider_id = NULLIF(?, ''),
        last_error = NULLIF(?, ''), updated_at = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END
    WHERE id = ?
  `).bind(
    input.status,
    new Date(now.getTime() + (input.retryAfterMs ?? 0)).toISOString(),
    input.providerId ?? "",
    input.error?.slice(0, 500) ?? "",
    now.toISOString(),
    input.status,
    now.toISOString(),
    input.id,
  ).run();
}

export async function notificationOutboxMetrics() {
  return await getDatabase().prepare(`
    SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent
    FROM notification_outbox
  `).first<{ pending: number | null; failed: number | null; sent: number | null }>() ?? { pending: 0, failed: 0, sent: 0 };
}

export async function operationsDataMetrics() {
  const db = getDatabase();
  const [submissions, earlyAccess, privacy, outbox] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS total FROM submissions").first<{ total: number }>(),
    db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN marketing_status = 'active' THEN 1 ELSE 0 END) AS active FROM early_access_signups")
      .first<{ total: number; active: number | null }>(),
    db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('received', 'identity_review') THEN 1 ELSE 0 END) AS open FROM privacy_requests")
      .first<{ total: number; open: number | null }>(),
    notificationOutboxMetrics(),
  ]);
  return {
    submissions: submissions?.total ?? 0,
    earlyAccess: { total: earlyAccess?.total ?? 0, active: earlyAccess?.active ?? 0 },
    privacyRequests: { total: privacy?.total ?? 0, open: privacy?.open ?? 0 },
    notifications: { pending: outbox.pending ?? 0, failed: outbox.failed ?? 0, sent: outbox.sent ?? 0 },
  };
}

export async function listPrivacyRequests(limit = 100) {
  const result = await getDatabase().prepare("SELECT * FROM privacy_requests ORDER BY created_at ASC LIMIT ?")
    .bind(Math.max(1, Math.min(limit, 250))).all<StoredPrivacyRequestRow>();
  return result.results.map(privacyRequestFromRow);
}

export async function updatePrivacyRequestStatus(id: string, status: PrivacyRequest["status"]) {
  const row = await getDatabase().prepare(
    "UPDATE privacy_requests SET status = ?, updated_at = ? WHERE id = ? RETURNING *",
  ).bind(status, new Date().toISOString(), id).first<StoredPrivacyRequestRow>();
  return row ? privacyRequestFromRow(row) : null;
}

export async function purgeOperationalData(now = Date.now(), householdLaunchDate = process.env.BUBBLEWASH_HOUSEHOLD_LAUNCH_DATE ?? "") {
  const db = getDatabase();
  const isoDaysAgo = (days: number) => new Date(now - days * 24 * 60 * 60_000).toISOString();
  const launch = /^\d{4}-\d{2}-\d{2}$/.test(householdLaunchDate) ? new Date(`${householdLaunchDate}T00:00:00.000Z`).getTime() : Number.NaN;
  const baseResults = await db.batch([
    db.prepare("DELETE FROM rate_limits WHERE reset_at < ?").bind(now - 24 * 60 * 60_000),
    db.prepare("DELETE FROM login_challenges WHERE expires_at < ? OR used_at < ?").bind(now, now - 24 * 60 * 60_000),
    db.prepare("DELETE FROM mfa_replay_guard WHERE accepted_at < ?").bind(isoDaysAgo(2)),
    db.prepare("DELETE FROM workflow_action_claims WHERE claimed_at < ?").bind(isoDaysAgo(90)),
    db.prepare("DELETE FROM notification_outbox WHERE updated_at < ?").bind(isoDaysAgo(90)),
    db.prepare("DELETE FROM early_access_signups WHERE marketing_status = 'opted_out' AND updated_at < ?").bind(isoDaysAgo(30)),
    Number.isFinite(launch) && now >= launch + 365 * 24 * 60 * 60_000
      ? db.prepare("DELETE FROM early_access_signups WHERE marketing_status = 'active' AND updated_at <= ?")
        .bind(new Date(launch + 365 * 24 * 60 * 60_000).toISOString())
      : db.prepare("DELETE FROM early_access_signups WHERE 0 = 1"),
    db.prepare("DELETE FROM privacy_requests WHERE status IN ('completed', 'declined') AND updated_at < ?").bind(isoDaysAgo(365 * 3)),
    db.prepare("DELETE FROM driver_live_locations WHERE captured_at < ?").bind(new Date(now - LIVE_LOCATION_EXPIRES_AFTER_MS).toISOString()),
  ]);
  const closed = await db.prepare(`
    SELECT DISTINCT json_extract(data, '$.orderId') AS orderId FROM submissions
    WHERE json_extract(data, '$.submissionType') = 'admin-operation'
      AND json_extract(data, '$.actionType') = 'Close order' AND created_at < ? LIMIT 50
  `).bind(isoDaysAgo(365 * 2)).all<{ orderId: string }>();
  let closedOrderRecords = 0;
  for (const row of closed.results) {
    if (!row.orderId) continue;
    const results = await db.batch([
      db.prepare("DELETE FROM driver_live_locations WHERE order_id = ? COLLATE NOCASE").bind(row.orderId),
      db.prepare("DELETE FROM workflow_action_claims WHERE order_id = ? COLLATE NOCASE").bind(row.orderId),
      db.prepare("DELETE FROM delivery_proofs WHERE order_id = ? COLLATE NOCASE").bind(row.orderId),
      db.prepare("DELETE FROM submissions WHERE id = ? COLLATE NOCASE OR json_extract(data, '$.orderId') = ? COLLATE NOCASE").bind(row.orderId, row.orderId),
    ]);
    closedOrderRecords += results[3].meta.changes ?? 0;
  }
  const orphaned = await db.prepare("DELETE FROM payment_verifications WHERE record_id NOT IN (SELECT id FROM submissions)").run();
  return {
    expiredRateLimits: baseResults[0].meta.changes ?? 0,
    loginChallenges: baseResults[1].meta.changes ?? 0,
    mfaReplayGuards: baseResults[2].meta.changes ?? 0,
    workflowClaims: baseResults[3].meta.changes ?? 0,
    notificationLogs: baseResults[4].meta.changes ?? 0,
    optedOutSignups: baseResults[5].meta.changes ?? 0,
    expiredActiveSignups: baseResults[6].meta.changes ?? 0,
    privacyRequestLogs: baseResults[7].meta.changes ?? 0,
    expiredDriverLocations: baseResults[8].meta.changes ?? 0,
    closedOrderRecords,
    orphanedPaymentVerifications: orphaned.meta.changes ?? 0,
  };
}

export async function claimMfaTimestep(subject: string, timestep: number) {
  const result = await getDatabase().prepare(`
    INSERT INTO mfa_replay_guard (subject, timestep, accepted_at) VALUES (?, ?, ?)
    ON CONFLICT(subject) DO UPDATE SET timestep = excluded.timestep, accepted_at = excluded.accepted_at
    WHERE mfa_replay_guard.timestep < excluded.timestep
  `).bind(subject, timestep, new Date().toISOString()).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function storeDeliveryCode(orderId: string, codeHash: string) {
  const result = await getDatabase().prepare(`
    INSERT INTO delivery_proofs (order_id, code_hash, created_at) VALUES (?, ?, ?)
    ON CONFLICT(order_id) DO NOTHING
  `).bind(orderId, codeHash, new Date().toISOString()).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function deliveryCodeRecord(orderId: string) {
  return await getDatabase().prepare(`
    SELECT order_id AS orderId, code_hash AS codeHash, created_at AS createdAt,
           COALESCE(used_at, '') AS usedAt, COALESCE(used_by, '') AS usedBy,
           COALESCE(recipient_name, '') AS recipientName
    FROM delivery_proofs WHERE order_id = ? COLLATE NOCASE LIMIT 1
  `).bind(orderId).first<{ orderId: string; codeHash: string; createdAt: string; usedAt: string; usedBy: string; recipientName: string }>();
}

export async function consumeDeliveryCode(orderId: string, codeHash: string, usedBy: string, recipientName: string) {
  const result = await getDatabase().prepare(`
    UPDATE delivery_proofs SET used_at = ?, used_by = ?, recipient_name = ?
    WHERE order_id = ? COLLATE NOCASE AND code_hash = ? AND used_at IS NULL
  `).bind(new Date().toISOString(), usedBy, recipientName, orderId, codeHash).run();
  return (result.meta.changes ?? 0) === 1;
}

function driverLocationFromRow(row: StoredDriverLocationRow): StoredDriverLocation {
  return {
    driverId: row.driver_id,
    orderId: row.order_id,
    latitude: row.latitude,
    longitude: row.longitude,
    accuracyMeters: row.accuracy_meters,
    capturedAt: row.captured_at,
    receivedAt: row.received_at,
  };
}

export async function upsertDriverLiveLocation(location: StoredDriverLocation) {
  const result = await getDatabase().prepare(`
    INSERT INTO driver_live_locations
      (driver_id, order_id, latitude, longitude, accuracy_meters, captured_at, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(driver_id) DO UPDATE SET order_id = excluded.order_id, latitude = excluded.latitude,
      longitude = excluded.longitude, accuracy_meters = excluded.accuracy_meters,
      captured_at = excluded.captured_at, received_at = excluded.received_at
    WHERE driver_live_locations.captured_at < excluded.captured_at
  `).bind(location.driverId, location.orderId, location.latitude, location.longitude, location.accuracyMeters, location.capturedAt, location.receivedAt).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function readDriverLiveLocation(driverId: string): Promise<StoredDriverLocation | null> {
  const row = await getDatabase().prepare(`
    SELECT driver_id, order_id, latitude, longitude, accuracy_meters, captured_at, received_at
    FROM driver_live_locations WHERE driver_id = ? COLLATE NOCASE AND captured_at >= ? LIMIT 1
  `).bind(driverId.trim(), new Date(Date.now() - LIVE_LOCATION_EXPIRES_AFTER_MS).toISOString()).first<StoredDriverLocationRow>();
  return row ? driverLocationFromRow(row) : null;
}

export async function readDriverLiveLocations(): Promise<StoredDriverLocation[]> {
  const result = await getDatabase().prepare(`
    SELECT driver_id, order_id, latitude, longitude, accuracy_meters, captured_at, received_at
    FROM driver_live_locations WHERE captured_at >= ? ORDER BY captured_at DESC
  `).bind(new Date(Date.now() - LIVE_LOCATION_EXPIRES_AFTER_MS).toISOString()).all<StoredDriverLocationRow>();
  return result.results.map(driverLocationFromRow);
}

export async function deleteDriverLiveLocation(driverId: string) {
  const result = await getDatabase().prepare("DELETE FROM driver_live_locations WHERE driver_id = ? COLLATE NOCASE")
    .bind(driverId.trim()).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function deleteExpiredDriverLiveLocations(capturedBefore: string) {
  const result = await getDatabase().prepare("DELETE FROM driver_live_locations WHERE captured_at < ?").bind(capturedBefore).run();
  return result.meta.changes ?? 0;
}

export async function resetDataStoreForTests() {
  const db = getDatabase();
  await db.batch([
    "submissions", "rate_limits", "workflow_action_claims", "payment_verifications",
    "driver_live_locations", "early_access_signups", "privacy_requests", "notification_outbox",
    "mfa_replay_guard", "delivery_proofs", "migration_imports", "login_challenges",
  ].map((table) => db.prepare(`DELETE FROM ${table}`)));
}
