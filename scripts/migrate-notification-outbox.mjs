// Offline, explicitly targeted migration. Stop every application/maintenance
// sender and verify a recoverable backup before any separately authorized use.
// Never initialize the app store: that would purge expired locations/import data.
import path from 'node:path';
import Database from 'better-sqlite3';
import { databaseReadiness } from '../src/lib/data-store.ts';
import { initializeStaffAccountsSchema } from '../src/lib/staff-accounts.ts';
import { migrateNotificationOutbox } from '../src/lib/notification-outbox-schema.ts';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--database' || !path.isAbsolute(args[1])) {
  throw new Error('Usage: node --conditions=react-server --experimental-strip-types scripts/migrate-notification-outbox.mjs --database /absolute/path/to/existing.sqlite');
}
const database = new Database(args[1], { fileMustExist: true });
try {
  // Hold the write reservation across exact preflight, the shared additive
  // transaction, and postflight. A failing check rolls the entire change back.
  database.transaction(() => {
    if (!databaseReadiness(database, [initializeStaffAccountsSchema])) {
      throw new Error('Exact database schema/integrity preflight failed; no migration was performed.');
    }
    migrateNotificationOutbox(database);
    // Readiness accepts exactly legacy OR additive. Require an additive-only
    // column too, so a future accidental no-op cannot report migration success.
    const additive = database.prepare('PRAGMA table_info(notification_outbox)').all()
      .some(({ name }) => name === 'delivery_state');
    if (!additive || !databaseReadiness(database, [initializeStaffAccountsSchema])) {
      throw new Error('Exact additive database schema/integrity postflight failed; migration rolled back.');
    }
  }).immediate();
  console.log(JSON.stringify({ ok: true, migration: 'notification-outbox-exact-additive-v1' }));
} finally {
  database.close();
}
