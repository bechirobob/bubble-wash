CREATE TABLE IF NOT EXISTS migration_runs (
  run_id TEXT PRIMARY KEY,
  source_sha TEXT NOT NULL,
  source_database_sha256 TEXT NOT NULL,
  manifest TEXT NOT NULL CHECK (json_valid(manifest)),
  state TEXT NOT NULL CHECK (state IN ('importing', 'complete', 'aborted')),
  started_at TEXT NOT NULL,
  completed_at TEXT
);
