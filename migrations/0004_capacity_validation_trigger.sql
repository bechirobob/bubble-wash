-- This single-trigger layout preserves the final semicolon through Wrangler's
-- remote D1 statement splitter. The nested CASE terminators stay uppercase.
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
end;
