import test from "node:test";
import assert from "node:assert/strict";
import { selectAssignmentPair } from "../src/lib/assignment.ts";

const now = new Date("2026-05-29T12:00:00.000Z").toISOString();
const later = new Date("2026-05-29T13:00:00.000Z").toISOString();

test("selectAssignmentPair prefers available vendor matching the order area and latest active driver", () => {
  const result = selectAssignmentPair([
    { id: "v1", createdAt: now, data: { submissionType: "vendor-application", name: "Ama", company: "CleanPro Osu", area: "Osu, Labone", availability: "Available today", capacity: "120kg" } },
    { id: "v2", createdAt: later, data: { submissionType: "vendor-application", name: "Kojo", company: "Paused Laundry", area: "Osu", availability: "Paused today", capacity: "400kg" } },
    { id: "d1", createdAt: now, data: { submissionType: "driver-onboarding", name: "Kofi Route 1", phone: "0550000000", area: "Osu, Labone", driverStatus: "Active" } },
  ], { area: "Osu", driver: "Unassigned", vendor: "Unassigned" });

  assert.equal(result.vendorName, "CleanPro Osu");
  assert.equal(result.driverName, "Kofi Route 1");
  assert.match(result.assignmentNote, /vendor capacity/i);
});

test("selectAssignmentPair keeps existing assignments when already present", () => {
  const result = selectAssignmentPair([], { area: "Osu", vendor: "Existing Vendor", driver: "Existing Driver" });
  assert.equal(result.vendorName, "Existing Vendor");
  assert.equal(result.driverName, "Existing Driver");
});

test("selectAssignmentPair falls back safely when no available vendor or active driver exists", () => {
  const result = selectAssignmentPair([
    { id: "v1", createdAt: now, data: { submissionType: "vendor-application", company: "Paused Laundry", availability: "Paused today" } },
    { id: "d1", createdAt: now, data: { submissionType: "driver-onboarding", name: "Old Driver", driverStatus: "Inactive" } },
  ], { area: "Tema", vendor: "Unassigned", driver: "Unassigned" });

  assert.equal(result.vendorName, "Needs admin review");
  assert.equal(result.driverName, "Needs admin onboarding");
});

test("selectAssignmentPair does not assign an otherwise available out-of-zone team", () => {
  const result = selectAssignmentPair([
    { id: "v1", createdAt: now, data: { submissionType: "vendor-application", company: "Tema Laundry", area: "Tema", availability: "Available today" } },
    { id: "d1", createdAt: now, data: { submissionType: "driver-onboarding", name: "Tema Rider", area: "Tema", driverStatus: "Active" } },
  ], { area: "Osu", vendor: "Unassigned", driver: "Unassigned" });

  assert.equal(result.vendorName, "Needs admin review");
  assert.equal(result.driverName, "Needs admin onboarding");
});
