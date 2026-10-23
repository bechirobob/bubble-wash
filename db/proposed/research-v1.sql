-- PROPOSED ONLY. No runtime DDL. Not applied to any live database.
CREATE TABLE research_responses(
 id TEXT PRIMARY KEY, submission_key TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
 instrument TEXT NOT NULL CHECK(instrument IN ('consumer','consumer-interview','business-interview','vendor-interview')),
 schema_version TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX research_response_created ON research_responses(created_at DESC);
CREATE TABLE research_notification_outbox(
 response_id TEXT PRIMARY KEY REFERENCES research_responses(id),
 state TEXT NOT NULL DEFAULT 'held' CHECK(state IN('held','pending','sending','sent','failed')),
 recipient TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
 lease_token TEXT,lease_until TEXT,last_error_kind TEXT,provider_message_id TEXT,sent_at TEXT
);

