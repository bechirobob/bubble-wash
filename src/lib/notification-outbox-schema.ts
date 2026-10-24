import type Database from "better-sqlite3";

// One ordered DDL definition for runtime migration and in-memory readiness
// references. Changing this contract requires an explicit compatibility review.
const notificationOutboxAdditions = [
  ["delivery_state", "TEXT NOT NULL DEFAULT 'queued'"],
  ["lease_token", "TEXT"],
  ["lease_expires_at", "TEXT"],
  ["lease_attempt_started", "INTEGER NOT NULL DEFAULT 0"],
  ["first_attempt_at", "TEXT"],
  ["provider_request", "TEXT"],
  ["provider_idempotency_key", "TEXT"],
  ["provider_account_hash", "TEXT"],
] as const;

export const NOTIFICATION_OUTBOX_LEASE_INDEX_SQL = "CREATE INDEX IF NOT EXISTS idx_notification_outbox_lease ON notification_outbox(delivery_state, lease_expires_at, next_attempt_at)";

export function addNotificationOutboxColumns(database: Database.Database, existingColumns: ReadonlySet<string> = new Set()) {
  for (const [name, definition] of notificationOutboxAdditions) {
    if (!existingColumns.has(name)) database.exec(`ALTER TABLE notification_outbox ADD COLUMN ${name} ${definition}`);
  }
}

export function notificationOutboxSchemaSnapshot(database: Database.Database) {
  // Include the table, both explicit and implicit indexes, and any triggers.
  // Extra outbox objects fail closed, rather than being silently allowlisted.
  return JSON.stringify(database.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'notification_outbox' ORDER BY type, name").all());
}

// Additive, transactional migration also works against deployed pilot databases.
// Legacy attempts did not persist a provider key; their outcome cannot safely
// be inferred, so they need review rather than automatic replay.
const notificationSchemas = new WeakSet<Database.Database>();
export function migrateNotificationOutbox(db: Database.Database) {
  if (!notificationSchemas.has(db)) {
    const callerOwnsTransaction = db.inTransaction;
    db.transaction(() => {
      const columns = new Set((db.prepare("PRAGMA table_info(notification_outbox)").all() as { name: string }[]).map((column) => column.name));
      addNotificationOutboxColumns(db, columns);
      if (!columns.has("delivery_state")) {
        db.exec(`UPDATE notification_outbox SET delivery_state = CASE
          WHEN status = 'sent' THEN 'accepted'
          WHEN status = 'skipped' THEN 'skipped'
          ELSE 'manual_review' END,
          status = CASE WHEN status IN ('pending', 'failed') THEN 'failed' ELSE status END,
          last_error = CASE WHEN status IN ('pending', 'failed')
            THEN 'Legacy outbox row has no lease or provider deduplication evidence. Verify with the provider before any resend.'
            ELSE last_error END`);
      }
      db.exec(NOTIFICATION_OUTBOX_LEASE_INDEX_SQL);
    }).immediate();
    // A nested savepoint can still be rolled back by its caller. Cache only
    // after this function committed the outermost transaction itself.
    if (!callerOwnsTransaction) notificationSchemas.add(db);
  }
  return db;
}
