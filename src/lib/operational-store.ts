import "server-only";
import { createHash, createHmac } from "node:crypto";
import { getDatabase, appendSubmissionRecord, readSubmissionRecordsForOrder, deliveryCodeRecord } from "./data-store.ts";
import { deliveryCodeHash } from "./chain-of-custody.ts";
import type { SubmissionRecord } from "./submissions.ts";

export function operationalDatabase() {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_route_fees (order_id TEXT PRIMARY KEY COLLATE NOCASE, amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0), actor TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS booking_requests (request_key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, order_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS order_holds (order_id TEXT PRIMARY KEY COLLATE NOCASE, reason TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS order_invoices (order_id TEXT PRIMARY KEY COLLATE NOCASE, invoice_id TEXT NOT NULL UNIQUE, account_key TEXT NOT NULL, period TEXT NOT NULL, lines TEXT NOT NULL, total_minor INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS account_service_fees (account_key TEXT NOT NULL, period TEXT NOT NULL, order_id TEXT NOT NULL, PRIMARY KEY(account_key, period));
    CREATE TABLE IF NOT EXISTS billing_entries (id TEXT PRIMARY KEY, order_id TEXT NOT NULL COLLATE NOCASE, kind TEXT NOT NULL CHECK(kind IN ('payment','credit','refund')), amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), reference TEXT NOT NULL UNIQUE, actor TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  return db;
}
export function saveBookingOnce(record: SubmissionRecord, key: string, enqueue: (record: SubmissionRecord) => void) {
  const db = operationalDatabase();
  const hash = createHash("sha256").update(JSON.stringify(Object.entries(record.data).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
  return db.transaction(() => {
    const prior = db.prepare("SELECT payload_hash, order_id FROM booking_requests WHERE request_key = ?").get(key) as { payload_hash: string; order_id: string } | undefined;
    if (prior && prior.payload_hash !== hash) throw new Error("This request changed. Start a new booking before submitting different details.");
    const orderId = prior?.order_id ?? record.id;
    const secret = process.env.BUBBLEWASH_SESSION_SECRET || (process.env.NODE_ENV !== "production" ? "bubblewash-local-dev-session-secret-change-before-production" : "");
    if (!secret) throw new Error("Session configuration unavailable.");
    const code = String(parseInt(createHmac("sha256", secret).update(`booking-code:${orderId}:${key}`).digest("hex").slice(0, 12), 16) % 1000000).padStart(6, "0");
    if (!prior) {
      appendSubmissionRecord(record);
      db.prepare("INSERT INTO booking_requests VALUES (?, ?, ?, ?)").run(key, hash, orderId, record.createdAt);
      db.prepare("INSERT INTO delivery_proofs (order_id, code_hash, created_at) VALUES (?, ?, ?)").run(orderId, deliveryCodeHash(orderId, code), record.createdAt);
      enqueue(record);
    }
    const proof = deliveryCodeRecord(orderId);
    return { id: orderId, deliveryCode: proof?.codeHash === deliveryCodeHash(orderId, code) && !proof.usedAt ? code : "", replayed: Boolean(prior) };
  }).immediate();
}
export function readOrderPage(offset = 0, limit = 100, query = "") {
  const rows = operationalDatabase().prepare(`SELECT id FROM submissions WHERE json_extract(data, '$.submissionType') IN ('pickup-booking','checkout-request') AND COALESCE(json_extract(data, '$.orderId'), '') = '' AND (? = '' OR id LIKE ? OR json_extract(data, '$.company') LIKE ? OR json_extract(data, '$.name') LIKE ?) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(query, `%${query}%`, `%${query}%`, `%${query}%`, limit + 1, offset) as { id: string }[];
  return { records: rows.slice(0, limit).flatMap(({ id }) => readSubmissionRecordsForOrder(id)), nextOffset: rows.length > limit ? offset + limit : null };
}
