BEGIN;

CREATE TABLE submissions (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  source text,
  data jsonb NOT NULL
);
CREATE INDEX submissions_created_at_idx ON submissions (created_at DESC);
CREATE INDEX submissions_order_id_idx ON submissions ((data->>'orderId'));

CREATE TABLE rate_limits (key text PRIMARY KEY, count integer NOT NULL, reset_at bigint NOT NULL);
CREATE INDEX rate_limits_reset_at_idx ON rate_limits (reset_at);
CREATE TABLE workflow_action_claims (claim_key text PRIMARY KEY, order_id text NOT NULL, action_key text NOT NULL, order_updated_at timestamptz NOT NULL, claimed_at timestamptz NOT NULL);
CREATE INDEX workflow_action_claims_order_idx ON workflow_action_claims (order_id);
CREATE TABLE payment_verifications (reference text NOT NULL, status text NOT NULL, transaction_id text, amount_minor integer NOT NULL, currency text NOT NULL, record_id text NOT NULL, verified_at timestamptz NOT NULL, PRIMARY KEY (reference, status));

CREATE TABLE driver_live_locations (driver_id text PRIMARY KEY, order_id text NOT NULL, latitude double precision NOT NULL CHECK (latitude BETWEEN 5.45 AND 5.95), longitude double precision NOT NULL CHECK (longitude BETWEEN -0.45 AND 0.2), accuracy_meters double precision NOT NULL CHECK (accuracy_meters > 0 AND accuracy_meters <= 1000), captured_at timestamptz NOT NULL, received_at timestamptz NOT NULL);
CREATE INDEX driver_live_locations_order_idx ON driver_live_locations (order_id);

CREATE TABLE early_access_signups (id text PRIMARY KEY, first_name text NOT NULL, phone text NOT NULL UNIQUE, email text, area text NOT NULL, frequency text NOT NULL, consent_at timestamptz NOT NULL, consent_version text NOT NULL, marketing_status text NOT NULL CHECK (marketing_status IN ('active', 'opted_out')), created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
CREATE TABLE privacy_requests (id text PRIMARY KEY, request_type text NOT NULL CHECK (request_type IN ('access', 'correction', 'deletion', 'marketing_opt_out')), name text NOT NULL, contact text NOT NULL, order_id text, status text NOT NULL CHECK (status IN ('received', 'identity_review', 'completed', 'declined')), created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);

CREATE TABLE notification_outbox (id text PRIMARY KEY, dedupe_key text NOT NULL UNIQUE, channel text NOT NULL CHECK (channel IN ('email', 'whatsapp')), target text NOT NULL CHECK (target IN ('customer', 'operations')), payload jsonb NOT NULL, status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')), attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL, provider_id text, last_error text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, sent_at timestamptz);
CREATE INDEX notification_outbox_due_idx ON notification_outbox (status, next_attempt_at);
CREATE TABLE mfa_replay_guard (subject text PRIMARY KEY, timestep bigint NOT NULL, accepted_at timestamptz NOT NULL);
CREATE TABLE delivery_proofs (order_id text PRIMARY KEY, code_hash text NOT NULL, created_at timestamptz NOT NULL, used_at timestamptz, used_by text, recipient_name text);

CREATE TABLE vendor_availability (vendor_id text PRIMARY KEY, vendor_name text NOT NULL, service_zones jsonb NOT NULL, service_types jsonb NOT NULL, capacity_remaining integer NOT NULL, availability_status text NOT NULL, updated_at timestamptz NOT NULL, updated_by text NOT NULL, notes text NOT NULL);
CREATE TABLE driver_availability (driver_id text PRIMARY KEY, driver_name text NOT NULL, service_zones jsonb NOT NULL, vehicle text NOT NULL, capacity_remaining integer NOT NULL, availability_status text NOT NULL, updated_at timestamptz NOT NULL, updated_by text NOT NULL, notes text NOT NULL);
CREATE TABLE vendor_declines (id text PRIMARY KEY, order_id text NOT NULL, vendor_id text, vendor_name text NOT NULL, reason text NOT NULL, declined_by text NOT NULL, created_at timestamptz NOT NULL);
CREATE TABLE assignment_capacity_reservations (reservation_id text PRIMARY KEY, order_id text NOT NULL, vendor_id text NOT NULL, driver_id text NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL, released_at timestamptz, release_reason text);

COMMIT;
