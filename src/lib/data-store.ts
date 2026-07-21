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

type StoredDriverLocationRow = {
  driver_id: string;
  order_id: string;
  latitude: number;
  longitude: number;
  accuracy_meters: number;
  captured_at: string;
  received_at: string;
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

export function resetDataStoreForTests() {
  if (!database) return;
  database.prepare("DELETE FROM submissions").run();
  database.prepare("DELETE FROM rate_limits").run();
  database.prepare("DELETE FROM workflow_action_claims").run();
  database.prepare("DELETE FROM payment_verifications").run();
  database.prepare("DELETE FROM driver_live_locations").run();
  lastLocationCleanupAt = 0;
}
