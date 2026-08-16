-- See 0003 for why this trigger is isolated and its final `end` is lowercase.
CREATE TRIGGER IF NOT EXISTS assignment_capacity_release
AFTER UPDATE OF vendor_released_at, driver_released_at ON assignment_capacity_reservations
BEGIN
  UPDATE vendor_availability
  SET capacity_remaining = MIN(capacity_remaining + 1, 999), updated_at = NEW.vendor_released_at
  WHERE vendor_id = NEW.vendor_id AND OLD.vendor_released_at IS NULL AND NEW.vendor_released_at IS NOT NULL;
  UPDATE driver_availability
  SET capacity_remaining = MIN(capacity_remaining + 1, 999), updated_at = NEW.driver_released_at
  WHERE driver_id = NEW.driver_id AND OLD.driver_released_at IS NULL AND NEW.driver_released_at IS NOT NULL;
end;
