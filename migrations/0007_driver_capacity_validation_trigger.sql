-- Driver validation is isolated from vendor validation to avoid nested CASE
-- blocks in Wrangler's remote D1 migration path.
CREATE TRIGGER IF NOT EXISTS assignment_driver_capacity_validate
BEFORE INSERT ON assignment_capacity_reservations
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
)
BEGIN
  SELECT RAISE(ABORT, 'Driver capacity is no longer available.');
end;
