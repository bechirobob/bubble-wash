"use client";
import { InvoiceApprovalForm } from "./InvoiceApprovalForm";
import { UatTestAccounts } from "./UatTestAccounts";
import "./staff-desk.css";
import { ClipboardList, Check, MapPin, ScanLine } from "lucide-react";
import { bookingLabel } from "@/lib/booking-label";
import { staffActivitySubject as activitySubject } from "@/lib/staff-activity-projection";
import { StaffAccountPanel, StaffInvoicePanel, CustomerDecisionPanel } from "./StaffAdminControls";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { BoundedList } from "./BoundedList";
import { VendorCapacityForm } from "./VendorCapacityForm";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StaffRole } from "@/lib/auth";
import { automationActionsForOrder } from "@/lib/order-workflow";
import { stageCountdown } from "@/lib/stage-countdown";
import { validLocationGeneration, LIVE_LOCATION_MAX_FUTURE_SKEW_MS, LIVE_LOCATION_MAX_CAPTURE_AGE_MS } from "@/lib/dispatch-location";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";
import { BrandLink } from "@/components/BrandLink";

const supportTypes = ["Pickup delay", "Payment issue", "Missing item", "Quality complaint", "Vendor escalation", "General question"];

type PortalShellProps = {
  headingAction?: ReactNode;
  heading?: { eyebrow: string; title: string; subtitle: string };
  allStaffAccess?: boolean;
  operationalWorkspaceAccess?: boolean;
  surveyResultsAccess?: boolean;
  title: string;
  role: StaffRole;
  pageRole?: StaffRole;
  userName: string;
  currentView: string;
  navigation: Array<{ href: string; label: string; view: string; secondary?: boolean }>;
  children: ReactNode;
};

type SubmissionRecord = {
  id: string;
  createdAt: string;
  data: Record<string, string>;
};

type OrderSummary = {
  bookingReference?: string | null;
  vendorCode?: string | null;
  orderId: string;
  updatedAt: string;
  activityUpdatedAt: string;
  customer: string;
  email: string;
  phone: string;
  area: string;
  pickupAddress: string;
  landmark: string;
  plan: string;
  serviceType: string;
  vendor: string;
  driver: string;
  driverId?: string;
  routeWindow: string;
  locationNote: string;
  status: string;
  workflowStage: { key: string; label: string; targetMinutes: number; customerNext: string; staffNext: string };
  payment: string;
  priority: string;
  nextStep: string;
  eventCount: number;
  lastEventType: string;
  route: {
    pickup: { label: string; lat: number; lng: number };
    hub: { label: string; lat: number; lng: number };
    zoneKey: string;
    googleMapsUrl: string;
    directionsUrl: string;
    zoneLabel: string;
    zoneNote: string;
    estimatedDistanceKm: number;
    estimatedDriveMinutes: number;
  };
  dispatch?: {
    scheduledWindow: string;
    estimatedDistanceKm: number;
    estimatedDriveMinutes: number;
    etaText: string;
    etaSource: "rider-reported" | "area-estimate" | "scheduled-window" | "unavailable";
    etaUpdatedAt: string;
    checkpoint: string;
    checkpointSource: "rider-reported" | "rider-route-update" | "unavailable";
    checkpointUpdatedAt: string;
  };
  stageTimer: { label: string; tone: "ok" | "due" | "breached" | "paused"; elapsedMinutes: number; targetMinutes: number };
  timeline: Array<{ id: string; createdAt: string; type: string; status: string; actor: string; note: string }>;
};

type DispatchLiveLocation = {
  driverId: string;
  driverName: string;
  orderId: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAt: string;
  receivedAt: string;
  state: "live" | "recent" | "offline";
  live: boolean;
};

function workTiming(order: OrderSummary) {
  const { targetMinutes, elapsedMinutes } = order.stageTimer;
  if (!Number.isFinite(targetMinutes) || !Number.isFinite(elapsedMinutes) || targetMinutes <= 0) return order.stageTimer.tone === "paused" ? "No active deadline" : "Timing unavailable";
  const remaining = Math.round(targetMinutes - elapsedMinutes);
  const minutes = Math.abs(remaining);
  const duration = minutes >= 60 ? `${Math.floor(minutes / 60)} hr${minutes >= 120 ? "s" : ""}${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${minutes} min`;
  return remaining < 0 ? `Overdue by ${duration}` : remaining === 0 ? "Due now" : `Due in ${duration}`;
}

type SubmitHandler = (event: FormEvent<HTMLFormElement>, type: string) => Promise<void>;

type VendorAvailabilityRow = { vendorId: string; vendorName: string; serviceZones: string[]; serviceTypes: string[]; capacityRemaining: number; availabilityStatus: string; updatedAt: string; notes?: string };
type DriverAvailabilityRow = { driverId: string; driverName: string; serviceZones: string[]; vehicle?: string; capacityRemaining: number; availabilityStatus: string; updatedAt: string; notes?: string };
type VendorDeclineRow = { bookingReference?: string | null; id: string; orderId: string; vendorName: string; reason: string; declinedBy: string; createdAt: string };
type StaffRosterMember = { id: string; name: string; email: string; phone: string; role: string; status: string; workArea: string; access: "configured" | "roster-only"; updatedAt: string };

type AutomationAction = ReturnType<typeof automationActionsForOrder>[number];

type QueueStats = { focusLabel: string; focusCount: number; automationCount: number; riskCount: number; capacityLabel: string };
type QueueView = "action" | "active" | "all";
type WorkspaceProps = {
  temporaryAccess?: boolean;
  accessExpiresAt?: number;
  allStaffAccess?: boolean;
  operationalWorkspaceAccess?: boolean;
  surveyResultsAccess?: boolean;
  userName: string;
  role: StaffRole;
  initialView?: string;
  selectedOrderId?: string;
  selectedCaseId?: string;
  selectedActivityId?: string;
};
type SupportCase = {
  ticketId: string;
  orderId: string;
  root: SubmissionRecord;
  latest: SubmissionRecord;
  events: SubmissionRecord[];
  status: string;
  priority: string;
  assignedRole: string;
  escalationLevel: string;
};

function LaundryFlowIcon({ stage }: { stage: "collection" | "washing" | "return" }) {
  const paths = { collection: "M9 4h12l2 5H7zM7 9v17h16V9M11 4V2h8v2M11 15h8", washing: "M6 2h18v26H6zM6 8h18M10 5h1M15 5h5M15 12a6 6 0 1 0 0 12 6 6 0 0 0 0-12M10 18c3-3 7 3 10 0", return: "M3 7h15v15H3zM18 12h6l4 5v5H18M6 22a3 3 0 1 0 6 0M20 22a3 3 0 1 0 6 0" };
  return <svg className="staffFlowIcon" viewBox="0 0 30 30" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[stage]} /></svg>;
}

function noticeClass(message: string) {
  if (/(unable|failed|invalid|missing|required|not allowed|not available|too many|error)/i.test(message)) return "status error";
  if (/(waiting|pending|delayed|attention|warning|overdue)/i.test(message)) return "status warning";
  if (/(loading|checking|saving|updating|opening|starting|stopping)/i.test(message)) return "status info";
  if (/(saved|updated|loaded|received|verified|complete|copied|recorded|ready|success)/i.test(message)) return "status success";
  return "status";
}

function rolePromise(role: StaffRole, view: string) {
  const copy: Record<StaffRole, Record<string, { eyebrow: string; title: string; subtitle: string }>> = {
    admin: {
      overview: { eyebrow: "Operations", title: "Service board", subtitle: "" },
      dispatch: { eyebrow: "Dispatch", title: "Rider routes and ETAs", subtitle: "Assigned routes, pickup windows and rider updates." },
      orders: { eyebrow: "Orders", title: "Order operations", subtitle: "" },
      people: { eyebrow: "People & onboarding", title: "Partners and staff", subtitle: "" },
      cases: { eyebrow: "Support oversight", title: "Customer cases", subtitle: "" },
      activity: { eyebrow: "History", title: "Recent changes", subtitle: "Latest 80 saved updates." },
      operations: { eyebrow: "Administration", title: "Privacy requests", subtitle: "" },
    },
    vendor: {
      jobs: { eyebrow: "Vendor workspace", title: "Wash floor", subtitle: "" },
      capacity: { eyebrow: "Vendor capacity", title: "Today’s availability", subtitle: "" },
      activity: { eyebrow: "Vendor history", title: "Saved updates", subtitle: "" },
    },
    driver: {
      route: { eyebrow: "Driver workspace", title: "Your next stop", subtitle: "" },
      activity: { eyebrow: "Route history", title: "Saved route updates", subtitle: "" },
    },
    support: {
      cases: { eyebrow: "Support desk", title: "Customer cases", subtitle: "" },
      orders: { eyebrow: "Order follow-up", title: "Orders needing support", subtitle: "" },
      activity: { eyebrow: "Support history", title: "Saved support updates", subtitle: "" },
    },
  };
  return copy[role][view] ?? Object.values(copy[role])[0];
}

function isRiskOrder(order: OrderSummary) {
  return order.workflowStage.key === "exception" || order.stageTimer.tone === "breached" || order.priority === "Urgent";
}

function isClosedOrder(order: OrderSummary) {
  return ["closed", "cancelled"].includes(order.workflowStage.key);
}

function supportCases(records: SubmissionRecord[]) {
  const roots = records.filter((record) => activityType(record) === "support-ticket");
  const actions = records.filter((record) => activityType(record) === "support-ticket-action");
  return roots.map((root): SupportCase => {
    const ticketId = activityValue(root, "ticketId") || root.id;
    const orderId = activityValue(root, "orderId");
    const related = actions.filter((record) => {
      const actionTicketId = activityValue(record, "ticketId");
      return actionTicketId === ticketId || (!actionTicketId && activityValue(record, "orderId") === root.id);
    });
    const events = [root, ...related].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    const latest = events[events.length - 1];
    return {
      ticketId,
      orderId,
      root,
      latest,
      events,
      status: activityValue(latest, "ticketStatus") || activityValue(root, "ticketStatus") || "Open",
      priority: activityValue(latest, "priority") || activityValue(root, "priority") || "Normal",
      assignedRole: [...events].reverse().map((event) => activityValue(event, "assignedRole")).find(Boolean) || "Support",
      escalationLevel: [...events].reverse().map((event) => activityValue(event, "escalationLevel")).find(Boolean) || "Level 0",
    };
  }).sort((left, right) => {
    const leftClosed = /closed|resolved/i.test(left.status);
    const rightClosed = /closed|resolved/i.test(right.status);
    if (leftClosed !== rightClosed) return leftClosed ? 1 : -1;
    return new Date(right.latest.createdAt).getTime() - new Date(left.latest.createdAt).getTime();
  });
}

function orderMatchesRoleFocus(order: OrderSummary, role: StaffRole, userName: string, allStaffAccess = false) {
  const actions = automationActionsForOrder(order, role, userName, allStaffAccess);
  if (role === "admin") return isRiskOrder(order) || actions.length > 0;
  if (role === "vendor") return actions.some((action) => action.key.includes("vendor"));
  if (role === "driver") return actions.some((action) => action.key.includes("driver"));
  return isRiskOrder(order);
}

function queueStats(orders: OrderSummary[], role: StaffRole, userName: string, availabilityCount = 0, allStaffAccess = false): QueueStats {
  const automationCount = orders.reduce((count, order) => count + automationActionsForOrder(order, role, userName, allStaffAccess).length, 0);
  const focusCount = orders.filter((order) => orderMatchesRoleFocus(order, role, userName, allStaffAccess)).length;
  const riskCount = orders.filter(isRiskOrder).length;
  return {
    focusLabel: role === "admin" ? "awaiting intervention" : role === "vendor" ? "ready for action" : role === "driver" ? "route moves" : "follow-up now",
    focusCount,
    automationCount,
    riskCount,
    capacityLabel: availabilityCount ? `${availabilityCount} live capacity rows` : "capacity waiting",
  };
}

function formatShortTime(value: string) {
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatMetricTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const core = `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  return `${String(hours).padStart(2, "0")}:${core}`;
}

function workflowPhaseLabel(stageKey: string) {
  if (["received", "pickup-scheduled", "vendor-assigned", "vendor-accepted", "driver-en-route", "picked-up"].includes(stageKey)) return "Pickup leg";
  if (["at-vendor", "washing"].includes(stageKey)) return "Vendor processing";
  if (["ready", "out-for-delivery", "delivered", "closed"].includes(stageKey)) return "Return delivery";
  return "Exception review";
}

function compactTimelineLabel(count: number) {
  if (count <= 1) return "1 update";
  return `${count} updates`;
}

function formatActivityTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replace(",", "");
}

type ActivityCategory = "all" | "orders" | "support" | "onboarding" | "payments" | "ops";
type ActivityScope = "last24" | "older24" | "today" | "all";
type ActivityWindow = "20" | "50" | "80";
type ActivitySortKey = "saved" | "type" | "subject";
type ActivitySortDirection = "asc" | "desc";

function activityValue(record: SubmissionRecord, ...keys: string[]) {
  for (const key of keys) {
    const value = record.data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function activityType(record: SubmissionRecord) {
  return activityValue(record, "submissionType") || "update";
}

function activityEntityKey(record: SubmissionRecord) {
  const identitySubject = activityValue(record, "company", "staffName", "driverName", "name", "orderId", "ticketId") || "Bubble Wash request";
  return activityValue(record, "orderId", "ticketId", "email", "phone") || `${activityType(record)}:${identitySubject}`;
}

function activityCat…41332 tokens truncated…ity().filter((vendor) => statusAllowsVendor(vendor) && serviceMatches(vendor, serviceType) && !declinedVendorIds.has(vendor.vendorId));
  return available.find((vendor) => listMatches(vendor.serviceZones, area));
}

function selectAvailabilityDriver(area: string) {
  const active = listDriverAvailability().filter(statusAllowsDriver);
  return active.find((driver) => listMatches(driver.serviceZones, area));
}

function selectVendor(records: AssignmentRecord[], area: string) {
  const available = latestFirst(records).filter(isVendorAvailable);
  return available.find((record) => areaMatches(record, area));
}

function selectDriver(records: AssignmentRecord[], area: string) {
  const active = latestFirst(records).filter(isActiveDriver);
  return active.find((record) => areaMatches(record, area));
}

export function selectAssignmentPair(records: AssignmentRecord[], order: AssignmentOrder): AssignmentPair {
  const vendorRecord = isUnassigned(order.vendor) ? selectVendor(records, order.area) : undefined;
  const driverRecord = isUnassigned(order.driver) ? selectDriver(records, order.area) : undefined;
  const vendor = isUnassigned(order.vendor) ? (vendorRecord ? vendorName(vendorRecord) : "Needs admin review") : order.vendor;
  const driver = isUnassigned(order.driver) ? (driverRecord ? driverName(driverRecord) : "Needs admin onboarding") : order.driver;

  const notes = [
    vendorRecord ? `Vendor capacity: ${vendorName(vendorRecord)} · ${text(vendorRecord.data.availability) || "Available"} · ${text(vendorRecord.data.capacity) || "capacity not stated"}` : isUnassigned(order.vendor) ? "No available vendor capacity matched this order." : `Vendor preserved: ${order.vendor}`,
    driverRecord ? `Driver roster: ${driverName(driverRecord)} · ${text(driverRecord.data.area) || "area not stated"}` : isUnassigned(order.driver) ? "No active admin-onboarded driver matched this order." : `Driver preserved: ${order.driver}`,
  ];

  return { vendorName: vendor, driverName: driver, assignmentNote: notes.join(" ") };
}

export function assignOrderFromAvailability(order: AvailabilityAssignmentOrder): AssignmentPair {
  const vendorRow = isUnassigned(order.vendor) ? selectAvailabilityVendor(order.area, order.serviceType, order.orderId) : undefined;
  const driverRow = isUnassigned(order.driver) ? selectAvailabilityDriver(order.area) : undefined;
  const missing = [
    isUnassigned(order.vendor) && !vendorRow ? "vendor" : "",
    isUnassigned(order.driver) && !driverRow ? "driver" : "",
  ].filter(Boolean);
  if (missing.length) {
    const candidates = assignmentCandidates(order);
    const details = missing.map((kind) => {
      const rows = kind === "vendor" ? candidates.vendors : candidates.drivers;
      if (!rows.length) return `No ${kind}s are in the roster.`;
      const counts = new Map<string, number>();
      for (const row of rows) for (const reason of row.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
      return `${kind === "vendor" ? "Vendors" : "Drivers"}: ${[...counts].map(([reason, count]) => `${reason} (${count})`).join("; ")}.`;
    });
    throw new Error(`No eligible ${missing.join(" or ")} matches ${order.area || "this order's route"}. ${details.join(" ")} Check the roster before assigning.`);
  }
  const { vendor: reservedVendor, driver: reservedDriver, reservationId } = reserveAssignmentCapacity(order.orderId, vendorRow?.vendorId, driverRow?.driverId);
  const vendorNameValue = isUnassigned(order.vendor) ? (reservedVendor?.vendorName ?? "Needs admin review") : order.vendor;
  const driverNameValue = isUnassigned(order.driver) ? (reservedDriver?.driverName ?? "Needs admin onboarding") : order.driver;

  const notes = [
    reservedVendor ? `Vendor table: ${reservedVendor.vendorName} · ${reservedVendor.availabilityStatus} · ${reservedVendor.capacityRemaining} capacity left.` : isUnassigned(order.vendor) ? "No available vendor table match." : `Vendor preserved: ${order.vendor}.`,
    reservedDriver ? `Driver table: ${reservedDriver.driverName} · ${reservedDriver.availabilityStatus} · ${reservedDriver.capacityRemaining} route slots left.` : isUnassigned(order.driver) ? "No active admin-onboarded driver table match." : `Driver preserved: ${order.driver}.`,
  ];

  return {
    vendorName: vendorNameValue,
    driverName: driverNameValue,
    assignmentNote: notes.join(" "),
    vendorId: reservedVendor?.vendorId,
    driverId: reservedDriver?.driverId,
    vendorCapacityRemaining: reservedVendor?.capacityRemaining,
    driverCapacityRemaining: reservedDriver?.capacityRemaining,
    reservationId,
  };
}

/** Read-only recommendations. Existing explicit assignment remains the only capacity reservation. */
export function assignmentCandidates(order: AvailabilityAssignmentOrder) {
  const declined = new Set(listVendorDeclines(order.orderId).map((item) => item.vendorId));
  const vendors = listVendorAvailability().map((vendor) => {
    const reasons = [
      ...(!vendorStatusAssignable(vendor.availabilityStatus) ? ["Partner is not accepting orders"] : []),
      ...(vendor.capacityRemaining <= 0 ? ["No available capacity"] : []),
      ...(!serviceMatches(vendor, order.serviceType) ? ["Service capability does not match"] : []),
      ...(!listMatches(vendor.serviceZones, order.area) ? ["Approved coverage does not match"] : []),
      ...(declined.has(vendor.vendorId) ? ["Partner declined this order"] : []),
    ];
    return { vendorId: vendor.vendorId, name: vendor.vendorName, capacityRemaining: vendor.capacityRemaining, reasons, eligible: reasons.length === 0 };
  });
  const drivers = listDriverAvailability().map((driver) => {
    const reasons = [
      ...(/(inactive|suspended|offboarded|paused|training|tomorrow)/.test(driver.availabilityStatus.toLowerCase()) ? ["Driver is not active"] : []),
      ...(driver.capacityRemaining <= 0 ? ["No route slots available"] : []),
      ...(!listMatches(driver.serviceZones, order.area) ? ["Approved coverage does not match"] : []),
    ];
    return { driverId: driver.driverId, name: driver.driverName, capacityRemaining: driver.capacityRemaining, reasons, eligible: reasons.length === 0 };
  });
  return { vendors, drivers };
}
