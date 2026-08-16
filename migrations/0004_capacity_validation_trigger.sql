-- Keep this as one trigger with no nested CASE block so Wrangler and D1 agree
-- on the compound-statement boundary.
CREATE TRIGGER IF NOT EXISTS assignment_vendor_capacity_validate
BEFORE INSERT ON assignment_capacity_reservations
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
)
BEGIN
  SELECT RAISE(ABORT, 'Vendor capacity is no longer available.');
end;
