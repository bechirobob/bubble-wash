import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.BUBBLEWASH_DATABASE_PATH = path.join(mkdtempSync(path.join(tmpdir(), "bubblewash-availability-")), "test.sqlite");

const store = await import("../src/lib/availability-store.ts");
const assignment = await import("../src/lib/assignment.ts");

test("vendor availability rows are upserted into a real table and decrement on assignment", () => {
  store.resetDataStoreForTests();
  const vendor = store.upsertVendorAvailability({
    vendorId: "vendor-cleanpro-osu",
    vendorName: "CleanPro Osu",
    serviceZones: ["Osu", "Labone"],
    serviceTypes: ["wash-fold", "ironing"],
    capacityRemaining: 2,
    availabilityStatus: "available",
    nextAvailableAt: "2026-05-29T14:00:00.000Z",
    updatedBy: "Admin Operator",
    notes: "Fast lane today",
  });

  assert.equal(vendor.capacityRemaining, 2);
  assert.equal(store.listVendorAvailability()[0].vendorName, "CleanPro Osu");

  const reserved = store.reserveVendorCapacity(vendor.vendorId, "BW-ORDER-1");
  assert.equal(reserved.capacityRemaining, 1);
  assert.equal(store.listVendorAvailability()[0].capacityRemaining, 1);
});

test("assignment prefers available matching vendor and active matching driver from availability tables", () => {
  store.resetDataStoreForTests();
  store.upsertVendorAvailability({ vendorId: "vendor-east", vendorName: "East Vendor", serviceZones: ["East Legon"], serviceTypes: ["wash-fold"], capacityRemaining: 5, availabilityStatus: "available", updatedBy: "Admin" });
  store.upsertVendorAvailability({ vendorId: "vendor-osu", vendorName: "Osu Vendor", serviceZones: ["Osu", "Labone"], serviceTypes: ["wash-fold"], capacityRemaining: 1, availabilityStatus: "available", updatedBy: "Admin" });
  store.upsertDriverAvailability({ driverId: "driver-osu", driverName: "Kofi Route", serviceZones: ["Osu"], vehicle: "Bike 7", availabilityStatus: "active", capacityRemaining: 3, updatedBy: "Admin" });

  const result = assignment.assignOrderFromAvailability({ orderId: "BW-ORDER-2", area: "Osu", serviceType: "wash-fold", vendor: "Unassigned", driver: "Unassigned" });

  assert.equal(result.vendorName, "Osu Vendor");
  assert.equal(result.driverName, "Kofi Route");
  assert.equal(result.vendorCapacityRemaining, 0);
  assert.equal(result.driverCapacityRemaining, 2);
});

test("vendor decline records reason, releases vendor capacity, and keeps order available for reassignment", () => {
  store.resetDataStoreForTests();
  store.upsertVendorAvailability({ vendorId: "vendor-osu", vendorName: "Osu Vendor", serviceZones: ["Osu"], serviceTypes: ["wash-fold"], capacityRemaining: 0, availabilityStatus: "available", updatedBy: "Admin" });

  const decline = store.recordVendorDecline({ orderId: "BW-ORDER-3", vendorId: "vendor-osu", vendorName: "Osu Vendor", reason: "Washer outage", declinedBy: "Vendor Partner" });

  assert.equal(decline.reason, "Washer outage");
  assert.equal(store.listVendorDeclines("BW-ORDER-3").length, 1);
  assert.equal(store.listVendorAvailability()[0].capacityRemaining, 1);
});

test("paused vendors and inactive drivers are excluded from assignment", () => {
  store.resetDataStoreForTests();
  store.upsertVendorAvailability({ vendorId: "vendor-paused", vendorName: "Paused Vendor", serviceZones: ["Osu"], serviceTypes: ["wash-fold"], capacityRemaining: 5, availabilityStatus: "paused", updatedBy: "Admin" });
  store.upsertDriverAvailability({ driverId: "driver-inactive", driverName: "Inactive Driver", serviceZones: ["Osu"], availabilityStatus: "inactive", capacityRemaining: 5, updatedBy: "Admin" });

  const result = assignment.assignOrderFromAvailability({ orderId: "BW-ORDER-4", area: "Osu", serviceType: "wash-fold", vendor: "Unassigned", driver: "Unassigned" });

  assert.equal(result.vendorName, "Needs admin review");
  assert.equal(result.driverName, "Needs admin onboarding");
});
