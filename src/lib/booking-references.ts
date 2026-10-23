/** Human-readable labels only. A reference is never authorization or a tracking secret. */
import type Database from "better-sqlite3";
export type ReferenceDatabase = Pick<Database.Database, "prepare" | "inTransaction">;

export const bookingReferenceSchema = `CREATE TABLE booking_references (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(sequence BETWEEN 1 AND 9007199254740991),
  order_id TEXT NOT NULL UNIQUE CHECK(length(order_id) > 0)
);`;

export function formatBookingReference(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Invalid booking sequence.");
  return `BW-${String(sequence).padStart(3, "0")}`;
}

export function parseBookingReference(input: string): number | null {
  const reference = input.trim().toUpperCase();
  if (!/^BW-[0-9]{3,16}$/.test(reference)) return null;
  const sequence = Number(reference.slice(3));
  return Number.isSafeInteger(sequence) && sequence > 0 && formatBookingReference(sequence) === reference ? sequence : null;
}

/** Call inside the same BEGIN IMMEDIATE transaction that saves a NEW booking.
 * Schema installation is an explicit migration, never a read-side initializer.
 * Existing mappings are immutable and idempotent. Failed booking transactions roll back allocation.
 */
export function allocateBookingReference(db: ReferenceDatabase, orderId: string): string {
  if (!db.inTransaction) throw new Error("Booking allocation requires the booking transaction.");
  if (!orderId || orderId.length > 160 || orderId.trim() !== orderId) throw new Error("Invalid internal booking identity.");
  const existing = db.prepare("SELECT sequence FROM booking_references WHERE order_id = ?").get(orderId) as { sequence: number } | undefined;
  if (existing) return formatBookingReference(Number(existing.sequence));
  db.prepare("INSERT INTO booking_references (order_id) VALUES (?)").run(orderId);
  const saved = db.prepare("SELECT sequence FROM booking_references WHERE order_id = ?").get(orderId) as { sequence: number } | undefined;
  if (!saved) throw new Error("Booking reference was not saved.");
  return formatBookingReference(Number(saved.sequence));
}

/** Internal lookup only: callers MUST separately establish customer/staff access.
 * Never expose this through the existing unauthenticated public tracking route.
 */
export function internalOrderForBookingReference(db: Pick<ReferenceDatabase, "prepare">, input: string): string | null {
  const sequence = parseBookingReference(input);
  if (sequence === null) return null;
  const row = db.prepare("SELECT order_id FROM booking_references WHERE sequence = ?").get(sequence) as { order_id: string } | undefined;
  return typeof row?.order_id === "string" ? row.order_id : null;
}

/** Read-only display lookup. Old records intentionally have no mapping. */
export function bookingReferenceForOrder(db: Pick<ReferenceDatabase, "prepare">, orderId: string): string | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='booking_references'").get()) return null;
  const row = db.prepare("SELECT sequence FROM booking_references WHERE order_id = ?").get(orderId) as { sequence: number } | undefined;
  return row ? formatBookingReference(Number(row.sequence)) : null;
}

export function submissionDataWithoutLabels(data: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...data };
  delete clean.bookingReference;
  delete clean.vendorCode;
  return clean;
}

export function isRootBooking(data: Record<string, unknown>): boolean {
  return ["pickup-booking", "checkout-request"].includes(String(data.submissionType)) && !data.orderId;
}
