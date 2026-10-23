import Database from "better-sqlite3";
import { bookingReferenceSchema } from "./booking-references.ts";
import { vendorCodeSchema } from "./vendor-codes.ts";

const mappingTables = ["booking_references", "vendor_codes"] as const;
export function createBookingReferenceSchema(db: Database.Database) {
  db.exec(bookingReferenceSchema);
  db.exec(vendorCodeSchema);

}

function schemaSnapshot(db: Database.Database) {
  return JSON.stringify(db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN ('booking_references','vendor_codes') OR name IN ('booking_references','vendor_codes') ORDER BY type, name").all());
}

export function bookingReferenceSchemaState(db: Database.Database): "absent" | "ready" | "invalid" {
  const actual = schemaSnapshot(db);
  if (actual === "[]") return "absent";
  const reference = new Database(":memory:");
  try {
    createBookingReferenceSchema(reference);
    if (actual !== schemaSnapshot(reference)) return "invalid";
    for (const table of mappingTables) {
      const max = db.prepare(`SELECT coalesce(max(sequence), 0) AS value FROM ${table}`).get() as { value: number };
      const high = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) as { seq: number } | undefined;
      if (high && (!Number.isSafeInteger(high.seq) || high.seq < max.value || high.seq > (table === "vendor_codes" ? 17576 : Number.MAX_SAFE_INTEGER)) || !high && max.value > 0) return "invalid";
    }
    const vendors = db.prepare("SELECT code FROM vendor_codes").all() as { code: string }[];
    if (vendors.some(({ code }) => typeof code !== "string" || !/^[A-Z]{3}$/.test(code))) return "invalid";
    return "ready";
  } finally { reference.close(); }
}

/** Explicit offline migration: adds empty maps only, never relabels historical rows. */
export function migrateBookingReferences(db: Database.Database) {
  db.transaction(() => {
    const state = bookingReferenceSchemaState(db);
    if (state === "invalid") throw new Error("Booking reference schema is partial or changed.");
    if (state === "absent") createBookingReferenceSchema(db);
    if (bookingReferenceSchemaState(db) !== "ready") throw new Error("Booking reference schema verification failed.");
  }).immediate();
}
