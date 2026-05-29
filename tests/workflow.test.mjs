import test from "node:test";
import assert from "node:assert/strict";
import { automationActionsForOrder, workflowStageFromStatus } from "../src/lib/order-workflow.ts";

const baseOrder = {
  orderId: "BW-TEST-001",
  updatedAt: "2026-05-29T12:00:00.000Z",
  customer: "Ama Customer",
  email: "ama@example.com",
  phone: "0550000000",
  area: "Osu",
  vendor: "CleanPro Osu",
  driver: "Kofi Route 1",
  routeWindow: "2 PM - 4 PM",
  locationNote: "Near Oxford Street",
  status: "Vendor assigned",
  workflowStage: workflowStageFromStatus("Vendor assigned", "admin-operation"),
  payment: "MTN MoMo",
  priority: "Normal",
  nextStep: "Vendor should accept.",
  eventCount: 2,
  lastEventType: "admin-operation",
  route: { googleMapsUrl: "https://maps.google.com", directionsUrl: "https://maps.google.com", zoneLabel: "Osu", zoneNote: "" },
  stageTimer: { label: "Due in 120 min", tone: "ok", elapsedMinutes: 0, targetMinutes: 180 },
  timeline: [],
};

test("vendor assigned orders expose accept and decline actions", () => {
  const actions = automationActionsForOrder(baseOrder, "vendor", "Vendor Partner");
  assert.ok(actions.some((action) => action.key === "vendor-accept-job"));
  const decline = actions.find((action) => action.key === "vendor-decline-job");
  assert.ok(decline, "decline action should be present");
  assert.equal(decline.nextStatus, "Needs attention");
  assert.equal(decline.payload.jobStatus, "Declined");
});

test("admin can reassign orders in Needs Attention after a vendor decline", () => {
  const exceptionOrder = {
    ...baseOrder,
    status: "Needs attention",
    workflowStage: workflowStageFromStatus("Needs attention", "vendor-job-update"),
    lastEventType: "vendor-job-update",
  };
  const actions = automationActionsForOrder(exceptionOrder, "admin", "Admin Operator");
  assert.ok(actions.some((action) => action.key === "admin-assign-vendor"));
});
