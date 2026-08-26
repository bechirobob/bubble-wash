import "server-only";

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { LIVE_LOCATION_EXPIRES_AFTER_MS, type StoredDriverLocation } from "./dispatch-location.ts";
import type { SubmissionRecord } from "@/lib/submissions";

const dataDir = path.join(process.cwd(), "data");
const databasePath = process.env.BUBBLEWASH_DATABASE_PATH ?? path.join(dataDir, "bubblewash.sqlite");
const legacySubmissionsPath = path.join(dataDir, "submissions.jsonl");

type StoredSubmissionRow = {
  id: string;
  created_at: string;
  source: string | null;
  data: string;
};

type RateLimitRow = {
  key: string;
  count: number;
  reset_at: number;
};

type StoredPaymentRow = {
  reference: string;
  status: string;
  transaction_id: string | null;
  amount_minor: number;
  currency: string;
  record_id: string;
  verified_at: string;
};

export type AdminMfaSetting = {
  adminEmail: string;
  encryptedSecret: string;
  status: "pending" | "enrolled";
  expiresAt: string;
  recoveryBundleEncrypted: string;
  createdAt: string;
  updatedAt: string;
};

type StoredAdminMfaRow = {
  admin_email: string;
  encrypted_secret: string;
  status: AdminMfaSetting["status"];
  expires_at: string | null;
  recovery_bundle_encrypted: string | null;
  created_at: string;
  updated_at: string;
};

type StoredDriverLocationRow = {
  driver_id: string;
  order_id: string;
  latitude: number;
  longitude: number;
  accuracy_meters: number;
  captured_at: string;
  received_at: string;
};

export type StaffCredentialOverride = {
  role: "admin";
  login: string;
  passwordHash: string;
  credentialVersion: string;
  updatedAt: string;
};

type StoredStaffCredentialOverrideRow = {
  role: "admin";
  login: string;
  password_hash: string;
  credential_version: string;
  updated_at: string;
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

let database: Database.Database | null = null;
let migratedLegacyJsonl = false;
let lastLocationCleanupAt = 0;

function purgeExpiredDriverLocations(db: Database.Database, now = Date.now()) {
  if (now - lastLocationCleanupAt < 60_000) return;
  db.prepare("DELETE FROM driver_live_locations WHERE captured_at < ?")
    .run(new Date(now - LIVE_LOCATION_EXPIRES_AFTER_MS).toISOString());
  lastLocationCleanupAt = now;
}

function getDatabase() {
  if (database) {
    purgeExpiredDriverLocations(database);
    return database;
  }
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      source TEXT,
      data TEXT NOT NULL CHECK (json_valid(data))
    );
    CREATE INDEX IF NOT EXISTS idx_submissions_created_at ON submissions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_submissions_order_id ON submissions(json_extract(data, '$.orderId') COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limits_reset_at ON rate_limits(reset_at);

    CREATE TABLE IF NOT EXISTS workflow_action_claims (
      claim_key TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      action_key TEXT NOT NULL,
      order_updated_at TEXT NOT NULL,
      claimed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_action_claims_claimed_at ON workflow_action_claims(claimed_at);

    CREATE TABLE IF NOT EXISTS payment_verifications (
      reference TEXT NOT NULL,
      status TEXT NOT NULL,
      transaction_id TEXT,
      amount_minor INTEGER NOT NULL,
      currency TEXT NOT NULL,
      record_id TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      PRIMARY KEY (reference, status)
    );
    CREATE INDEX IF NOT EXISTS idx_payment_verifications_verified_at ON payment_verifications(verified_at DESC);

    CREATE TABLE IF NOT EXISTS driver_live_locations (
      driver_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      latitude REAL NOT NULL CHECK (latitude >= 5.45 AND latitude <= 5.95),
      longitude REAL NOT NULL CHECK (longitude >= -0.45 AND longitude <= 0.2),
      accuracy_meters REAL NOT NULL CHECK (accuracy_meters > 0 AND accuracy_meters <= 1000),
      captured_at TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_driver_live_locations_order_id ON driver_live_locations(order_id COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_driver_live_locations_captured_at ON driver_live_locations(captured_at);

    CREATE TABLE IF NOT EXISTS early_access_signups (
      id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      email TEXT,
      area TEXT NOT NULL,
      frequency TEXT NOT NULL,
      consent_at TEXT NOT NULL,
      consent_version TEXT NOT NULL,
      marketing_status TEXT NOT NULL DEFAULT 'active' CHECK (marketing_status IN ('active', 'opted_out')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_early_access_area ON early_access_signups(area COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_early_access_updated_at ON early_access_signups(updated_at DESC);

    CREATE TABLE IF NOT EXISTS privacy_requests (
      id TEXT PRIMARY KEY,
      request_type TEXT NOT NULL CHECK (request_type IN ('access', 'correction', 'deletion', 'marketing_opt_out')),
      name TEXT NOT NULL,
      contact TEXT NOT NULL,
      order_id TEXT,
      status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'identity_review', 'completed', 'declined')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_privacy_requests_status ON privacy_requests(status, created_at);

    CREATE TABLE IF NOT EXISTS notification_outbox (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
      target TEXT NOT NULL CHECK (target IN ('customer', 'operations')),
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      provider_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sent_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notification_outbox_due ON notification_outbox(status, next_attempt_at);

    CREATE TABLE IF NOT EXISTS mfa_replay_guard (
      subject TEXT PRIMARY KEY,
      timestep INTEGER NOT NULL,
      accepted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_mfa_settings (
      admin_email TEXT PRIMARY KEY COLLATE NOCASE,
      encrypted_secret TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'enrolled')),
      expires_at TEXT,
      recovery_bundle_encrypted TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_mfa_recovery_codes (
      admin_email TEXT NOT NULL COLLATE NOCASE,
      code_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      used_at TEXT,
      PRIMARY KEY (admin_email, code_hash),
      FOREIGN KEY (admin_email) REFERENCES admin_mfa_settings(admin_email) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_admin_mfa_recovery_unused ON admin_mfa_recovery_codes(admin_email, used_at);

    CREATE TABLE IF NOT EXISTS staff_credential_overrides (
      role TEXT PRIMARY KEY CHECK (role = 'admin'),
      login TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      credential_version TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_recovery_tokens (
      token_hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_recovery_tokens_expiry ON admin_recovery_tokens(expires_at, used_at);

    CREATE TABLE IF NOT EXISTS delivery_proofs (
      order_id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      used_at TEXT,
      used_by TEXT,
      recipient_name TEXT
    );
  `);
  database = db;
  purgeExpiredDriverLocations(db);
  migrateLegacySubmissions(db);
  return db;
}

function migrateLegacySubmissions(db: Database.Database) {
  if (migratedLegacyJsonl || !existsSync(legacySubmissionsPath)) return;
  const insert = db.prepare("INSERT OR IGNORE INTO submissions (id, created_at, source, data) VALUES (@id, @createdAt, @source, @data)");
  const migrate = db.transaction(() => {
    for (const line of readFileSync(legacySubmissionsPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as SubmissionRecord;
        if (!record.id || !record.createdAt || !record.data) continue;
        insert.run({ id: record.id, createdAt: record.createdAt, source: record.source ?? null, data: JSON.stringify(record.data) });
      } catch {
        // Skip malformed legacy pilot records instead of blocking startup.
      }
    }
  });
  migrate();
  renameSync(legacySubmissionsPath, `${legacySubmissionsPath}.migrated`);
  migratedLegacyJsonl = true;
}

export function appendSubmissionRecord(record: SubmissionRecord) {
  getDatabase()
    .prepare("INSERT INTO submissions (id, created_at, source, data) VALUES (@id, @createdAt, @source, @data)")
    .run({ id: record.id, createdAt: record.createdAt, source: record.source ?? null, data: JSON.stringify(record.data) });
}

export function appendSubmissionRecordWithDeliveryProof(record: SubmissionRecord, input: { orderId: string; codeHash: string; usedBy: string; recipientName: string }) {
  const db = getDatabase();
  const apply = db.transaction(() => {
    const proof = db.prepare(`
      UPDATE delivery_proofs
      SET used_at = @usedAt, used_by = @usedBy, recipient_name = @recipientName
      WHERE order_id = @orderId COLLATE NOCASE AND code_hash = @codeHash AND used_at IS NULL
    `).run({ ...input, usedAt: record.createdAt });
    if (proof.changes !== 1) throw new Error("Delivery confirmation code is invalid or already used.");
    db.prepare("INSERT INTO submissions (id, created_at, source, data) VALUES (@id, @createdAt, @source, @data)")
      .run({ id: record.id, createdAt: record.createdAt, source: record.source ?? null, data: JSON.stringify(record.data) });
  });
  apply();
}

export function readSubmissionRecords(limit = 200): SubmissionRecord[] {
  const rows = getDatabase()
    .prepare("SELECT id, created_at, source, data FROM submissions ORDER BY created_at DESC LIMIT ?")
    .all(limit) as StoredSubmissionRow[];

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    source: row.source ?? undefined,
    data: JSON.parse(row.data) as Record<string, unknown>,
  }));
}

export function readSubmissionRecordsForOrder(orderId: string): SubmissionRecord[] {
  const normalized = orderId.trim();
  if (!normalized) return [];
  const rows = getDatabase()
    .prepare(`
      SELECT id, created_at, source, data
      FROM submissions
      WHERE id = @orderId COLLATE NOCASE
         OR json_extract(data, '$.orderId') = @orderId COLLATE NOCASE
      ORDER BY created_at DESC
    `)
    .all({ orderId: normalized }) as StoredSubmissionRow[];

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    source: row.source ?? undefined,
    data: JSON.parse(row.data) as Record<string, unknown>,
  }));
}

export function findSubmissionRecordById(id: string): SubmissionRecord | null {
  const row = getDatabase()
    .prepare("SELECT id, created_at, source, data FROM submissions WHERE id = ? LIMIT 1")
    .get(id) as StoredSubmissionRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    source: row.source ?? undefined,
    data: JSON.parse(row.data) as Record<string, unknown>,
  };
}

export function findCheckoutByPaymentReference(reference: string): SubmissionRecord | null {
  const row = getDatabase()
    .prepare(`
      SELECT id, created_at, source, data
      FROM submissions
      WHERE json_extract(data, '$.submissionType') = 'checkout-request'
        AND json_extract(data, '$.paymentReference') = ?
      ORDER BY created_at ASC
      LIMIT 1
    `)
    .get(reference) as StoredSubmissionRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    source: row.source ?? undefined,
    data: JSON.parse(row.data) as Record<string, unknown>,
  };
}

export function appendPaymentVerificationOnce(input: {
  record: SubmissionRecord;
  reference: string;
  status: string;
  transactionId?: string;
  amountMinor: number;
  currency: string;
}) {
  const db = getDatabase();
  const save = db.transaction(() => {
    const verification: StoredPaymentRow = {
      reference: input.reference,
      status: input.status,
      transaction_id: input.transactionId ?? null,
      amount_minor: input.amountMinor,
      currency: input.currency,
      record_id: input.record.id,
      verified_at: input.record.createdAt,
    };
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO payment_verifications
        (reference, status, transaction_id, amount_minor, currency, record_id, verified_at)
      VALUES
        (@reference, @status, @transaction_id, @amount_minor, @currency, @record_id, @verified_at)
    `).run(verification);
    if (inserted.changes === 0) return false;
    db.prepare("INSERT INTO submissions (id, created_at, source, data) VALUES (@id, @createdAt, @source, @data)")
      .run({
        id: input.record.id,
        createdAt: input.record.createdAt,
        source: input.record.source ?? null,
        data: JSON.stringify(input.record.data),
      });
    return true;
  });
  return save.immediate();
}

export function claimWorkflowAction(input: {
  claimKey: string;
  orderId: string;
  actionKey: string;
  orderUpdatedAt: string;
}) {
  const claimedAt = new Date().toISOString();
  const result = getDatabase().prepare(`
    INSERT OR IGNORE INTO workflow_action_claims
      (claim_key, order_id, action_key, order_updated_at, claimed_at)
    VALUES
      (@claimKey, @orderId, @actionKey, @orderUpdatedAt, @claimedAt)
  `).run({ ...input, claimedAt });
  return result.changes === 1;
}

export function releaseWorkflowActionClaim(claimKey: string) {
  getDatabase().prepare("DELETE FROM workflow_action_claims WHERE claim_key = ?").run(claimKey);
}

export function databaseReadiness() {
  const db = getDatabase();
  const quickCheck = db.pragma("quick_check", { simple: true });
  const writable = db.prepare("SELECT 1 AS ok").get() as { ok?: number } | undefined;
  return quickCheck === "ok" && writable?.ok === 1;
}

export function consumeRateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const resetAt = now + windowMs;
  const db = getDatabase();
  const current = db.prepare(`
    INSERT INTO rate_limits (key, count, reset_at)
    VALUES (@key, 1, @resetAt)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN rate_limits.reset_at <= @now THEN 1 ELSE rate_limits.count + 1 END,
      reset_at = CASE WHEN rate_limits.reset_at <= @now THEN @resetAt ELSE rate_limits.reset_at END
    RETURNING key, count, reset_at
  `).get({ key, now, resetAt }) as RateLimitRow;
  return {
    limited: current.count > limit,
    remaining: Math.max(0, limit - current.count),
    resetAt: current.reset_at,
  };
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

export function upsertEarlyAccessSignup(input: Omit<EarlyAccessSignup, "createdAt" | "updatedAt" | "marketingStatus">) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT id FROM early_access_signups WHERE phone = ? LIMIT 1").get(input.phone) as { id: string } | undefined;
  const row = db.prepare(`
    INSERT INTO early_access_signups
      (id, first_name, phone, email, area, frequency, consent_at, consent_version, marketing_status, created_at, updated_at)
    VALUES
      (@id, @firstName, @phone, NULLIF(@email, ''), @area, @frequency, @consentAt, @consentVersion, 'active', @now, @now)
    ON CONFLICT(phone) DO UPDATE SET
      first_name = excluded.first_name,
      email = excluded.email,
      area = excluded.area,
      frequency = excluded.frequency,
      consent_at = excluded.consent_at,
      consent_version = excluded.consent_version,
      marketing_status = 'active',
      updated_at = excluded.updated_at
    RETURNING *
  `).get({ ...input, now }) as StoredEarlyAccessRow;
  return { signup: earlyAccessFromRow(row), updated: Boolean(existing) };
}

export function optOutEarlyAccess(contact: string) {
  const normalized = contact.trim().toLowerCase();
  if (!normalized) return 0;
  return getDatabase().prepare(`
    UPDATE early_access_signups
    SET marketing_status = 'opted_out', updated_at = @updatedAt
    WHERE lower(phone) = @contact OR lower(COALESCE(email, '')) = @contact
  `).run({ contact: normalized, updatedAt: new Date().toISOString() }).changes;
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

export function createPrivacyRequest(input: Omit<PrivacyRequest, "status" | "createdAt" | "updatedAt">) {
  const now = new Date().toISOString();
  const row = getDatabase().prepare(`
    INSERT INTO privacy_requests (id, request_type, name, contact, order_id, status, created_at, updated_at)
    VALUES (@id, @requestType, @name, @contact, NULLIF(@orderId, ''), 'received', @now, @now)
    RETURNING *
  `).get({ ...input, now }) as StoredPrivacyRequestRow;
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

export function enqueueNotification(input: Pick<NotificationOutboxRecord, "id" | "dedupeKey" | "channel" | "target" | "payload">) {
  const now = new Date().toISOString();
  const row = getDatabase().prepare(`
    INSERT INTO notification_outbox
      (id, dedupe_key, channel, target, payload, status, attempts, next_attempt_at, created_at, updated_at)
    VALUES
      (@id, @dedupeKey, @channel, @target, @payload, 'pending', 0, @now, @now, @now)
    ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key = excluded.dedupe_key
    RETURNING *
  `).get({ ...input, payload: JSON.stringify(input.payload), now }) as StoredOutboxRow;
  return outboxFromRow(row);
}

export function readDueNotifications(limit = 20) {
  const rows = getDatabase().prepare(`
    SELECT * FROM notification_outbox
    WHERE status IN ('pending', 'failed') AND next_attempt_at <= @now AND attempts < 8
    ORDER BY created_at ASC
    LIMIT @limit
  `).all({ now: new Date().toISOString(), limit }) as StoredOutboxRow[];
  return rows.map(outboxFromRow);
}

export function updateNotificationDelivery(input: {
  id: string;
  status: "sent" | "failed" | "skipped";
  providerId?: string;
  error?: string;
  retryAfterMs?: number;
}) {
  const now = new Date();
  const nextAttemptAt = new Date(now.getTime() + (input.retryAfterMs ?? 0)).toISOString();
  getDatabase().prepare(`
    UPDATE notification_outbox
    SET status = @status,
        attempts = attempts + 1,
        next_attempt_at = @nextAttemptAt,
        provider_id = NULLIF(@providerId, ''),
        last_error = NULLIF(@error, ''),
        updated_at = @now,
        sent_at = CASE WHEN @status = 'sent' THEN @now ELSE sent_at END
    WHERE id = @id
  `).run({ ...input, providerId: input.providerId ?? "", error: input.error?.slice(0, 500) ?? "", nextAttemptAt, now: now.toISOString() });
}

export function notificationOutboxMetrics() {
  return getDatabase().prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent
    FROM notification_outbox
  `).get() as { pending: number | null; failed: number | null; sent: number | null };
}

export function operationsDataMetrics() {
  const db = getDatabase();
  const submissions = db.prepare("SELECT COUNT(*) AS total FROM submissions").get() as { total: number };
  const earlyAccess = db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN marketing_status = 'active' THEN 1 ELSE 0 END) AS active
    FROM early_access_signups
  `).get() as { total: number; active: number | null };
  const privacy = db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('received', 'identity_review') THEN 1 ELSE 0 END) AS open
    FROM privacy_requests
  `).get() as { total: number; open: number | null };
  const outbox = notificationOutboxMetrics();
  return {
    submissions: submissions.total,
    earlyAccess: { total: earlyAccess.total, active: earlyAccess.active ?? 0 },
    privacyRequests: { total: privacy.total, open: privacy.open ?? 0 },
    notifications: { pending: outbox.pending ?? 0, failed: outbox.failed ?? 0, sent: outbox.sent ?? 0 },
  };
}

export function listPrivacyRequests(limit = 100) {
  const rows = getDatabase().prepare("SELECT * FROM privacy_requests ORDER BY created_at ASC LIMIT ?").all(Math.max(1, Math.min(limit, 250))) as StoredPrivacyRequestRow[];
  return rows.map(privacyRequestFromRow);
}

export function updatePrivacyRequestStatus(id: string, status: PrivacyRequest["status"]) {
  const row = getDatabase().prepare(`
    UPDATE privacy_requests SET status = @status, updated_at = @updatedAt
    WHERE id = @id RETURNING *
  `).get({ id, status, updatedAt: new Date().toISOString() }) as StoredPrivacyRequestRow | undefined;
  return row ? privacyRequestFromRow(row) : null;
}

export function purgeOperationalData(now = Date.now(), householdLaunchDate = process.env.BUBBLEWASH_HOUSEHOLD_LAUNCH_DATE ?? "") {
  const db = getDatabase();
  const isoDaysAgo = (days: number) => new Date(now - days * 24 * 60 * 60_000).toISOString();
  const result: Record<string, number> = {};
  const purge = db.transaction(() => {
    result.expiredRateLimits = db.prepare("DELETE FROM rate_limits WHERE reset_at < ?").run(now - 24 * 60 * 60_000).changes;
    result.mfaReplayGuards = db.prepare("DELETE FROM mfa_replay_guard WHERE accepted_at < ?").run(isoDaysAgo(2)).changes;
    result.expiredMfaEnrollments = db.prepare("DELETE FROM admin_mfa_settings WHERE status = 'pending' AND expires_at < ?").run(new Date(now).toISOString()).changes;
    result.expiredMfaRecoveryBundles = db.prepare(`
      UPDATE admin_mfa_settings SET recovery_bundle_encrypted = NULL
      WHERE status = 'enrolled' AND recovery_bundle_encrypted IS NOT NULL AND updated_at < ?
    `).run(isoDaysAgo(1)).changes;
    result.workflowClaims = db.prepare("DELETE FROM workflow_action_claims WHERE claimed_at < ?").run(isoDaysAgo(90)).changes;
    result.notificationLogs = db.prepare("DELETE FROM notification_outbox WHERE updated_at < ?").run(isoDaysAgo(90)).changes;
    result.optedOutSignups = db.prepare("DELETE FROM early_access_signups WHERE marketing_status = 'opted_out' AND updated_at < ?").run(isoDaysAgo(30)).changes;
    const launch = /^\d{4}-\d{2}-\d{2}$/.test(householdLaunchDate) ? new Date(`${householdLaunchDate}T00:00:00.000Z`).getTime() : Number.NaN;
    if (Number.isFinite(launch) && now >= launch + 365 * 24 * 60 * 60_000) {
      result.expiredActiveSignups = db.prepare("DELETE FROM early_access_signups WHERE marketing_status = 'active' AND updated_at <= ?").run(new Date(launch + 365 * 24 * 60 * 60_000).toISOString()).changes;
    } else {
      result.expiredActiveSignups = 0;
    }
    result.privacyRequestLogs = db.prepare("DELETE FROM privacy_requests WHERE status IN ('completed', 'declined') AND updated_at < ?").run(isoDaysAgo(365 * 3)).changes;

    const closedOrders = db.prepare(`
      SELECT DISTINCT json_extract(data, '$.orderId') AS orderId
      FROM submissions
      WHERE json_extract(data, '$.submissionType') = 'admin-operation'
        AND json_extract(data, '$.actionType') = 'Close order'
        AND created_at < ?
    `).all(isoDaysAgo(365 * 2)) as Array<{ orderId: string }>;
    let deletedOrderRecords = 0;
    for (const { orderId } of closedOrders) {
      if (!orderId) continue;
      db.prepare("DELETE FROM driver_live_locations WHERE order_id = ? COLLATE NOCASE").run(orderId);
      db.prepare("DELETE FROM workflow_action_claims WHERE order_id = ? COLLATE NOCASE").run(orderId);
      db.prepare("DELETE FROM delivery_proofs WHERE order_id = ? COLLATE NOCASE").run(orderId);
      deletedOrderRecords += db.prepare(`
        DELETE FROM submissions WHERE id = @orderId COLLATE NOCASE OR json_extract(data, '$.orderId') = @orderId COLLATE NOCASE
      `).run({ orderId }).changes;
    }
    result.closedOrderRecords = deletedOrderRecords;
    result.orphanedPaymentVerifications = db.prepare("DELETE FROM payment_verifications WHERE record_id NOT IN (SELECT id FROM submissions)").run().changes;
  });
  purge();
  return result;
}

export function claimMfaTimestep(subject: string, timestep: number) {
  const result = getDatabase().prepare(`
    INSERT INTO mfa_replay_guard (subject, timestep, accepted_at)
    VALUES (@subject, @timestep, @acceptedAt)
    ON CONFLICT(subject) DO UPDATE SET
      timestep = excluded.timestep,
      accepted_at = excluded.accepted_at
    WHERE mfa_replay_guard.timestep < excluded.timestep
  `).run({ subject, timestep, acceptedAt: new Date().toISOString() });
  return result.changes === 1;
}

function adminMfaSettingFromRow(row: StoredAdminMfaRow): AdminMfaSetting {
  return {
    adminEmail: row.admin_email,
    encryptedSecret: row.encrypted_secret,
    status: row.status,
    expiresAt: row.expires_at ?? "",
    recoveryBundleEncrypted: row.recovery_bundle_encrypted ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readAdminMfaSetting(adminEmail: string) {
  const row = getDatabase().prepare("SELECT * FROM admin_mfa_settings WHERE admin_email = ? COLLATE NOCASE LIMIT 1")
    .get(adminEmail.trim()) as StoredAdminMfaRow | undefined;
  return row ? adminMfaSettingFromRow(row) : null;
}

export function savePendingAdminMfa(input: { adminEmail: string; encryptedSecret: string; expiresAt: string }) {
  const now = new Date().toISOString();
  const row = getDatabase().prepare(`
    INSERT INTO admin_mfa_settings
      (admin_email, encrypted_secret, status, expires_at, recovery_bundle_encrypted, created_at, updated_at)
    VALUES
      (@adminEmail, @encryptedSecret, 'pending', @expiresAt, NULL, @now, @now)
    ON CONFLICT(admin_email) DO UPDATE SET
      encrypted_secret = excluded.encrypted_secret,
      status = 'pending',
      expires_at = excluded.expires_at,
      recovery_bundle_encrypted = NULL,
      updated_at = excluded.updated_at
    WHERE admin_mfa_settings.status = 'pending'
    RETURNING *
  `).get({ ...input, now }) as StoredAdminMfaRow | undefined;
  return row ? adminMfaSettingFromRow(row) : null;
}

export function confirmAdminMfa(input: {
  adminEmail: string;
  encryptedRecoveryBundle: string;
  recoveryCodeHashes: string[];
  now?: string;
}) {
  const db = getDatabase();
  const now = input.now ?? new Date().toISOString();
  const confirm = db.transaction(() => {
    const updated = db.prepare(`
      UPDATE admin_mfa_settings
      SET status = 'enrolled', expires_at = NULL, recovery_bundle_encrypted = @encryptedRecoveryBundle, updated_at = @now
      WHERE admin_email = @adminEmail COLLATE NOCASE
        AND status = 'pending'
        AND expires_at > @now
    `).run({ adminEmail: input.adminEmail, encryptedRecoveryBundle: input.encryptedRecoveryBundle, now });
    if (updated.changes !== 1) return false;
    db.prepare("DELETE FROM admin_mfa_recovery_codes WHERE admin_email = ? COLLATE NOCASE").run(input.adminEmail);
    const insert = db.prepare(`
      INSERT INTO admin_mfa_recovery_codes (admin_email, code_hash, created_at)
      VALUES (?, ?, ?)
    `);
    for (const hash of input.recoveryCodeHashes) insert.run(input.adminEmail, hash, now);
    return true;
  });
  return confirm.immediate();
}

export function acknowledgeAdminMfaRecoveryCodes(adminEmail: string) {
  return getDatabase().prepare(`
    UPDATE admin_mfa_settings
    SET recovery_bundle_encrypted = NULL, updated_at = @updatedAt
    WHERE admin_email = @adminEmail COLLATE NOCASE AND status = 'enrolled'
  `).run({ adminEmail, updatedAt: new Date().toISOString() }).changes === 1;
}

export function consumeAdminMfaRecoveryCode(adminEmail: string, codeHash: string) {
  return getDatabase().prepare(`
    UPDATE admin_mfa_recovery_codes
    SET used_at = @usedAt
    WHERE admin_email = @adminEmail COLLATE NOCASE AND code_hash = @codeHash AND used_at IS NULL
  `).run({ adminEmail, codeHash, usedAt: new Date().toISOString() }).changes === 1;
}

export function storeDeliveryCode(orderId: string, codeHash: string) {
  const createdAt = new Date().toISOString();
  return getDatabase().prepare(`
    INSERT INTO delivery_proofs (order_id, code_hash, created_at)
    VALUES (@orderId, @codeHash, @createdAt)
    ON CONFLICT(order_id) DO NOTHING
  `).run({ orderId, codeHash, createdAt }).changes === 1;
}

export function deliveryCodeRecord(orderId: string) {
  return getDatabase().prepare(`
    SELECT order_id AS orderId, code_hash AS codeHash, created_at AS createdAt,
           COALESCE(used_at, '') AS usedAt, COALESCE(used_by, '') AS usedBy,
           COALESCE(recipient_name, '') AS recipientName
    FROM delivery_proofs WHERE order_id = ? COLLATE NOCASE LIMIT 1
  `).get(orderId) as { orderId: string; codeHash: string; createdAt: string; usedAt: string; usedBy: string; recipientName: string } | undefined;
}

export function consumeDeliveryCode(orderId: string, codeHash: string, usedBy: string, recipientName: string) {
  return getDatabase().prepare(`
    UPDATE delivery_proofs
    SET used_at = @usedAt, used_by = @usedBy, recipient_name = @recipientName
    WHERE order_id = @orderId COLLATE NOCASE AND code_hash = @codeHash AND used_at IS NULL
  `).run({ orderId, codeHash, usedBy, recipientName, usedAt: new Date().toISOString() }).changes === 1;
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

export function upsertDriverLiveLocation(location: StoredDriverLocation) {
  const result = getDatabase().prepare(`
    INSERT INTO driver_live_locations
      (driver_id, order_id, latitude, longitude, accuracy_meters, captured_at, received_at)
    VALUES
      (@driverId, @orderId, @latitude, @longitude, @accuracyMeters, @capturedAt, @receivedAt)
    ON CONFLICT(driver_id) DO UPDATE SET
      order_id = excluded.order_id,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      accuracy_meters = excluded.accuracy_meters,
      captured_at = excluded.captured_at,
      received_at = excluded.received_at
    WHERE driver_live_locations.captured_at < excluded.captured_at
  `).run(location);
  return result.changes === 1;
}

export function readDriverLiveLocation(driverId: string): StoredDriverLocation | null {
  const row = getDatabase().prepare(`
    SELECT driver_id, order_id, latitude, longitude, accuracy_meters, captured_at, received_at
    FROM driver_live_locations
    WHERE driver_id = ? COLLATE NOCASE
    LIMIT 1
  `).get(driverId.trim()) as StoredDriverLocationRow | undefined;
  return row ? driverLocationFromRow(row) : null;
}

export function readDriverLiveLocations(): StoredDriverLocation[] {
  const rows = getDatabase().prepare(`
    SELECT driver_id, order_id, latitude, longitude, accuracy_meters, captured_at, received_at
    FROM driver_live_locations
    ORDER BY captured_at DESC
  `).all() as StoredDriverLocationRow[];
  return rows.map(driverLocationFromRow);
}

export function deleteDriverLiveLocation(driverId: string) {
  return getDatabase().prepare("DELETE FROM driver_live_locations WHERE driver_id = ? COLLATE NOCASE").run(driverId.trim()).changes === 1;
}

export function deleteExpiredDriverLiveLocations(capturedBefore: string) {
  return getDatabase().prepare("DELETE FROM driver_live_locations WHERE captured_at < ?").run(capturedBefore).changes;
}

export function readStaffCredentialOverride(role: "admin" = "admin"): StaffCredentialOverride | null {
  const row = getDatabase().prepare(`
    SELECT role, login, password_hash, credential_version, updated_at
    FROM staff_credential_overrides
    WHERE role = ?
  `).get(role) as StoredStaffCredentialOverrideRow | undefined;
  if (!row) return null;
  return {
    role: row.role,
    login: row.login,
    passwordHash: row.password_hash,
    credentialVersion: row.credential_version,
    updatedAt: row.updated_at,
  };
}

export function consumeAdminRecoveryTokenAndSetCredentials(input: {
  tokenHash: string;
  configuredTokenHash: string;
  expiresAt: string;
  login: string;
  passwordHash: string;
  credentialVersion: string;
  now?: string;
}) {
  const db = getDatabase();
  const now = input.now ?? new Date().toISOString();
  return db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO admin_recovery_tokens (token_hash, expires_at, used_at, created_at)
      VALUES (@configuredTokenHash, @expiresAt, NULL, @now)
    `).run({ configuredTokenHash: input.configuredTokenHash, expiresAt: input.expiresAt, now });

    const consumed = db.prepare(`
      UPDATE admin_recovery_tokens
      SET used_at = @now
      WHERE token_hash = @tokenHash AND used_at IS NULL AND expires_at > @now
    `).run({ tokenHash: input.tokenHash, now });
    if (consumed.changes !== 1) return false;

    db.prepare(`
      INSERT INTO staff_credential_overrides (role, login, password_hash, credential_version, updated_at)
      VALUES ('admin', @login, @passwordHash, @credentialVersion, @now)
      ON CONFLICT(role) DO UPDATE SET
        login = excluded.login,
        password_hash = excluded.password_hash,
        credential_version = excluded.credential_version,
        updated_at = excluded.updated_at
    `).run({
      login: input.login,
      passwordHash: input.passwordHash,
      credentialVersion: input.credentialVersion,
      now,
    });
    return true;
  })();
}

export function resetDataStoreForTests() {
  if (!database) return;
  database.prepare("DELETE FROM submissions").run();
  database.prepare("DELETE FROM rate_limits").run();
  database.prepare("DELETE FROM workflow_action_claims").run();
  database.prepare("DELETE FROM payment_verifications").run();
  database.prepare("DELETE FROM driver_live_locations").run();
  database.prepare("DELETE FROM early_access_signups").run();
  database.prepare("DELETE FROM privacy_requests").run();
  database.prepare("DELETE FROM notification_outbox").run();
  database.prepare("DELETE FROM mfa_replay_guard").run();
  database.prepare("DELETE FROM admin_mfa_recovery_codes").run();
  database.prepare("DELETE FROM admin_mfa_settings").run();
  database.prepare("DELETE FROM admin_recovery_tokens").run();
  database.prepare("DELETE FROM staff_credential_overrides").run();
  database.prepare("DELETE FROM delivery_proofs").run();
  lastLocationCleanupAt = 0;
}
