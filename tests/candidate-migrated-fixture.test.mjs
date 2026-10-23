import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrateNotificationOutbox } from '../src/lib/notification-outbox-schema.ts';
import { seedCandidateMigratedOutbox } from './helpers/candidate-migrated-outbox.mjs';
test('portable candidate-migrated fixture matches real migration schema and legacy row semantics', () => {
 const actual=new Database(':memory:'), golden=new Database(':memory:');
 try {
  for(const db of [actual,golden]) {
   db.exec("CREATE TABLE IF NOT EXISTS notification_outbox (\n      id TEXT PRIMARY KEY,\n      dedupe_key TEXT NOT NULL UNIQUE,\n      channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),\n      target TEXT NOT NULL CHECK (target IN ('customer', 'operations')),\n      payload TEXT NOT NULL CHECK (json_valid(payload)),\n      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),\n      attempts INTEGER NOT NULL DEFAULT 0,\n      next_attempt_at TEXT NOT NULL,\n      provider_id TEXT,\n      last_error TEXT,\n      created_at TEXT NOT NULL,\n      updated_at TEXT NOT NULL,\n      sent_at TEXT\n    );\n    CREATE INDEX IF NOT EXISTS idx_notification_outbox_due ON notification_outbox(status, next_attempt_at);");
   for(const status of ['pending','failed','sent','skipped']) db.prepare(`INSERT INTO notification_outbox (id,dedupe_key,channel,target,payload,status,attempts,next_attempt_at,created_at,updated_at) VALUES (?,?,'email','customer','{}',?,1,'2026-01-01','2026-01-01','2026-01-01')`).run(status,status,status);
  }
  migrateNotificationOutbox(actual); seedCandidateMigratedOutbox(golden);
  const snapshot=db=>({schema:db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='notification_outbox' ORDER BY type,name").all(),rows:db.prepare('SELECT rowid,* FROM notification_outbox ORDER BY rowid').all()});
  assert.deepEqual(snapshot(actual),snapshot(golden));
  const before=snapshot(actual);migrateNotificationOutbox(actual);assert.deepEqual(snapshot(actual),before);
 } finally {actual.close();golden.close();}
});
