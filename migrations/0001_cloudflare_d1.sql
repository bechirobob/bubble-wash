PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  source TEXT,
  data TEXT NOT NULL CHECK (json_valid(data))
);
CREATE INDEX IF NOT EXISTS idx_submissions_created_at ON submissions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_order_id ON submissions(json_extract(data, '$.orderId') COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_reset_at ON rate_limits(reset_at);

CREATE TABLE IF NOT EXISTS workflow_action_claims (
  claim_key TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  action_key TEXT NOT NULL,
  order_updated_at TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_action_claims_claimed_at ON workflow_action_claims(claimed_at);

CREATE TABLE IF NOT EXISTS payment_verifications (
  reference TEXT NOT NULL,
  status TEXT NOT NULL,
  transaction_id TEXT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  record_id TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  submission_created_at TEXT,
  submission_source TEXT,
  submission_data TEXT CHECK (submission_data IS NULL OR json_valid(submission_data)),
  PRIMARY KEY (reference, status)
);
CREATE INDEX IF NOT EXISTS idx_payment_verifications_verified_at ON payment_verifications(verified_at DESC);

CREATE TRIGGER IF NOT EXISTS payment_verification_submission
AFTER INSERT ON payment_verifications
WHEN NEW.submission_created_at IS NOT NULL AND NEW.submission_data IS NOT NULL
BEGIN
  INSERT INTO submissions (id, created_at, source, data)
  VALUES (NEW.record_id, NEW.submission_created_at, NEW.submission_source, NEW.submission_data);
END;

CREATE TABLE IF NOT EXISTS driver_live_locations (
  driver_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  latitude REAL NOT NULL CHECK (latitude >= 5.45 AND latitude <= 5.95),
  longitude REAL NOT NULL CHECK (longitude >= -0.45 AND longitude <= 0.2),
  accuracy_meters REAL NOT NULL CHECK (accuracy_meters > 0 AND accuracy_meters <= 1000),
  captured_at TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_driver_live_locations_order_id ON driver_live_locations(order_id COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_driver_live_locations_captured_at ON driver_live_locations(captured_at);

CREATE TABLE IF NOT EXISTS early_access_signups (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  email TEXT,
  area TEXT NOT NULL,
  frequency TEXT NOT NULL,
  consent_at TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  marketing_status TEXT NOT NULL DEFAULT 'active' CHECK (marketing_status IN ('active', 'opted_out')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_early_access_area ON early_access_signups(area COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_early_access_updated_at ON early_access_signups(updated_at DESC);

CREATE TABLE IF NOT EXISTS privacy_requests (
  id TEXT PRIMARY KEY,
  request_type TEXT NOT NULL CHECK (request_type IN ('access', 'correction', 'deletion', 'marketing_opt_out')),
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  order_id TEXT,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'identity_review', 'completed', 'declined')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_privacy_requests_status ON privacy_requests(status, created_at);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  target TEXT NOT NULL CHECK (target IN ('customer', 'operations')),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  provider_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_due ON notification_outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS mfa_replay_guard (
  subject TEXT PRIMARY KEY,
  timestep INTEGER NOT NULL,
  accepted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_proofs (
  order_id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT,
  recipient_name TEXT
);

CREATE TABLE IF NOT EXISTS vendor_availability (
  vendor_id TEXT PRIMARY KEY,
  vendor_name TEXT NOT NULL,
  service_zones TEXT NOT NULL CHECK (json_valid(service_zones)),
  service_types TEXT NOT NULL CHECK (json_valid(service_types)),
  capacity_remaining INTEGER NOT NULL DEFAULT 0 CHECK (capacity_remaining >= 0),
  availability_status TEXT NOT NULL,
  next_available_at TEXT,
  updated_by TEXT NOT NULL,
  notes TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vendor_availability_status_capacity ON vendor_availability(availability_status, capacity_remaining);

CREATE TABLE IF NOT EXISTS driver_availability (
  driver_id TEXT PRIMARY KEY,
  driver_name TEXT NOT NULL,
  service_zones TEXT NOT NULL CHECK (json_valid(service_zones)),
  vehicle TEXT,
  capacity_remaining INTEGER NOT NULL DEFAULT 0 CHECK (capacity_remaining >= 0),
  availability_status TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  notes TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_driver_availability_status_capacity ON driver_availability(availability_status, capacity_remaining);

CREATE TABLE IF NOT EXISTS vendor_declines (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  vendor_id TEXT NOT NULL,
  vendor_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  declined_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vendor_declines_order_id ON vendor_declines(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_declines_order_vendor ON vendor_declines(order_id COLLATE NOCASE, vendor_id);

CREATE TABLE IF NOT EXISTS assignment_capacity_reservations (
  reservation_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  vendor_id TEXT,
  driver_id TEXT,
  vendor_released_at TEXT,
  driver_released_at TEXT,
  release_reason TEXT,
  created_at TEXT NOT NULL,
  CHECK (vendor_id IS NOT NULL OR driver_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_capacity_reservations_order_id ON assignment_capacity_reservations(order_id COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_capacity_reservations_order_vendor
  ON assignment_capacity_reservations(order_id COLLATE NOCASE, vendor_id)
  WHERE vendor_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_capacity_reservations_order_driver
  ON assignment_capacity_reservations(order_id COLLATE NOCASE, driver_id)
  WHERE driver_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS assignment_capacity_validate
BEFORE INSERT ON assignment_capacity_reservations
BEGIN
  SELECT CASE
    WHEN NEW.vendor_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM vendor_availability
      WHERE vendor_id = NEW.vendor_id
        AND capacity_remaining > 0
        AND lower(availability_status) NOT GLOB '*paused*'
        AND lower(availability_status) NOT GLOB '*closed*'
        AND lower(availability_status) NOT GLOB '*unavailable*'
        AND lower(availability_status) NOT GLOB '*inactive*'
        AND lower(availability_status) NOT GLOB '*suspended*'
        AND lower(availability_status) NOT GLOB '*tomorrow*'
    ) THEN RAISE(ABORT, 'Vendor capacity is no longer available.')
  END;
  SELECT CASE
    WHEN NEW.driver_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM driver_availability
      WHERE driver_id = NEW.driver_id
        AND capacity_remaining > 0
        AND lower(availability_status) NOT GLOB '*inactive*'
        AND lower(availability_status) NOT GLOB '*suspended*'
        AND lower(availability_status) NOT GLOB '*offboarded*'
        AND lower(availability_status) NOT GLOB '*paused*'
        AND lower(availability_status) NOT GLOB '*training*'
        AND lower(availability_status) NOT GLOB '*tomorrow*'
    ) THEN RAISE(ABORT, 'Driver capacity is no longer available.')
  END;
END;

CREATE TRIGGER IF NOT EXISTS assignment_capacity_reserve
AFTER INSERT ON assignment_capacity_reservations
BEGIN
  UPDATE vendor_availability
  SET capacity_remaining = capacity_remaining - 1, updated_at = NEW.created_at
  WHERE vendor_id = NEW.vendor_id;
  UPDATE driver_availability
  SET capacity_remaining = capacity_remaining - 1, updated_at = NEW.created_at
  WHERE driver_id = NEW.driver_id;
END;

CREATE TRIGGER IF NOT EXISTS assignment_capacity_release
AFTER UPDATE OF vendor_released_at, driver_released_at ON assignment_capacity_reservations
BEGIN
  UPDATE vendor_availability
  SET capacity_remaining = MIN(capacity_remaining + 1, 999), updated_at = NEW.vendor_released_at
  WHERE vendor_id = NEW.vendor_id AND OLD.vendor_released_at IS NULL AND NEW.vendor_released_at IS NOT NULL;
  UPDATE driver_availability
  SET capacity_remaining = MIN(capacity_remaining + 1, 999), updated_at = NEW.driver_released_at
  WHERE driver_id = NEW.driver_id AND OLD.driver_released_at IS NULL AND NEW.driver_released_at IS NOT NULL;
END;

CREATE TABLE IF NOT EXISTS staff_credentials (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'vendor', 'driver', 'support')),
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  entity_id TEXT,
  totp_secret TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_staff_credentials_role ON staff_credentials(role, active);

CREATE TABLE IF NOT EXISTS migration_imports (
  import_id TEXT PRIMARY KEY,
  source_sha TEXT NOT NULL,
  source_database_sha256 TEXT NOT NULL,
  table_name TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE (source_database_sha256, table_name, chunk_index)
);
