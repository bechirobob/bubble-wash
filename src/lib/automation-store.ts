import "server-only";
import { createHash } from "node:crypto";
import { getDatabase } from "./data-store.ts";

export function automationDatabase() {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS operational_work_ownership (
      item_id TEXT PRIMARY KEY, owner_email TEXT NOT NULL, due_at TEXT NOT NULL,
      note TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
      order_id TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS operational_command_receipts (
      scope TEXT NOT NULL, request_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
      response TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope,request_key)
    );
    CREATE TABLE IF NOT EXISTS vendor_capacity_confirmations (
      vendor_id TEXT PRIMARY KEY COLLATE NOCASE, confirmed_at TEXT NOT NULL, actor TEXT NOT NULL
    );
  `);
  const columns = db.prepare("PRAGMA table_info(operational_work_ownership)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "order_id")) db.exec("ALTER TABLE operational_work_ownership ADD COLUMN order_id TEXT NOT NULL DEFAULT ''");
  return db;
}

export function recordCapacityConfirmation(vendorId: string, actor: string, now = new Date().toISOString()) {
  automationDatabase().prepare(`INSERT INTO vendor_capacity_confirmations VALUES (?,?,?)
    ON CONFLICT(vendor_id) DO UPDATE SET confirmed_at=excluded.confirmed_at, actor=excluded.actor`).run(vendorId, now, actor);
}

export function capacityFreshness(vendorId: string, now = Date.now()) {
  const saved = automationDatabase().prepare("SELECT confirmed_at FROM vendor_capacity_confirmations WHERE vendor_id=?").get(vendorId) as { confirmed_at: string } | undefined;
  const confirmedAt = saved?.confirmed_at ?? "";
  const ageMs = now - Date.parse(confirmedAt);
  // A reservation/release changes the roster timestamp, not this explicit confirmation.
  const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 12 * 60 * 60_000;
  return { confirmedAt, fresh, state: fresh ? "confirmed" : confirmedAt ? "stale" : "unconfirmed", refreshAfterHours: 12 };
}

export const automationHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type WorkOwnership = { ownerEmail: string; dueAt: string; note: string; revision: number; updatedAt: string };
export function readOwnership(itemId: string): WorkOwnership {
  return automationDatabase().prepare("SELECT owner_email AS ownerEmail, due_at AS dueAt, note, revision, updated_at AS updatedAt FROM operational_work_ownership WHERE item_id=?").get(itemId) as WorkOwnership | undefined
    ?? { ownerEmail: "", dueAt: "", note: "", revision: 0, updatedAt: "" };
}
