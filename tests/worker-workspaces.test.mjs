import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/components/StaffWorkspaces.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../src/app/globals.css", import.meta.url), "utf8");

test("all existing role workspaces retain their shared authenticated shell", () => {
  for (const role of ["Admin", "Vendor", "Driver", "Support"]) {
    assert.match(source, new RegExp("export function " + role + "Workspace"));
  }
  assert.match(source, /role === "admin" && pageRole !== "admin"/);
  assert.match(source, /href="\/admin">Admin home/);
});

test("rider routes remain available in an accessible native disclosure", () => {
  assert.match(source, /<details className="staffRouteDisclosure"><summary>/);
  assert.match(source, /<DispatchBoard orders=\{orders\} role="driver"/);
  assert.match(source, /<DriverLiveLocationSharing key=\{selectedOrder.orderId\}/);
});

test("staff navigation does not depend on hidden horizontal scrolling", () => {
  const rules = css.slice(css.indexOf("/* Worker workspaces:"));
  assert.match(rules, /\.portalPage \.staffSectionNav \{[^}]*overflow: visible/);
  assert.match(rules, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(rules, /min-height: 44px/);
  assert.doesNotMatch(rules, /box-shadow|linear-gradient|text-overflow: ellipsis/);
});

test("phase countdown stops ticking on expiry and restarts only for a new deadline", () => {
  const component = source.slice(source.indexOf("function StageCountdown"), source.indexOf("function AvailabilityBoard"));
  assert.match(component, /if \(tick\(\) === "running"\) timer = window.setInterval/);
  assert.match(component, /next.state !== "running" && timer !== undefined/);
  assert.match(component, /\[order.updatedAt, order.stageTimer.targetMinutes\]/);
  assert.doesNotMatch(component, /Math.abs/);
  assert.match(component, /"Overdue"/);
  assert.match(component, /"Unavailable"/);
});


test("support bag scans open the order view that consumes selectedOrderId", async () => {
  const scan = await readFile(new URL("../src/app/scan/page.tsx", import.meta.url), "utf8");
  assert.match(scan, /user.role === "support" \? "\/support\?view=orders"/);
  assert.match(source, /initialView === "orders" \? <SharedOrderBoard role="support"/);
});
