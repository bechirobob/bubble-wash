// Explicit offline additive migration. Application/maintenance writers must be
// held, and a current recoverable backup verified, before separately approved use.
// No historical booking/vendor backfill, resets, notifications or store startup.
import path from "node:path";
import Database from "better-sqlite3";
import { databaseReadiness } from "../src/lib/data-store.ts";
import { initializeStaffAccountsSchema } from "../src/lib/staff-accounts.ts";
import { bookingReferenceSchemaState, migrateBookingReferences } from "../src/lib/booking-reference-schema.ts";

const args = process.argv.slice(2);
const inventoryOnly = args[0] === "--inventory";
if (inventoryOnly) args.shift();
if (args.length !== 2 || args[0] !== "--database" || !path.isAbsolute(args[1])) {
  throw new Error("Expected [--inventory] --database /absolute/path/to/existing.sqlite");
}
const db = new Database(args[1], { fileMustExist: true, readonly: inventoryOnly });
try {
  if (inventoryOnly) db.pragma("query_only = ON");
  db.pragma("busy_timeout = 5000");
  const inventory = () => ({
    schema: bookingReferenceSchemaState(db),
    unmappedRootCount: db.prepare("SELECT count(*) AS count FROM submissions WHERE json_extract(data, '$.submissionType') IN ('pickup-booking','checkout-request') AND coalesce(json_extract(data, '$.orderId'), '') = ''" + (bookingReferenceSchemaState(db) === 'ready' ? " AND NOT EXISTS (SELECT 1 FROM booking_references WHERE order_id = submissions.id)" : "")).get().count,
    vendorRowCount: db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vendor_availability'").get()
      ? db.prepare("SELECT count(*) AS count FROM vendor_availability").get().count : 0,
  });
  if (inventoryOnly) {
    console.log(JSON.stringify({ ok: true, inventoryOnly: true, ...inventory(), historicalBackfill: false }));
  } else {
    db.transaction(() => {
      if (!databaseReadiness(db, [initializeStaffAccountsSchema], { allowMissingBookingReferences: true })) throw new Error("Database schema/integrity preflight failed.");
      migrateBookingReferences(db);
      if (!databaseReadiness(db, [initializeStaffAccountsSchema])) throw new Error("Database schema/integrity postflight failed.");
    }).immediate();
    console.log(JSON.stringify({ ok: true, migration: "permanent-booking-vendor-labels-v1", historicalBackfill: false }));
  }
} finally { db.close(); }
