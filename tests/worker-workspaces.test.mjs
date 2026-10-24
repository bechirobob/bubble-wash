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
  assert.ok(source.includes('<DriverLiveLocationSharing key={`${selectedOrder.orderId}:${liveLocationStages.has(selectedOrder.workflowStage.key)}`}'));
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
  assert.match(source, /initialView === "orders" \? <SharedOrderBoard allStaffAccess=\{allStaffAccess\} role=\{role\}/);
});

test("small worker headers preserve logo proportions and whole navigation words", () => {
  const rules = css.slice(css.indexOf("/* Worker workspaces:"));
  assert.match(rules, /\.staffSectionNav a span \{ overflow-wrap: normal; \}/);
  assert.match(rules, /\.staffTopbar \.brandArtwork \{ width: 64px; height: 46px;/);
  assert.match(rules, /\.staffTopbar \.brandMark \{ width: 102px; height: 102px; \}/);
  assert.match(rules, /@media \(max-width: 400px\) \{\s*\.portalPage \.staffSectionNav \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
});


test("terminal orders do not present a waiting state or duplicate empty actions", () => {
  const component = source.slice(source.indexOf("function AutomatedOrderActions"), source.indexOf("function CustomerContactActions"));
  assert.match(component, /order.workflowStage.key === "closed" \? "Order closed"/);
  assert.match(component, /order.workflowStage.key === "cancelled" \? "Order cancelled"/);
  assert.match(component, /isClosedOrder\(order\) \? "No further action required."/);
  assert.match(component, /No action is currently available for this role./);
  assert.doesNotMatch(component, /Waiting/);
});

test("quality choices fit small screens without changing persisted values", () => {
  assert.ok(source.includes('name="qualityCheck" aria-describedby={`quality-check-help-${order.orderId}`}'));
  assert.match(source, /<option value="Count, finish, and packaging checked">Checks complete<\/option>/);
  assert.match(source, /<option value="Ready with noted exception">Noted exception<\/option>/);
  assert.ok(source.includes('id={`quality-check-help-${order.orderId}`}>Check count, finish, and packaging. Record any exception in the dispatch note.'));
});


test("order queue headers and rows reserve the same action column width", () => {
  const desktop = css.match(/\.staffOrderListHeader,\s*\.staffOrderRow \{([^}]+)\}/)?.[1];
  assert.ok(desktop);
  assert.match(desktop, /grid-template-columns: minmax\(160px, 1\.1fr\) minmax\(135px, \.8fr\) minmax\(155px, 1fr\) minmax\(180px, 1\.05fr\) 7rem;/);
  const tablet = css.match(/\.portalPage \.staffOrderListHeader, \.portalPage \.staffOrderRow \{([^}]+)\}/)?.[1];
  assert.ok(tablet);
  assert.match(tablet, /grid-template-columns: minmax\(0, 1\.1fr\) minmax\(0, \.8fr\) minmax\(0, 1fr\) minmax\(0, 1fr\) 7rem;/);
});

test("structured form fields do not stretch beside labels with help text", () => {
  assert.match(css, /\.portalPage \.structuredActionForm \.two \{ align-items: start; \}/);
});


test("GPS lifecycle fences pending work and resets presentation on cancellation", () => {
  const component = source.slice(source.indexOf("function DriverLiveLocationSharing"), source.indexOf("function DispatchBoard"));
  assert.match(component, /action: "start", orderId: order.orderId/);
  assert.match(component, /if \(watchRunRef.current !== run\) return; \/\/ Cancel\/unmount/);
  assert.match(component, /pendingStart.then\(\(value\) => stopLocationSession\(order.orderId, value, true\)\)/);
  assert.match(component, /pendingUpdateRef.current\?\.controller.abort\(\)/);
  assert.match(component, /if \(pendingUpdateRef.current === pendingUpdate\) pendingUpdateRef.current = null/);
  assert.doesNotMatch(component, /watchRunRef.current === run \+ 1/);
  const clear = component.slice(component.indexOf("function clearLocationWatch"), component.indexOf("useEffect"));
  assert.match(clear, /setLastSentAt\(""\)/); assert.match(clear, /setAccuracyMeters\(0\)/);
});
