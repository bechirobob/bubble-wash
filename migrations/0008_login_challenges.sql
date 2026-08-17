CREATE TABLE IF NOT EXISTS login_challenges (
  nonce TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_challenges_expiry
  ON login_challenges(expires_at, used_at);
