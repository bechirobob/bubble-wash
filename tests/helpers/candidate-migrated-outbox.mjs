// Pinned synthetic output contract of the reviewed additive candidate migration.
// Independent from the fallback implementation; golden-contract tests compare it
// against each app's real migration. Never connects to production or providers.
export function seedCandidateMigratedOutbox(db, input) {
  db.transaction(() => {
    for (const [name, definition] of [
      ['delivery_state', "TEXT NOT NULL DEFAULT 'queued'"], ['lease_token','TEXT'],
      ['lease_expires_at','TEXT'], ['lease_attempt_started','INTEGER NOT NULL DEFAULT 0'],
      ['first_attempt_at','TEXT'], ['provider_request','TEXT'],
      ['provider_idempotency_key','TEXT'], ['provider_account_hash','TEXT'],
    ]) db.exec(`ALTER TABLE notification_outbox ADD COLUMN ${name} ${definition}`);
    db.exec(`UPDATE notification_outbox SET delivery_state = CASE
      WHEN status = 'sent' THEN 'accepted' WHEN status = 'skipped' THEN 'skipped' ELSE 'manual_review' END,
      status = CASE WHEN status IN ('pending', 'failed') THEN 'failed' ELSE status END,
      last_error = CASE WHEN status IN ('pending', 'failed')
      THEN 'Legacy outbox row has no lease or provider deduplication evidence. Verify with the provider before any resend.' ELSE last_error END`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_notification_outbox_lease ON notification_outbox(delivery_state, lease_expires_at, next_attempt_at)');
    if (input) db.prepare(`INSERT INTO notification_outbox
      (id,dedupe_key,channel,target,payload,status,attempts,next_attempt_at,created_at,updated_at)
      VALUES (?,?,?,?,?,'pending',0,?,?,?)`).run(input.id,input.dedupeKey,input.channel,input.target,JSON.stringify(input.payload),input.now,input.now,input.now);
  }).immediate();
}
