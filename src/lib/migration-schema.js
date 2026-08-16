export const migrationTables = Object.freeze({
  submissions: { columns: ["id", "created_at", "source", "data"], orderBy: ["id"] },
  rate_limits: { columns: ["key", "count", "reset_at"], orderBy: ["key"] },
  workflow_action_claims: { columns: ["claim_key", "order_id", "action_key", "order_updated_at", "claimed_at"], orderBy: ["claim_key"] },
  payment_verifications: { columns: ["reference", "status", "transaction_id", "amount_minor", "currency", "record_id", "verified_at", "submission_created_at", "submission_source", "submission_data"], orderBy: ["reference", "status"] },
  driver_live_locations: { columns: ["driver_id", "order_id", "latitude", "longitude", "accuracy_meters", "captured_at", "received_at"], orderBy: ["driver_id"] },
  early_access_signups: { columns: ["id", "first_name", "phone", "email", "area", "frequency", "consent_at", "consent_version", "marketing_status", "created_at", "updated_at"], orderBy: ["id"] },
  privacy_requests: { columns: ["id", "request_type", "name", "contact", "order_id", "status", "created_at", "updated_at"], orderBy: ["id"] },
  notification_outbox: { columns: ["id", "dedupe_key", "channel", "target", "payload", "status", "attempts", "next_attempt_at", "provider_id", "last_error", "created_at", "updated_at", "sent_at"], orderBy: ["id"] },
  mfa_replay_guard: { columns: ["subject", "timestep", "accepted_at"], orderBy: ["subject"] },
  delivery_proofs: { columns: ["order_id", "code_hash", "created_at", "used_at", "used_by", "recipient_name"], orderBy: ["order_id"] },
  vendor_availability: { columns: ["vendor_id", "vendor_name", "service_zones", "service_types", "capacity_remaining", "availability_status", "next_available_at", "updated_by", "notes", "updated_at"], orderBy: ["vendor_id"] },
  driver_availability: { columns: ["driver_id", "driver_name", "service_zones", "vehicle", "capacity_remaining", "availability_status", "updated_by", "notes", "updated_at"], orderBy: ["driver_id"] },
  vendor_declines: { columns: ["id", "order_id", "vendor_id", "vendor_name", "reason", "declined_by", "created_at"], orderBy: ["id"] },
  assignment_capacity_reservations: { columns: ["reservation_id", "order_id", "vendor_id", "driver_id", "vendor_released_at", "driver_released_at", "release_reason", "created_at"], orderBy: ["reservation_id"] },
  staff_credentials: { columns: ["email", "role", "name", "password_hash", "entity_id", "totp_secret", "active", "updated_at"], orderBy: ["email"] },
});

export const migrationTableNames = Object.freeze(Object.keys(migrationTables));

export const migrationTriggers = Object.freeze({
  payment_verification_submission: `
    CREATE TRIGGER payment_verification_submission
    AFTER INSERT ON payment_verifications
    WHEN NEW.submission_created_at IS NOT NULL AND NEW.submission_data IS NOT NULL
    BEGIN
      INSERT INTO submissions (id, created_at, source, data)
      VALUES (NEW.record_id, NEW.submission_created_at, NEW.submission_source, NEW.submission_data);
    END`,
  assignment_capacity_validate: `
    CREATE TRIGGER assignment_capacity_validate
    BEFORE INSERT ON assignment_capacity_reservations
    BEGIN
      SELECT CASE WHEN NEW.vendor_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM vendor_availability WHERE vendor_id = NEW.vendor_id AND capacity_remaining > 0
          AND lower(availability_status) NOT GLOB '*paused*' AND lower(availability_status) NOT GLOB '*closed*'
          AND lower(availability_status) NOT GLOB '*unavailable*' AND lower(availability_status) NOT GLOB '*inactive*'
          AND lower(availability_status) NOT GLOB '*suspended*' AND lower(availability_status) NOT GLOB '*tomorrow*'
      ) THEN RAISE(ABORT, 'Vendor capacity is no longer available.') END;
      SELECT CASE WHEN NEW.driver_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM driver_availability WHERE driver_id = NEW.driver_id AND capacity_remaining > 0
          AND lower(availability_status) NOT GLOB '*inactive*' AND lower(availability_status) NOT GLOB '*suspended*'
          AND lower(availability_status) NOT GLOB '*offboarded*' AND lower(availability_status) NOT GLOB '*paused*'
          AND lower(availability_status) NOT GLOB '*training*' AND lower(availability_status) NOT GLOB '*tomorrow*'
      ) THEN RAISE(ABORT, 'Driver capacity is no longer available.') END;
    END`,
  assignment_capacity_reserve: `
    CREATE TRIGGER assignment_capacity_reserve
    AFTER INSERT ON assignment_capacity_reservations
    BEGIN
      UPDATE vendor_availability SET capacity_remaining = capacity_remaining - 1, updated_at = NEW.created_at WHERE vendor_id = NEW.vendor_id;
      UPDATE driver_availability SET capacity_remaining = capacity_remaining - 1, updated_at = NEW.created_at WHERE driver_id = NEW.driver_id;
    END`,
  assignment_capacity_release: `
    CREATE TRIGGER assignment_capacity_release
    AFTER UPDATE OF vendor_released_at, driver_released_at ON assignment_capacity_reservations
    BEGIN
      UPDATE vendor_availability SET capacity_remaining = MIN(capacity_remaining + 1, 999), updated_at = NEW.vendor_released_at
        WHERE vendor_id = NEW.vendor_id AND OLD.vendor_released_at IS NULL AND NEW.vendor_released_at IS NOT NULL;
      UPDATE driver_availability SET capacity_remaining = MIN(capacity_remaining + 1, 999), updated_at = NEW.driver_released_at
        WHERE driver_id = NEW.driver_id AND OLD.driver_released_at IS NULL AND NEW.driver_released_at IS NOT NULL;
    END`,
});
