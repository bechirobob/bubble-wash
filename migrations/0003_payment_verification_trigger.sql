-- Keep the final `end` lowercase and this trigger alone in its migration.
-- Wrangler 4.120 otherwise strips the terminator while splitting remote D1 SQL.
CREATE TRIGGER IF NOT EXISTS payment_verification_submission
AFTER INSERT ON payment_verifications
WHEN NEW.submission_created_at IS NOT NULL AND NEW.submission_data IS NOT NULL
BEGIN
  INSERT INTO submissions (id, created_at, source, data)
  VALUES (NEW.record_id, NEW.submission_created_at, NEW.submission_source, NEW.submission_data);
end;
