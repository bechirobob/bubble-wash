-- See 0003 for why this trigger is isolated and its final `end` is lowercase.
CREATE TRIGGER IF NOT EXISTS assignment_capacity_reserve
AFTER INSERT ON assignment_capacity_reservations
BEGIN
  UPDATE vendor_availability
  SET capacity_remaining = capacity_remaining - 1, updated_at = NEW.created_at
  WHERE vendor_id = NEW.vendor_id;
  UPDATE driver_availability
  SET capacity_remaining = capacity_remaining - 1, updated_at = NEW.created_at
  WHERE driver_id = NEW.driver_id;
end;
