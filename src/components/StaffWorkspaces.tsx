"use client";
import { StaffAccountPanel, StaffInvoicePanel, CustomerDecisionPanel } from "./StaffAdminControls";

import Link from "next/link";
import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Activity as ActivityIcon, ClipboardList, Gauge, HeartPulse, History, LayoutDashboard, Map as MapIcon, MessagesSquare, Route as RouteIcon, Users } from "lucide-react";
import type { StaffRole } from "@/lib/auth";
import { automationActionsForOrder, paymentReadyForCloseout } from "@/lib/order-workflow";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";
import { BrandLink } from "@/components/BrandLink";

const supportTypes = ["Pickup delay", "Payment issue", "Missing item", "Quality complaint", "Vendor escalation", "General question"];

type PortalShellProps = {
  title: string;
  role: StaffRole;
  pageRole?: StaffRole;
  userName: string;
  currentView: string;
  navigation: Array<{ href: string; label: string; view: string }>;
  children: ReactNode;
};

const workspaceIcons = {
  overview: LayoutDashboard,
  dispatch: MapIcon,
  orders: ClipboardList,
  people: Users,
  cases: MessagesSquare,
  operations: HeartPulse,
  activity: History,
  jobs: ClipboardList,
  capacity: Gauge,
  route: RouteIcon,
} as const;


type SubmissionRecord = {
  id: string;
  createdAt: string;
  data: Record<string, string>;
};

type OrderSummary = {
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

type SubmitHandler = (event: FormEvent<HTMLFormElement>, type: string) => Promise<void>;

type VendorAvailabilityRow = { vendorId: string; vendorName: string; serviceZones: string[]; serviceTypes: string[]; capacityRemaining: number; availabilityStatus: string; updatedAt: string; notes?: string };
type DriverAvailabilityRow = { driverId: string; driverName: string; serviceZones: string[]; vehicle?: string; capacityRemaining: number; availabilityStatus: string; updatedAt: string; notes?: string };
type VendorDeclineRow = { id: string; orderId: string; vendorName: string; reason: string; declinedBy: string; createdAt: string };
type StaffRosterMember = { id: string; name: string; email: string; phone: string; role: string; status: string; workArea: string; access: "configured" | "roster-only"; updatedAt: string };

type AutomationAction = ReturnType<typeof automationActionsForOrder>[number];

type QueueStats = { focusLabel: string; focusCount: number; automationCount: number; riskCount: number; capacityLabel: string };
type QueueView = "action" | "active" | "all";
type WorkspaceProps = {
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
      overview: { eyebrow: "Operations", title: "Today at Bubble Wash", subtitle: "A read-only view of orders, partners, routes, support, and payment follow-up." },
      dispatch: { eyebrow: "Dispatch", title: "Rider routes and ETAs", subtitle: "Monitor assigned route work, recent foreground locations, recorded windows, and drive estimates from one calm view." },
      orders: { eyebrow: "Orders", title: "Order operations", subtitle: "Review one queue, then open an order for its next verified action and full history." },
      people: { eyebrow: "People & onboarding", title: "Partners and staff", subtitle: "Manage vendor capacity, rider coverage, and the operating roster in one clear place." },
      cases: { eyebrow: "Support oversight", title: "Customer cases", subtitle: "Review open cases and follow-up without entering the support team workspace." },
      activity: { eyebrow: "Audit trail", title: "Operational activity", subtitle: "Inspect saved changes across the pilot and export the current view when needed." },
    },
    vendor: {
      jobs: { eyebrow: "Vendor workspace", title: "Laundry jobs", subtitle: "Open one assigned job at a time to accept, receive, wash, or mark it ready." },
      capacity: { eyebrow: "Vendor capacity", title: "Today’s availability", subtitle: "Keep capacity and service coverage accurate for assignment." },
      activity: { eyebrow: "Vendor history", title: "Saved updates", subtitle: "Review the production updates recorded by this workspace." },
    },
    driver: {
      route: { eyebrow: "Driver workspace", title: "Today’s assigned stops", subtitle: "Open the next stop for directions, optional live sharing, handoff evidence, delivery, or a delay report." },
      activity: { eyebrow: "Route history", title: "Saved route updates", subtitle: "Review handoffs and route evidence already recorded." },
    },
    support: {
      cases: { eyebrow: "Support desk", title: "Customer cases", subtitle: "Work one case at a time, keeping every decision attached to its case history." },
      orders: { eyebrow: "Order follow-up", title: "Orders needing support", subtitle: "Find an order, review customer impact, and record the next support action." },
      activity: { eyebrow: "Support history", title: "Saved support updates", subtitle: "Review case and customer follow-up activity." },
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

function orderMatchesRoleFocus(order: OrderSummary, role: StaffRole, userName: string) {
  const actions = automationActionsForOrder(order, role, userName);
  if (role === "admin") return isRiskOrder(order) || actions.length > 0;
  if (role === "vendor") return actions.some((action) => action.key.includes("vendor"));
  if (role === "driver") return actions.some((action) => action.key.includes("driver"));
  return isRiskOrder(order);
}

function queueStats(orders: OrderSummary[], role: StaffRole, userName: string, availabilityCount = 0): QueueStats {
  const automationCount = orders.reduce((count, order) => count + automationActionsForOrder(order, role, userName).length, 0);
  const focusCount = orders.filter((order) => orderMatchesRoleFocus(order, role, userName)).length;
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
type ActivityScope = "active" | "archived" | "all";
type ActivityWindow = "20" | "50" | "today";
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

function activitySubject(record: SubmissionRecord) {
  return activityValue(record, "company", "staffName", "driverName", "name", "orderId", "ticketId") || "Bubble Wash request";
}

function activityEntityKey(record: SubmissionRecord) {
  return activityValue(record, "orderId", "ticketId", "email", "phone") || `${activityType(record)}:${activitySubject(record)}`;
}

function activityCategory(record: SubmissionRecord): ActivityCategory {
  const type = activityType(record).toLowerCase();
  if (type.includes("payment") || type.includes("checkout")) return "payments";
  if (type.includes("support")) return "support";
  if (type.includes("onboarding")) return "onboarding";
  if (type.includes("pickup") || type.includes("vendor") || type.includes("driver") || type.includes("qr-bag")) return "orders";
  return "ops";
}

function activityScopeMatches(record: SubmissionRecord, scope: ActivityScope) {
  if (scope === "all") return true;
  const ageMs = Date.now() - new Date(record.createdAt).getTime();
  const isActive = ageMs <= 24 * 60 * 60 * 1000;
  return scope === "active" ? isActive : !isActive;
}

function activityWindowMatches(record: SubmissionRecord, window: ActivityWindow) {
  if (window === "today") {
    const created = new Date(record.createdAt);
    const now = new Date();
    return created.getFullYear() === now.getFullYear() && created.getMonth() === now.getMonth() && created.getDate() === now.getDate();
  }
  return true;
}

function activityChangeSummary(record: SubmissionRecord, previous?: SubmissionRecord) {
  const type = activityType(record);
  const currentStatus = activityValue(record, "ticketStatus", "orderStatus", "jobStatus", "availability", "issueType");
  const previousStatus = previous ? activityValue(previous, "ticketStatus", "orderStatus", "jobStatus", "availability", "issueType") : "";
  const currentVendor = activityValue(record, "vendorName", "vendor");
  const previousVendor = previous ? activityValue(previous, "vendorName", "vendor") : "";
  const currentDriver = activityValue(record, "driverName", "driver");
  const previousDriver = previous ? activityValue(previous, "driverName", "driver") : "";
  const currentCapacity = activityValue(record, "capacityRemaining", "capacity", "routeSlots");
  const previousCapacity = previous ? activityValue(previous, "capacityRemaining", "capacity", "routeSlots") : "";
  const currentPayment = activityValue(record, "paymentStatus", "paymentMethod", "paymentPreference");
  const previousPayment = previous ? activityValue(previous, "paymentStatus", "paymentMethod", "paymentPreference") : "";
  const note = activityValue(record, "message", "reason", "actionType", "itemCondition");

  if (previous) {
    if (currentVendor && currentVendor !== previousVendor) return `Vendor changed: ${previousVendor || "Unassigned"} → ${currentVendor}`;
    if (currentDriver && currentDriver !== previousDriver) return `Driver changed: ${previousDriver || "Unassigned"} → ${currentDriver}`;
    if (currentStatus && currentStatus !== previousStatus) return `Status changed: ${previousStatus || "Pending"} → ${currentStatus}`;
    if (currentCapacity && currentCapacity !== previousCapacity) return `Capacity changed: ${previousCapacity || "0"} → ${currentCapacity}`;
    if (currentPayment && currentPayment !== previousPayment) return `Payment updated: ${previousPayment || "Pending"} → ${currentPayment}`;
    if (note) return note;
  }

  if (type.includes("pickup") || type.includes("checkout")) return "New customer order request logged";
  if (type.includes("support")) return "New support case saved for follow-up";
  if (type.includes("vendor-application")) return "Vendor capacity update saved";
  if (type.includes("driver-route")) return "Driver route checkpoint saved";
  if (type.includes("admin")) return "Manual admin action logged";
  if (type.includes("payment")) return "Payment activity captured";
  return note || "New activity saved";
}

function activityTypeLabel(type: string) {
  return type.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function activityCsv(records: SubmissionRecord[], summaries: Map<string, string>) {
  const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const header = ["Reference", "Type", "Subject", "What changed", "Saved"];
  const rows = records.map((record) => [
    record.id,
    activityTypeLabel(activityType(record)),
    activitySubject(record),
    summaries.get(record.id) || "",
    formatActivityTime(record.createdAt),
  ]);
  return [header, ...rows].map((row) => row.map((cell) => escape(cell)).join(",")).join("\n");
}

function activitySectionedEntries(record: SubmissionRecord) {
  const groups: Array<{ title: string; entries: Array<[string, string]> }> = [
    {
      title: "Identifiers",
      entries: [
        ["Reference", record.id],
        ["Order", activityValue(record, "orderId")],
        ["Ticket", activityValue(record, "ticketId")],
        ["Type", activityTypeLabel(activityType(record))],
      ],
    },
    {
      title: "People and business",
      entries: [
        ["Subject", activitySubject(record)],
        ["Company", activityValue(record, "company")],
        ["Customer", activityValue(record, "name")],
        ["Staff member", activityValue(record, "staffName")],
        ["Vendor", activityValue(record, "vendorName", "vendor")],
        ["Driver", activityValue(record, "driverName", "driver")],
        ["Saved by", activityValue(record, "submittedByName")],
      ],
    },
    {
      title: "Workflow",
      entries: [
        ["Status", activityValue(record, "ticketStatus", "orderStatus", "jobStatus", "availability", "issueType")],
        ["Payment", activityValue(record, "paymentStatus", "paymentMethod", "paymentPreference")],
        ["Capacity", activityValue(record, "capacityRemaining", "capacity", "routeSlots")],
        ["Saved", formatActivityTime(record.createdAt)],
      ],
    },
    {
      title: "Notes",
      entries: [
        ["Message", activityValue(record, "message")],
        ["Reason", activityValue(record, "reason")],
        ["Action", activityValue(record, "actionType")],
        ["Condition", activityValue(record, "itemCondition")],
        ["Phone", activityValue(record, "phone")],
        ["Email", activityValue(record, "email")],
      ],
    },
  ];

  return groups
    .map((group) => ({ title: group.title, entries: group.entries.filter(([, value]) => value.trim()) }))
    .filter((group) => group.entries.length);
}

function StageCountdown({ order }: { order: OrderSummary }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (!order.stageTimer.targetMinutes) {
    return <div className="stageClock timer-paused" aria-label="Phase timer complete"><span>Phase timer</span><b>Complete</b><small>{workflowPhaseLabel(order.workflowStage.key)} · {order.priority}</small></div>;
  }

  const startedAt = new Date(order.updatedAt).getTime();
  const targetMs = order.stageTimer.targetMinutes * 60_000;
  const remainingSeconds = Math.ceil((startedAt + targetMs - now) / 1000);
  const overdue = remainingSeconds < 0;
  const dueSoon = !overdue && remainingSeconds <= 20 * 60;
  const tone = overdue ? "breached" : dueSoon ? "due" : "ok";
  const label = overdue ? "Overdue" : "SLA";
  const duration = formatDuration(Math.abs(remainingSeconds));

  return (
    <div className={`stageClock countdown timer-${tone}`} aria-label={`${label} ${duration}`}>
      <span>{label === "SLA" ? "Phase timer" : label}</span>
      <b>{duration}</b>
      <small>{workflowPhaseLabel(order.workflowStage.key)} · {order.priority}</small>
    </div>
  );
}

function AvailabilityBoard({ role, mode = "all", refreshToken = 0 }: { role: StaffRole; mode?: "all" | "vendors" | "drivers"; refreshToken?: number }) {
  const [vendors, setVendors] = useState<VendorAvailabilityRow[]>([]);
  const [drivers, setDrivers] = useState<DriverAvailabilityRow[]>([]);
  const [declines, setDeclines] = useState<VendorDeclineRow[]>([]);
  const [status, setStatus] = useState("Loading availability table…");
  const [hasLoaded, setHasLoaded] = useState(false);

  async function loadAvailability(showLoading = true) {
    if (showLoading) setStatus("Loading availability table…");
    try {
      const response = await fetch("/api/availability");
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setStatus(data.error ?? "Unable to load availability table.");
        setHasLoaded(true);
        return;
      }
      setVendors(data.vendors ?? []);
      setDrivers(data.drivers ?? []);
      setDeclines(data.declines ?? []);
      setStatus("Availability table loaded.");
      setHasLoaded(true);
    } catch {
      setStatus("Unable to load availability table.");
      setHasLoaded(true);
    }
  }

  useEffect(() => {
    let active = true;
    fetch("/api/availability")
      .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
      .then(({ ok, data }) => {
        if (!active) return;
        if (!ok || !data.ok) {
          setStatus(data.error ?? "Unable to load availability table.");
          setHasLoaded(true);
          return;
        }
        setVendors(data.vendors ?? []);
        setDrivers(data.drivers ?? []);
        setDeclines(data.declines ?? []);
        setStatus("Availability table loaded.");
        setHasLoaded(true);
      })
      .catch(() => {
        if (active) {
          setStatus("Unable to load availability table.");
          setHasLoaded(true);
        }
      });
    return () => { active = false; };
  }, [refreshToken]);

  const showVendors = mode !== "drivers" && role !== "driver";
  const showDrivers = mode !== "vendors" && (role === "admin" || role === "driver");

  return (
    <section className="staffContentSection availabilitySection" aria-busy={!hasLoaded}>
      <div className="staffSectionHeader">
        <div><h2>Availability and coverage</h2><p>Current working capacity used by assignment.</p></div>
        <button className="button secondary" type="button" onClick={() => loadAvailability()}>Refresh</button>
      </div>

      {showVendors ? <div className="staffRosterGroup">
        <div className="staffSubsectionHeader"><h3>Vendor partners</h3><span>{hasLoaded ? `${vendors.length} on roster` : "Loading…"}</span></div>
        <div className="staffRosterList">
          {!hasLoaded ? <LoadingSkeleton label="Loading vendor capacity" rows={3} /> : vendors.length ? vendors.map((vendor) => <article className="staffRosterRow" key={vendor.vendorId}>
            <div><strong>{vendor.vendorName}</strong><span>{vendor.serviceTypes.join(", ") || "Services not set"}</span>{role === "admin" ? <small>ID: {vendor.vendorId}</small> : null}</div>
            <div><span className="staffFieldLabel">Status</span><strong>{vendor.availabilityStatus}</strong></div>
            <div><span className="staffFieldLabel">Capacity</span><strong>{vendor.capacityRemaining} order slots</strong></div>
            <div><span className="staffFieldLabel">Coverage</span><strong>{vendor.serviceZones.join(", ") || "Any approved zone"}</strong></div>
            <p>{vendor.notes || "No capacity note."}</p>
          </article>) : <p className="staffEmptyState">No vendor capacity rows yet.</p>}
        </div>
      </div> : null}

      {showDrivers ? <div className="staffRosterGroup">
        <div className="staffSubsectionHeader"><h3>Riders</h3><span>{hasLoaded ? `${drivers.length} on roster` : "Loading…"}</span></div>
        <div className="staffRosterList">
          {!hasLoaded ? <LoadingSkeleton label="Loading rider availability" rows={3} /> : drivers.length ? drivers.map((driver) => <article className="staffRosterRow" key={driver.driverId}>
            <div><strong>{driver.driverName}</strong><span>{driver.vehicle || "Vehicle not set"}</span>{role === "admin" ? <small>ID: {driver.driverId}</small> : null}</div>
            <div><span className="staffFieldLabel">Status</span><strong>{driver.availabilityStatus}</strong></div>
            <div><span className="staffFieldLabel">Capacity</span><strong>{driver.capacityRemaining} route slots</strong></div>
            <div><span className="staffFieldLabel">Coverage</span><strong>{driver.serviceZones.join(", ") || "Any approved zone"}</strong></div>
            <p>{driver.notes || "No route note."}</p>
          </article>) : <p className="staffEmptyState">No rider availability rows yet.</p>}
        </div>
      </div> : null}

      {role === "admin" && declines.length > 0 ? <div className="staffRosterGroup">
        <div className="staffSubsectionHeader"><h3>Recent vendor declines</h3><span>{declines.length} recorded</span></div>
        <div className="staffSimpleList">{declines.slice(0, 6).map((decline) => <div className="staffSimpleRow" key={decline.id}><strong>{decline.orderId}</strong><span>{decline.vendorName}</span><p>{decline.reason}</p><time>{formatActivityTime(decline.createdAt)}</time></div>)}</div>
      </div> : null}
      <p className={noticeClass(status)} role="status" aria-live="polite">{status}</p>
    </section>
  );
}

function RecentActivity({ filter, initialSelectedId = "", basePath }: { filter?: string; initialSelectedId?: string; basePath: string }) {
  const [records, setRecords] = useState<SubmissionRecord[]>([]);
  const [status, setStatus] = useState("Loading recent activity…");
  const [hasLoaded, setHasLoaded] = useState(false);
  const [category, setCategory] = useState<ActivityCategory>("all");
  const [scope, setScope] = useState<ActivityScope>("active");
  const [windowMode, setWindowMode] = useState<ActivityWindow>("20");
  const [sortKey, setSortKey] = useState<ActivitySortKey>("saved");
  const [sortDirection, setSortDirection] = useState<ActivitySortDirection>("desc");
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const [freshIds, setFreshIds] = useState<string[]>([]);
  const [lastUpdatedAt, setLastUpdatedAt] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const recordsRef = useRef<SubmissionRecord[]>([]);

  async function loadRecords(showLoading = true) {
    if (showLoading) setStatus("Loading recent activity…");
    try {
      const response = await fetch("/api/submissions");
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setStatus(data.error ?? "Unable to load activity.");
        setHasLoaded(true);
        return;
      }
      const scoped = filter ? data.records.filter((record: SubmissionRecord) => String(record.data.submissionType ?? "").includes(filter)) : data.records;
      const nextRecords = scoped.slice(0, 80);
      const previousIds = new Set(recordsRef.current.map((record) => record.id));
      const newIds = nextRecords.filter((record: SubmissionRecord) => !previousIds.has(record.id)).map((record: SubmissionRecord) => record.id);
      recordsRef.current = nextRecords;
      setRecords(nextRecords);
      setFreshIds(newIds);
      setLastUpdatedAt(new Date().toISOString());
      setHasLoaded(true);
      if (newIds.length && !showLoading) {
        setStatus(`${newIds.length} new update${newIds.length === 1 ? "" : "s"} just landed.`);
        return;
      }
      setStatus(nextRecords.length ? "Recent activity loaded." : "No matching activity yet.");
    } catch {
      setStatus("Unable to load activity.");
      setHasLoaded(true);
    }
  }

  useEffect(() => {
    let active = true;

    async function refresh(showLoading = true) {
      if (!active || (!showLoading && document.hidden)) return;
      if (showLoading) setStatus("Loading recent activity…");
      try {
        const response = await fetch("/api/submissions");
        const data = await response.json();
        if (!active) return;
        if (!response.ok || !data.ok) {
          setStatus(data.error ?? "Unable to load activity.");
          setHasLoaded(true);
          return;
        }
        const scoped = filter ? data.records.filter((record: SubmissionRecord) => String(record.data.submissionType ?? "").includes(filter)) : data.records;
        const nextRecords = scoped.slice(0, 80);
        const previousIds = new Set(recordsRef.current.map((record) => record.id));
        const newIds = nextRecords.filter((record: SubmissionRecord) => !previousIds.has(record.id)).map((record: SubmissionRecord) => record.id);
        recordsRef.current = nextRecords;
        setRecords(nextRecords);
        setFreshIds(newIds);
        setLastUpdatedAt(new Date().toISOString());
        setHasLoaded(true);
        if (newIds.length && !showLoading) {
          setStatus(`${newIds.length} new update${newIds.length === 1 ? "" : "s"} just landed.`);
          return;
        }
        setStatus(nextRecords.length ? "Recent activity loaded." : "No matching activity yet.");
      } catch {
        if (active) {
          setStatus("Unable to load activity.");
          setHasLoaded(true);
        }
      }
    }

    recordsRef.current = [];
    refresh(true);
    const interval = window.setInterval(() => {
      void refresh(false);
    }, 30_000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [filter]);

  useEffect(() => {
    if (!freshIds.length) return;
    const timer = window.setTimeout(() => setFreshIds([]), 45_000);
    return () => window.clearTimeout(timer);
  }, [freshIds]);

  const previousMap = useMemo(() => {
    const byEntity = new Map<string, SubmissionRecord[]>();
    for (const record of [...records].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())) {
      const key = activityEntityKey(record);
      byEntity.set(key, [...(byEntity.get(key) ?? []), record]);
    }
    const map = new Map<string, SubmissionRecord | undefined>();
    for (const group of byEntity.values()) {
      group.forEach((record, index) => {
        map.set(record.id, index > 0 ? group[index - 1] : undefined);
      });
    }
    return map;
  }, [records]);

  const changeSummaries = useMemo(() => new Map(records.map((record) => [record.id, activityChangeSummary(record, previousMap.get(record.id))])), [records, previousMap]);

  const categoryCounts = useMemo(() => ({
    all: records.length,
    orders: records.filter((record) => activityCategory(record) === "orders").length,
    support: records.filter((record) => activityCategory(record) === "support").length,
    onboarding: records.filter((record) => activityCategory(record) === "onboarding").length,
    payments: records.filter((record) => activityCategory(record) === "payments").length,
    ops: records.filter((record) => activityCategory(record) === "ops").length,
  }), [records]);

  const visibleRecords = useMemo(() => {
    const filtered = records
      .filter((record) => category === "all" || activityCategory(record) === category)
      .filter((record) => activityScopeMatches(record, scope))
      .filter((record) => activityWindowMatches(record, windowMode));

    const sorted = [...filtered].sort((left, right) => {
      const direction = sortDirection === "asc" ? 1 : -1;
      if (sortKey === "saved") return (new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()) * direction;
      if (sortKey === "type") return activityTypeLabel(activityType(left)).localeCompare(activityTypeLabel(activityType(right))) * direction;
      return activitySubject(left).localeCompare(activitySubject(right)) * direction;
    });

    if (windowMode === "20") return sorted.slice(0, 20);
    if (windowMode === "50") return sorted.slice(0, 50);
    return sorted;
  }, [records, category, scope, windowMode, sortKey, sortDirection]);

  const selectedRecord = records.find((record) => record.id === selectedId) ?? null;
  const selectedSections = useMemo(() => selectedRecord ? activitySectionedEntries(selectedRecord) : [], [selectedRecord]);

  function toggleSort(nextKey: ActivitySortKey) {
    if (sortKey === nextKey) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSortKey(nextKey);
    setSortDirection(nextKey === "saved" ? "desc" : "asc");
  }

  function exportVisibleCsv() {
    const csv = activityCsv(visibleRecords, changeSummaries);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `bubblewash-activity-${windowMode}-${scope}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function copyValue(label: string, value: string) {
    if (!value.trim()) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(`${label} copied.`);
      window.setTimeout(() => setCopyStatus(""), 2400);
    } catch {
      setCopyStatus(`Could not copy ${label.toLowerCase()}.`);
    }
  }

  function filterToSubject(record: SubmissionRecord) {
    setCategory(activityCategory(record));
    setScope("all");
  }

  return (
    <section className="staffContentSection activitySection" aria-busy={!hasLoaded}>
      {selectedRecord ? <div className="staffDetailView" aria-live="polite">
        <Link className="staffBackLink" href={basePath}>← Back to activity</Link>
        <div className="staffDetailHeader">
          <div><span className="staffFieldLabel">{activityTypeLabel(activityType(selectedRecord))}</span><h2>{activitySubject(selectedRecord)}</h2><p>{changeSummaries.get(selectedRecord.id)}</p></div>
          <div className="staffDetailReference"><span>Reference</span><strong>{selectedRecord.id}</strong><time>{formatActivityTime(selectedRecord.createdAt)}</time></div>
        </div>
        <div className="activityDetailActions">
          <button className="button secondary" onClick={() => void copyValue("Reference", selectedRecord.id)} type="button">Copy reference</button>
          {activityValue(selectedRecord, "orderId") ? <button className="button secondary" onClick={() => void copyValue("Order ID", activityValue(selectedRecord, "orderId"))} type="button">Copy order ID</button> : null}
          {activityValue(selectedRecord, "phone") ? <button className="button secondary" onClick={() => void copyValue("Phone", activityValue(selectedRecord, "phone"))} type="button">Copy phone</button> : null}
          {activityValue(selectedRecord, "email") ? <button className="button secondary" onClick={() => void copyValue("Email", activityValue(selectedRecord, "email"))} type="button">Copy email</button> : null}
          <button className="button secondary" onClick={() => { filterToSubject(selectedRecord); setSelectedId(""); window.history.replaceState(null, "", basePath); }} type="button">Show similar</button>
        </div>
        {copyStatus ? <p className="activityCopyStatus" role="status">{copyStatus}</p> : null}
        <div className="staffDetailSections">
          {selectedSections.map((section) => <details className="staffDetailDisclosure" key={section.title}><summary><span><strong>{section.title}</strong><small>{section.entries.length} saved fields</small></span></summary><div className="staffDisclosureBody"><dl className="staffDefinitionList">{section.entries.map(([key, value]) => <div key={`${section.title}-${key}`}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></div></details>)}
        </div>
      </div> : selectedId && hasLoaded ? <div className="staffEmptyState"><h2>Activity not found</h2><p>This update is unavailable to this staff role or outside the retained activity window.</p><Link href={basePath}>Back to activity</Link></div> : <>
        <div className="staffSectionHeader">
          <div><h2>Latest saved updates</h2><p>{!hasLoaded ? "Loading saved updates…" : visibleRecords.length ? `${visibleRecords.length} updates in this view` : "No saved updates yet"}</p></div>
          <div className="staffHeaderActions"><button className="button secondary" type="button" onClick={exportVisibleCsv}>Export CSV</button><button className="button secondary" type="button" onClick={() => void loadRecords()}>Refresh</button></div>
        </div>
        <div className="staffFilterBar">
          <div className="staffTextFilters" aria-label="Activity type">
            {([ ["all", "All"], ["orders", "Orders"], ["support", "Support"], ["onboarding", "Onboarding"], ["payments", "Payments"], ["ops", "Operations"] ] as Array<[ActivityCategory, string]>).map(([key, label]) => <button aria-pressed={category === key} className={category === key ? "active" : ""} key={key} onClick={() => setCategory(key)} type="button">{label} <span>{categoryCounts[key]}</span></button>)}
          </div>
          <div className="staffSelectFilters"><label>Scope<select value={scope} onChange={(event) => setScope(event.target.value as ActivityScope)}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option></select></label><label>Time window<select value={windowMode} onChange={(event) => setWindowMode(event.target.value as ActivityWindow)}><option value="20">Last 20</option><option value="50">Last 50</option><option value="today">Today</option></select></label></div>
        </div>
        <div className="staffActivityList" role="list">
          {visibleRecords.length ? visibleRecords.map((record) => <article key={record.id} role="listitem"><Link className={`staffActivityRow ${freshIds.includes(record.id) ? "is-new" : ""}`} href={`${basePath}${basePath.includes("?") ? "&" : "?"}activity=${encodeURIComponent(record.id)}`}>
            <span><strong>{activitySubject(record)}</strong><small>{record.id}</small></span>
            <span><strong>{activityTypeLabel(activityType(record))}</strong><small>{changeSummaries.get(record.id)}</small></span>
            <time>{formatActivityTime(record.createdAt)}</time>
            <b>View details</b>
          </Link></article>) : hasLoaded ? <p className="staffEmptyState">No activity matches these filters.</p> : <LoadingSkeleton label="Loading recent activity" rows={5} />}
        </div>
        <p className="staffSyncLine">Auto-refreshes every 30 seconds{lastUpdatedAt ? ` · Last synced ${formatMetricTime(lastUpdatedAt)}` : ""}. <button type="button" onClick={() => toggleSort("saved")}>Toggle date order</button></p>
      </>}
      <p className={noticeClass(status)} role="status" aria-live="polite">{status}</p>
    </section>
  );
}

function AutomatedOrderActions({ order, role, userName, onSaved }: { order: OrderSummary; role: StaffRole; userName: string; onSaved: () => Promise<void> }) {
  const [status, setStatus] = useState("");
  const [pendingLabel, setPendingLabel] = useState("");
  const [failed, setFailed] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [structuredAction, setStructuredAction] = useState("");
  const actions = automationActionsForOrder(order, role, userName);

  async function run(action: AutomationAction, overrides: Record<string, string> = {}) {
    if (action.key === "admin-close-order") {
      const confirmed = window.confirm(`${action.label} for ${order.orderId}? This will be written to the permanent order timeline.`);
      if (!confirmed) return;
    }
    setPendingLabel(action.label);
    setStatus(`${action.label}…`);
    setFailed(false);
    const payload: Record<string, string> = { orderId: order.orderId, actionKey: action.key, ...overrides };
    try {
      const data = await postJSON<{ ok: boolean; message: string; id: string; nextStatus: string }>("/api/orders/advance", payload);
      setStatus(`Saved ${data.id} → ${data.nextStatus}`);
      setDeclineOpen(false);
      setDeclineReason("");
      setStructuredAction("");
      await onSaved();
    } catch (error) {
      setFailed(true);
      setStatus(error instanceof Error ? error.message : "Unable to complete workflow action.");
    } finally {
      setPendingLabel("");
    }
  }

  function submitStructured(event: FormEvent<HTMLFormElement>, actionKey: string) {
    event.preventDefault();
    const action = actions.find((item) => item.key === actionKey);
    if (!action) return;
    const overrides = Object.fromEntries(Array.from(new FormData(event.currentTarget).entries()).map(([key, value]) => [key, String(value)]));
    void run(action, overrides);
  }

  return (
    <div className="automationPanel">
      <div className="automationSummary">
        <b>{actions.length ? "Available actions" : "No action"}</b>
        <span>{actions.length ? `${actions.length} available` : "Waiting"}</span>
      </div>
      <div className="automationActions">
        {actions.length ? actions.map((action, index) => <button className={`button ${index === 0 ? "primary" : "secondary"}`} disabled={Boolean(pendingLabel)} key={action.label} onClick={() => action.key === "vendor-decline-job" ? setDeclineOpen(true) : ["admin-schedule-pickup", "support-log-customer-contact", "admin-confirm-bank-transfer", "admin-approve-invoice", "vendor-log-intake", "vendor-mark-ready", "driver-mark-picked-up", "driver-drop-at-vendor", "driver-mark-delivered", "driver-update-eta", "driver-report-delay"].includes(action.key) ? setStructuredAction(action.key) : void run(action)} type="button">{pendingLabel === action.label ? "Working…" : action.label}</button>) : <span className="status">Waiting</span>}
      </div>
      {declineOpen ? <form className="declineReasonForm" onSubmit={(event) => { event.preventDefault(); const decline = actions.find((action) => action.key === "vendor-decline-job"); if (decline && declineReason.trim()) void run(decline, { reason: declineReason.trim() }); }}><label>Reason for admin reassignment<textarea value={declineReason} onChange={(event) => setDeclineReason(event.target.value)} maxLength={300} placeholder="Capacity, machine issue, service mismatch, or timing conflict" required /></label><div className="tableActionRow"><button className="button primary" type="submit" disabled={!declineReason.trim() || Boolean(pendingLabel)}>Confirm decline</button><button className="button secondary" type="button" onClick={() => { setDeclineOpen(false); setDeclineReason(""); }}>Cancel</button></div></form> : null}
      {structuredAction === "admin-schedule-pickup" ? <form className="structuredActionForm" onSubmit={(event) => submitStructured(event, structuredAction)}><label>Confirmed pickup date<input type="date" name="confirmedPickupDate" required /></label><label>Confirmed pickup window<select name="confirmedPickupWindow" required>{["8:00–10:00", "10:00–12:00", "12:00–14:00", "14:00–16:00", "16:00–18:00"].map((window) => <option key={window}>{window}</option>)}</select></label><label>Scheduling note<textarea name="operatorNote" placeholder="Who confirmed the window and any access or collection instructions" maxLength={600} required /></label><div className="tableActionRow"><button className="button primary" type="submit" disabled={Boolean(pendingLabel)}>Save pickup window</button><button className="button secondary" type="button" onClick={() => setStructuredAction("")}>Cancel</button></div></form> : null}
      {structuredAction === "support-log-customer-contact" ? <form className="structuredActionForm" onSubmit={(event) => submitStructured(event, structuredAction)}><div className="two"><label>Contact channel<select name="contactChannel" required><option>Phone call</option><option>Email</option></select></label><label>Outcome<select name="contactOutcome" required><option>Reached customer</option><option>No answer</option><option>Message left</option><option>Email sent</option><option>Follow-up required</option></select></label></div><label>Next follow-up<input name="nextFollowUpAt" type="datetime-local" required /></label><label>Operator note<textarea name="operatorNote" placeholder="What was discussed, promised, or left unresolved" maxLength={600} required /></label><div className="tableActionRow"><button className="button primary" type="submit" disabled={Boolean(pendingLabel)}>Save contact log</button><button className="button secondary" type="button" onClick={() => setStructuredAction("")}>Cancel</button></div></form> : null}
      {["admin-confirm-bank-transfer", "admin-approve-invoice"].includes(structuredAction) ? <form className="structuredActionForm" onSubmit={(event) => submitStructured(event, structuredAction)}><div className="two"><label>{structuredAction === "admin-approve-invoice" ? "Invoice number" : "Transfer reference"}<input name="paymentReference" maxLength={120} required /></label><label>Amount (GHS)<input name="paymentAmount" type="number" min="0.01" max="250000" step="0.01" inputMode="decimal" required /></label></div><label>{structuredAction === "admin-approve-invoice" ? "Approval date" : "Received date"}<input name="paymentReceivedAt" type="date" required /></label><label>Reconciliation note<textarea name="operatorNote" placeholder="Account checked, approver, payer name, or exception reviewed" maxLength={600} required /></label><div className="tableActionRow"><button className="button primary" type="submit" disabled={Boolean(pendingLabel)}>{structuredAction === "admin-approve-invoice" ? "Save invoice approval" : "Confirm bank transfer"}</button><button className="button secondary" type="button" onClick={() => setStructuredAction("")}>Cancel</button></div></form> : null}
      {structuredAction === "vendor-log-intake" ? <form className="structuredActionForm" onSubmit={(event) => submitStructured(event, structuredAction)}><div className="two"><label>Bag tag<input name="bagTag" defaultValue={`${order.orderId}-BAG`} maxLength={120} required /></label><label>Bag/item count<input name="intakeBagCount" type="number" min="1" max="10000" step="1" required /></label></div><div className="two"><label>Verified received weight (kg)<input name="receivedWeightKg" required type="number" min="0.01" max="10000" step="0.01" inputMode="decimal" /></label><label>Intake condition<select name="intakeCondition" required><option>Count and condition matched</option><option>Stain or special care flagged</option><option>Count mismatch</option><option>Damage risk flagged</option></select></label></div><label>Intake note<textarea name="operatorNote" placeholder="Count check, visible condition, special care, or discrepancy" maxLength={600} required /></label><div className="tableActionRow"><button className="button primary" type="submit" disabled={Boolean(pendingLabel)}>Confirm intake</button><button className="button secondary" type="button" onClick={() => setStructuredAction("")}>Cancel</button></div></form> : null}
      {structuredAction === "vendor-mark-ready" ? <form className="structuredActionForm" onSubmit={(event) => submitStructured(event, structuredAction)}><div className="two"><label>Ready bag/item count<input name="readyBagCount" type="number" min="1" max="10000" step="1" required /></label><label>Quality check<select name="qualityCheck" required><option>Count, finish, and packaging checked</option><option>Ready with noted exception</option></select></label></div><label>Dispatch note<textarea name="operatorNote" placeholder="Packaging, storage point, collection instructions, or exception" maxLength={600} required /></label><div className="tableActionRow"><button className="button primary" type="submit" disabled={Boolean(pendingLabel)}>Mark ready</button><button className="button secondary" type="button" onClick={() => setStructuredAction("")}>Cancel</button></div></form> : null}
      {structuredAction === "driver-mark-picked-up" ? <form className="structuredActionForm" onSubmit={(event) => submitStructured(event, structuredAction)}><label>Collected bag/item count<input name="pickupBagCount" type="number" min="1" max="10000" step="1" required /></label><label>Customer handoff note<textarea name="operatorNote" placeholder="Who released the order, collection point, and any count or access exception" maxLength={600} required /></label><div className="tableActionRow"><button className="button primary" type="submit" disabled={Boolean(pendingLabel)}>Confirm pickup</button><button className="button secondary" type="button" onClick={() => setStructuredAction("")}>Cancel</button></div></form> : null}
      {structuredAction === "driver-drop-at-vendor" ? <form className="structuredActionForm" onSubmit={(event) => submitStructured(event, structuredAction)}><div className="two"><label>Vendor recipient<input name="vendorRecipient" maxLength={160} required /></label><label>Handed-over bag/item count<input name="handoffBagCount" type="number" min="1" max="10000" step="1" required /></label></div><label>Vendor handoff note<textarea name="operatorNote" placeholder="Handoff point, time, recipient confirmation, or discrepancy" maxLength={600} required /></label><div className="tableActionRow"><button className="button primary" type="submit" disabled={Boolean(pendingLabel)}>Confirm vendor handoff</button><button className="button secondary" type="button" onClick={() => setStructuredAction("")}>Cancel</button></div></form> : null}
      {structuredAction === "driver-mark-delivered" ? <form className="structuredActionForm" onSubmit={(event) => submitStructured(event, structuredAction)}><div className="two"><label>Recipient name<input name="recipientName" maxLength={160} required /></label><label>Returned bag/item count<input name="bagCount" type="number" min="1" max="10000" step="1" required /></label></div><label>Customer handoff code<input name="deliveryCode" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required /></label><label>Handoff note<textarea name="operatorNote" placeholder="Where and to whom the order was handed over; note any exception" maxLength={600} required /></label><div className="tableActionRow"><button className="button primary" type="submit" disabled={Boolean(pendingLabel)}>Confirm delivery</button><button className="button secondary" type="button" onClick={() => setStructuredAction("")}>Cancel</button></div></form> : null}
      {structuredAction === "driver-update-eta" ? <form className="structuredActionForm" onSubmit={(event) => submitStructured(event, structuredAction)}><div className="two"><label>Estimated arrival time<input name="driverEtaAt" type="time" required /></label><label>Current checkpoint<input name="routeCheckpoint" placeholder="Street, junction, or visible landmark" maxLength={240} required /></label></div><label>Route note (optional)<textarea name="operatorNote" placeholder="Traffic or access detail that dispatch should know" maxLength={240} /></label><p className="formHint">This saves a manual ETA and checkpoint. Use the separate live location control while travelling.</p><div className="tableActionRow"><button className="button primary" type="submit" disabled={Boolean(pendingLabel)}>Update ETA &amp; checkpoint</button><button className="button secondary" type="button" onClick={() => setStructuredAction("")}>Cancel</button></div></form> : null}
      {structuredAction === "driver-report-delay" ? <form className="structuredActionForm" onSubmit={(event) => submitStructured(event, structuredAction)}><div className="two"><label>Revised ETA<input name="revisedEta" placeholder="25 minutes or 15:20" maxLength={80} required /></label><label>Current checkpoint<input name="routeCheckpoint" placeholder="Street, junction, or vendor" maxLength={240} required /></label></div><label>Delay reason<textarea name="operatorNote" placeholder="Traffic, customer unavailable, vehicle issue, or handoff delay" maxLength={600} required /></label><div className="tableActionRow"><button className="button primary" type="submit" disabled={Boolean(pendingLabel)}>Save delay report</button><button className="button secondary" type="button" onClick={() => setStructuredAction("")}>Cancel</button></div></form> : null}
      {status && <p className={`status ${failed ? "error" : "success"}`} role="status" aria-live="polite">{status}</p>}
    </div>
  );
}

function CustomerContactActions({ order, role }: { order: OrderSummary; role: StaffRole }) {
  if (role === "vendor") return null;
  const phone = order.phone.replace(/[^\d+]/g, "");
  const canEmail = (role === "admin" || role === "support") && order.email;
  if (!phone && !canEmail) return null;
  return <div className="customerContactActions" aria-label={`Contact ${order.customer}`}>{phone ? <a href={`tel:${phone}`}>Call customer</a> : null}{canEmail ? <a href={`mailto:${order.email}?subject=${encodeURIComponent(`Bubble Wash order ${order.orderId}`)}`}>Email customer</a> : null}</div>;
}

function OrderQueueRow({ order, href }: { order: OrderSummary; href: string }) {
  return <article className={`staffOrderRow timer-${order.stageTimer.tone}`} role="listitem">
    <div><strong>{order.orderId}</strong><span>{order.customer}</span></div>
    <div><strong>{order.workflowStage.label}</strong><span>{order.stageTimer.label}</span></div>
    <div><strong>{order.area}</strong><span>{order.routeWindow}</span></div>
    <div><strong>{order.vendor !== "Unassigned" ? order.vendor : "Vendor pending"}</strong><span>{order.driver !== "Unassigned" ? order.driver : "Rider pending"}</span></div>
    <Link href={href}>View order</Link>
  </article>;
}

function driverStopGroup(order: OrderSummary) {
  if (["vendor-accepted", "driver-en-route"].includes(order.workflowStage.key)) return "Customer pickups";
  if (["picked-up", "at-vendor", "washing"].includes(order.workflowStage.key)) return "Vendor handoffs";
  if (["ready", "out-for-delivery"].includes(order.workflowStage.key)) return "Return deliveries";
  return "Other assigned work";
}

const dispatchStages = new Set(["vendor-accepted", "driver-en-route", "picked-up", "ready", "out-for-delivery"]);
const liveLocationStages = new Set(["driver-en-route", "picked-up", "out-for-delivery"]);
const liveLocationCadenceMs = 12_000;
const liveLocationMaximumAgeMs = 2 * 60_000;

function normalizeLiveLocation(value: unknown): DispatchLiveLocation | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const latitude = Number(row.latitude ?? row.lat);
  const longitude = Number(row.longitude ?? row.lng);
  const accuracyMeters = Number(row.accuracyMeters ?? row.accuracy ?? 0);
  const stateValue = String(row.state ?? row.status ?? "").toLowerCase();
  const explicitLive = row.live === true || row.isLive === true;
  const state = stateValue === "live" || stateValue === "recent" ? stateValue : explicitLive ? "live" : "offline";
  const capturedAt = String(row.capturedAt ?? row.recordedAt ?? row.updatedAt ?? "");
  const receivedAt = String(row.receivedAt ?? row.updatedAt ?? capturedAt);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    driverId: String(row.driverId ?? row.riderId ?? row.entityId ?? ""),
    driverName: String(row.driverName ?? row.riderName ?? ""),
    orderId: String(row.orderId ?? ""),
    latitude,
    longitude,
    accuracyMeters: Number.isFinite(accuracyMeters) && accuracyMeters >= 0 ? accuracyMeters : 0,
    capturedAt,
    receivedAt,
    state,
    live: explicitLive || state === "live",
  };
}

function normalizeLiveLocations(payload: unknown) {
  if (!payload || typeof payload !== "object") return [];
  const data = payload as Record<string, unknown>;
  const rows = Array.isArray(data.locations) ? data.locations : data.location ? [data.location] : [];
  return rows.map(normalizeLiveLocation).filter((location): location is DispatchLiveLocation => Boolean(location));
}

function locationIsRecent(location: DispatchLiveLocation) {
  if (location.state !== "live" && location.state !== "recent") return false;
  const timestamp = new Date(location.receivedAt || location.capturedAt).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp <= liveLocationMaximumAgeMs;
}

function liveLocationForOrder(order: OrderSummary, locations: DispatchLiveLocation[]) {
  if (!order.driverId) return undefined;
  return locations.find((location) => location.orderId === order.orderId && location.driverId === order.driverId && locationIsRecent(location));
}

function routeLegLabel(order: OrderSummary) {
  if (["vendor-accepted", "driver-en-route"].includes(order.workflowStage.key)) return "Customer pickup";
  if (order.workflowStage.key === "picked-up") return "Vendor handoff";
  if (order.workflowStage.key === "ready") return "Vendor collection";
  if (order.workflowStage.key === "out-for-delivery") return "Return delivery";
  return "Route work";
}

function hasCustomerRoutePreview(order: OrderSummary) {
  return ["vendor-accepted", "driver-en-route", "out-for-delivery"].includes(order.workflowStage.key);
}

function hasHubToCustomerDirections(order: OrderSummary) {
  return ["vendor-accepted", "driver-en-route"].includes(order.workflowStage.key);
}

function dispatchFreshness(timestamp: string) {
  const savedAt = new Date(timestamp).getTime();
  if (!Number.isFinite(savedAt)) return "time unavailable";
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - savedAt) / 60_000));
  if (elapsedMinutes < 1) return "just now";
  if (elapsedMinutes < 15) return `${elapsedMinutes} min ago`;
  if (elapsedMinutes < 60) return `${elapsedMinutes} min ago · stale; confirm with rider`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} hr ago · stale; confirm with rider`;
  return `${Math.floor(elapsedHours / 24)} day${elapsedHours < 48 ? "" : "s"} ago · stale; confirm with rider`;
}

function dispatchEta(order: OrderSummary) {
  const minutes = Number(order.dispatch?.estimatedDriveMinutes ?? order.route?.estimatedDriveMinutes ?? 0);
  const distance = Number(order.dispatch?.estimatedDistanceKm ?? order.route?.estimatedDistanceKm ?? 0);
  const source = order.dispatch ? order.dispatch.etaSource : minutes > 0 ? "area-estimate" : order.routeWindow && order.routeWindow !== "ETA pending" ? "scheduled-window" : "unavailable";
  const legacyText = source === "area-estimate" && minutes > 0 ? `${minutes} min` : order.routeWindow && order.routeWindow !== "ETA pending" ? order.routeWindow : "Estimate pending";
  const text = order.dispatch ? order.dispatch.etaText || (source === "scheduled-window" ? order.dispatch.scheduledWindow : "Estimate pending") : legacyText;
  const label = source === "rider-reported" ? "Rider-reported ETA" : source === "area-estimate" ? "Area estimate" : source === "scheduled-window" ? "Scheduled window" : "ETA";
  return { distance, minutes, source, text, label, updatedAt: order.dispatch?.etaUpdatedAt || "" };
}

function dispatchEtaForLeg(order: OrderSummary) {
  const eta = dispatchEta(order);
  if (hasCustomerRoutePreview(order) || (order.workflowStage.key === "picked-up" && eta.source === "rider-reported")) return eta;
  return { ...eta, distance: 0, minutes: 0, source: "unavailable" as const, text: "Unavailable", label: "Vendor destination needed", updatedAt: "" };
}

function dispatchPointPosition(point: { lat: number; lng: number } | undefined, fallback: { x: number; y: number }) {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return fallback;
  const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
  return {
    x: clamp(((point.lng + 0.45) / 0.65) * 100, 8, 92),
    y: clamp(((5.95 - point.lat) / 0.5) * 100, 10, 90),
  };
}

function DispatchMap({ order, detail = false, liveLocation }: { order: OrderSummary; detail?: boolean; liveLocation?: DispatchLiveLocation }) {
  const hub = dispatchPointPosition(order.route?.hub, { x: 20, y: 78 });
  const pickup = dispatchPointPosition(order.route?.pickup, { x: 74, y: 28 });
  const rider = liveLocation ? dispatchPointPosition({ lat: liveLocation.latitude, lng: liveLocation.longitude }, { x: 50, y: 50 }) : null;
  const controlY = Math.min(88, Math.max(12, (hub.y + pickup.y) / 2));
  const showCustomerRoute = hasCustomerRoutePreview(order);
  const eta = showCustomerRoute ? dispatchEta(order) : dispatchEtaForLeg(order);
  const checkpoint = order.dispatch?.checkpoint || order.locationNote;
  const distanceText = eta.distance > 0 ? `${eta.distance} km planning distance` : "Distance pending";
  const etaBasis = eta.source === "rider-reported" ? `Reported ${eta.updatedAt ? dispatchFreshness(eta.updatedAt) : "by rider; time unavailable"}` : eta.source === "area-estimate" ? "Based on the service-area planning estimate" : eta.source === "scheduled-window" ? "Scheduled by operations" : "No ETA source recorded";

  return <figure className={`dispatchMap${detail ? " dispatchMapDetail" : ""}`} aria-labelledby={`dispatch-caption-${order.orderId}`}>
    <div className="dispatchMapCanvas" aria-hidden="true">
      <span className="dispatchStreet dispatchStreetOne" />
      <span className="dispatchStreet dispatchStreetTwo" />
      <span className="dispatchStreet dispatchStreetThree" />
      {showCustomerRoute ? <svg className="dispatchRouteLine" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
        <path d={`M ${hub.x} ${hub.y} C ${hub.x} ${controlY}, ${pickup.x} ${controlY}, ${pickup.x} ${pickup.y}`} />
      </svg> : null}
      {showCustomerRoute ? <><span className="dispatchMarker dispatchMarkerHub" style={{ left: `${hub.x}%`, top: `${hub.y}%` }}><i>H</i><b>Dispatch hub</b></span><span className="dispatchMarker dispatchMarkerStop" style={{ left: `${pickup.x}%`, top: `${pickup.y}%` }}><i aria-hidden="true" /><b>{order.area}</b></span></> : null}
      {rider ? <span className={`dispatchMarker dispatchMarkerRider is-${liveLocation?.state}`} style={{ left: `${rider.x}%`, top: `${rider.y}%` }}><i>R</i><b>{liveLocation?.state === "live" ? "Rider sharing live" : "Recent rider position"}</b></span> : null}
      <span className="dispatchMapLabel">{rider ? "Rider location" : "Area-level route preview"}</span>
    </div>
    <figcaption id={`dispatch-caption-${order.orderId}`}>
      <div className="dispatchEta"><span>{eta.label}</span><strong>{eta.text}</strong><small>{etaBasis} · {distanceText}</small></div>
      <div><span className="staffFieldLabel">Last reported checkpoint</span><strong>{checkpoint || "No rider checkpoint yet"}</strong><small>{order.dispatch?.checkpointUpdatedAt ? `Reported ${dispatchFreshness(order.dispatch.checkpointUpdatedAt)}` : order.routeWindow && order.routeWindow !== "ETA pending" ? `No rider report · recorded window: ${order.routeWindow}` : "No checkpoint time recorded"}</small></div>
      {liveLocation ? <div className="dispatchLiveReading"><span>{liveLocation.state === "live" ? "Live GPS" : "Recent GPS"}</span><strong>{liveLocation.driverName || order.driver}</strong><small>Received {dispatchFreshness(liveLocation.receivedAt || liveLocation.capturedAt)}{liveLocation.accuracyMeters ? ` · ±${Math.round(liveLocation.accuracyMeters)} m accuracy` : ""}</small><a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${liveLocation.latitude},${liveLocation.longitude}`)}`} target="_blank" rel="noopener noreferrer">Open live position</a></div> : null}
      <p>{liveLocation ? "The rider marker is based on their latest foreground location share. Traffic is not live." : "No live rider location is available. Route and ETA information remains a planning view."}</p>
    </figcaption>
  </figure>;
}

function DispatchDestinationUnavailable({ order, detail = false }: { order: OrderSummary; detail?: boolean }) {
  const eta = dispatchEtaForLeg(order);
  return <div className={`dispatchDestinationUnavailable${detail ? " dispatchDestinationUnavailableDetail" : ""}`} role="note">
    <span className="staffFieldLabel">{routeLegLabel(order)}</span>
    <h3>Vendor location not recorded</h3>
    <p>This leg cannot show a route or directions until the vendor destination is saved. The customer service-area map is intentionally not reused here.</p>
    <dl><div><dt>{eta.label}</dt><dd>{eta.text}</dd></div><div><dt>Last reported checkpoint</dt><dd>{order.dispatch?.checkpoint || order.locationNote || "No rider checkpoint yet"}</dd></div></dl>
  </div>;
}

function DriverLiveLocationSharing({ order }: { order: OrderSummary }) {
  const [isWatching, setIsWatching] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [message, setMessage] = useState("Live location is off.");
  const [lastSentAt, setLastSentAt] = useState("");
  const [accuracyMeters, setAccuracyMeters] = useState(0);
  const watchIdRef = useRef<number | null>(null);
  const lastSentMsRef = useRef(0);
  const pendingUpdateRef = useRef<Promise<void> | null>(null);
  const sharingRef = useRef(false);
  const eligible = liveLocationStages.has(order.workflowStage.key);

  async function tellServerSharingStopped(keepalive = false) {
    const response = await fetch("/api/dispatch/location", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
      keepalive,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error ?? "Dispatch could not confirm the stop.");
  }

  function clearLocationWatch() {
    if (watchIdRef.current !== null && typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
    watchIdRef.current = null;
    sharingRef.current = false;
    setIsWatching(false);
  }

  useEffect(() => () => {
    if (watchIdRef.current !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchIdRef.current);
    const pendingUpdate = pendingUpdateRef.current;
    if (sharingRef.current || pendingUpdate) {
      const clearServerLocation = () => fetch("/api/dispatch/location", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        cache: "no-store",
        keepalive: true,
      }).catch(() => undefined);
      if (pendingUpdate) void pendingUpdate.finally(clearServerLocation);
      else void clearServerLocation();
    }
    watchIdRef.current = null;
    sharingRef.current = false;
  }, [order.orderId]);

  useEffect(() => {
    if (eligible || watchIdRef.current === null) return;
    const pendingUpdate = pendingUpdateRef.current;
    navigator.geolocation.clearWatch(watchIdRef.current);
    watchIdRef.current = null;
    sharingRef.current = false;
    setIsWatching(false);
    setLastSentAt("");
    setAccuracyMeters(0);
    setMessage("Live location stopped because this route leg is no longer moving.");
    const clearServerLocation = () => fetch("/api/dispatch/location", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
      keepalive: true,
    }).catch(() => undefined);
    if (pendingUpdate) void pendingUpdate.finally(clearServerLocation);
    else void clearServerLocation();
  }, [eligible]);

  function startSharing() {
    if (!eligible || isWatching) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setMessage("This browser does not support location sharing. Use a current mobile browser or report your checkpoint manually.");
      return;
    }
    setMessage("Waiting for location permission and the first GPS reading…");
    lastSentMsRef.current = 0;
    const watchId = navigator.geolocation.watchPosition((position) => {
      const now = Date.now();
      if (pendingUpdateRef.current || (lastSentMsRef.current && now - lastSentMsRef.current < liveLocationCadenceMs)) return;
      const latitude = Number(position.coords.latitude);
      const longitude = Number(position.coords.longitude);
      const accuracy = Number(position.coords.accuracy);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        setMessage("The browser returned an invalid location. Keep this page open and try again.");
        return;
      }
      const update = (async () => {
        try {
          const response = await fetch("/api/dispatch/location", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orderId: order.orderId,
              latitude,
              longitude,
              accuracyMeters: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : 0,
              capturedAt: new Date(position.timestamp || now).toISOString(),
            }),
            cache: "no-store",
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.ok) throw new Error(data.error ?? "Dispatch could not receive this location.");
          if (watchIdRef.current !== watchId) return;
          lastSentMsRef.current = now;
          sharingRef.current = true;
          setLastSentAt(new Date().toISOString());
          setAccuracyMeters(Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : 0);
          setMessage("Live location is being shared with dispatch.");
        } catch (error) {
          if (watchIdRef.current === watchId) setMessage(error instanceof Error ? `${error.message} The browser will retry while this page stays open.` : "Location could not be sent. The browser will retry while this page stays open.");
        } finally {
          pendingUpdateRef.current = null;
        }
      })();
      pendingUpdateRef.current = update;
    }, (error) => {
      const pendingUpdate = pendingUpdateRef.current;
      const hadShared = sharingRef.current;
      clearLocationWatch();
      if (pendingUpdate || hadShared) {
        const clearServerLocation = () => tellServerSharingStopped(true).catch(() => undefined);
        if (pendingUpdate) void pendingUpdate.finally(clearServerLocation);
        else void clearServerLocation();
      }
      const reason = error.code === 1
        ? "Location permission was denied. Allow location access for this site in browser settings, then try again."
        : error.code === 2
          ? "Your location is currently unavailable. Move somewhere with a clearer signal, then try again."
          : error.code === 3
            ? "The location request timed out. Check GPS and mobile data, then try again."
            : "Live location could not start. Check browser location settings, then try again.";
      setMessage(reason);
    }, { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 });
    watchIdRef.current = watchId;
    setIsWatching(true);
  }

  async function stopSharing() {
    setIsStopping(true);
    const pendingUpdate = pendingUpdateRef.current;
    clearLocationWatch();
    try {
      if (pendingUpdate) await pendingUpdate.catch(() => undefined);
      await tellServerSharingStopped();
      setMessage("Live location is off and the dispatch marker was cleared.");
    } catch (error) {
      setMessage(error instanceof Error ? `${error.message} Sharing has stopped on this device and the last position will expire.` : "Sharing has stopped on this device and the last position will expire.");
    } finally {
      setIsStopping(false);
      setLastSentAt("");
      setAccuracyMeters(0);
    }
  }

  return <section className="driverLiveShare" aria-labelledby={`live-share-${order.orderId}`}>
    <div className="driverLiveShareCopy"><span className="staffFieldLabel">Foreground GPS · {order.orderId}</span><h3 id={`live-share-${order.orderId}`}>Live location sharing</h3><p>{eligible ? "Share your position with Bubble Wash dispatch while traveling on this route leg." : "Live sharing becomes available after this route leg begins moving."}</p></div>
    <div className="driverLiveShareStatus"><span className={`liveShareIndicator${lastSentAt ? " is-on" : ""}`} aria-hidden="true" /><div><strong>{isWatching ? lastSentAt ? "Sharing on" : "Starting…" : "Sharing off"}</strong><p role="status" aria-live="polite">{message}{lastSentAt ? ` Last sent ${dispatchFreshness(lastSentAt)}${accuracyMeters ? ` with about ±${Math.round(accuracyMeters)} m accuracy` : ""}.` : ""}</p></div></div>
    <div className="driverLiveShareActions">{isWatching ? <button className="button secondary" type="button" disabled={isStopping} onClick={() => void stopSharing()}>{isStopping ? "Stopping…" : "Stop sharing"}</button> : <button className="button primary" type="button" disabled={!eligible || isStopping} onClick={startSharing}>Start live sharing</button>}<p>Location permission is requested only after you start. Keep this page open during the trip; locking the phone, closing the page, or losing data can pause updates.</p></div>
  </section>;
}

function DispatchBoard({ orders, role, basePath, hasLoaded, lastSyncedAt = "", embedded = false, error = "", liveLocations = [], locationError = "" }: { orders: OrderSummary[]; role: "admin" | "driver"; basePath: string; hasLoaded: boolean; lastSyncedAt?: string; embedded?: boolean; error?: string; liveLocations?: DispatchLiveLocation[]; locationError?: string }) {
  const routeOrders = useMemo(() => orders
    .filter((order) => !isClosedOrder(order) && dispatchStages.has(order.workflowStage.key))
    .sort((left, right) => {
      const activeLeg = (order: OrderSummary) => ["driver-en-route", "out-for-delivery"].includes(order.workflowStage.key) ? 0 : ["picked-up", "ready"].includes(order.workflowStage.key) ? 1 : 2;
      const risk = (order: OrderSummary) => order.stageTimer.tone === "breached" ? 0 : order.stageTimer.tone === "due" ? 1 : 2;
      return activeLeg(left) - activeLeg(right) || risk(left) - risk(right) || new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime();
    }), [orders]);
  const [selectedId, setSelectedId] = useState("");
  const selectedOrder = routeOrders.find((order) => order.orderId === selectedId) ?? routeOrders[0];
  const assignedOrders = routeOrders.filter((order) => order.driver !== "Unassigned");
  const activeRiders = new Set(assignedOrders.map((order) => order.driver.trim().toLowerCase()).filter(Boolean));
  const needsRider = routeOrders.length - assignedOrders.length;
  const selectedLiveLocation = role === "admin" && selectedOrder ? liveLocationForOrder(selectedOrder, liveLocations) : undefined;
  const liveRiderCount = role === "admin" ? new Set(routeOrders.map((order) => liveLocationForOrder(order, liveLocations)?.driverId || "").filter(Boolean)).size : 0;
  const detailHref = selectedOrder ? `${basePath}${basePath.includes("?") ? "&" : "?"}order=${encodeURIComponent(selectedOrder.orderId)}` : basePath;

  return <section className={embedded ? "dispatchEmbedded" : "staffContentSection dispatchSection"} aria-labelledby={`${role}-dispatch-heading`} aria-busy={!hasLoaded}>
    <div className="staffSectionHeader dispatchHeader"><div><h2 id={`${role}-dispatch-heading`}>{role === "admin" ? "Current dispatch board" : "Today’s route map"}</h2><p>{role === "admin" ? "Assigned route work, recorded ETAs, and rider-authorized foreground locations across the pilot." : "Open a stop to see its route estimate, window, directions, and live sharing control."}</p></div>{lastSyncedAt ? <span className="dispatchSync">Board refreshed {formatMetricTime(lastSyncedAt)}</span> : null}</div>
    {!hasLoaded ? <LoadingSkeleton label="Loading dispatch routes and estimates" rows={2} variant="map" /> : error && !orders.length ? <div className="staffEmptyState" role="alert"><h3>Dispatch unavailable</h3><p>{error} The board will retry automatically.</p></div> : selectedOrder ? <>
      {role === "driver" ? <DriverLiveLocationSharing key={selectedOrder.orderId} order={selectedOrder} /> : null}
      <div className="dispatchSummaryLine" aria-label="Dispatch summary"><span><strong>{assignedOrders.length}</strong> assigned moves</span><span><strong>{activeRiders.size}</strong> {activeRiders.size === 1 ? "rider" : "riders"} assigned</span><span><strong>{needsRider}</strong> awaiting rider</span>{role === "admin" ? <span><strong>{liveRiderCount}</strong> sharing live</span> : null}</div>
      <div className="dispatchBoard">
        {hasCustomerRoutePreview(selectedOrder) || selectedLiveLocation ? <DispatchMap order={selectedOrder} liveLocation={selectedLiveLocation} /> : <DispatchDestinationUnavailable order={selectedOrder} />}
        <div className="dispatchStopPanel"><div className="dispatchStopPanelHeader"><h3>Route work</h3><span>Operational order, not an optimized stop sequence</span></div><div className="dispatchStopList" role="list">
          {routeOrders.slice(0, 10).map((order) => { const eta = dispatchEtaForLeg(order); return <div key={order.orderId} role="listitem"><button aria-pressed={order.orderId === selectedOrder.orderId} className="dispatchStopRow" onClick={() => setSelectedId(order.orderId)} type="button"><span><strong>{order.driver === "Unassigned" ? "Rider needed" : order.driver}</strong><small>{order.orderId} · {routeLegLabel(order)}</small></span><span><strong>{eta.text}</strong><small>{eta.label} · {order.area}</small></span></button></div>; })}
        </div>{routeOrders.length > 10 ? <p className="dispatchMore">Showing 10 of {routeOrders.length} route moves.</p> : null}<div className="dispatchStopActions"><Link className="button primary" href={detailHref}>{role === "admin" ? "Open order" : "Open stop"}</Link>{hasHubToCustomerDirections(selectedOrder) && selectedOrder.route.directionsUrl ? <a className="button secondary" href={selectedOrder.route.directionsUrl} target="_blank" rel="noopener noreferrer">Open pickup directions</a> : selectedOrder.workflowStage.key === "out-for-delivery" && selectedOrder.route.googleMapsUrl ? <a className="button secondary" href={selectedOrder.route.googleMapsUrl} target="_blank" rel="noopener noreferrer">Open destination area</a> : null}</div></div>
      </div>
      <p className="dispatchDisclosure">{role === "admin" ? "A rider marker appears only while that assigned rider is actively sharing a recent foreground GPS position for the selected order. ETAs and traffic are not live." : "ETAs are rider-reported, scheduled, or calculated from the dispatch hub to a representative service area."}</p>
    </> : <div className="staffEmptyState"><h3>No active route work</h3><p>Assigned customer pickups, vendor handoffs, and return deliveries will appear here.</p></div>}
    {error && orders.length ? <p className="status error" role="alert">{error} Showing the last available dispatch view.</p> : null}
    {role === "admin" && locationError ? <p className="status error" role="alert">{locationError} Live rider markers are hidden until tracking reconnects.</p> : null}
  </section>;
}

function AdminDispatchWorkspace() {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [liveLocations, setLiveLocations] = useState<DispatchLiveLocation[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState("");
  const [loadError, setLoadError] = useState("");
  const [locationError, setLocationError] = useState("");

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const response = await fetch("/api/orders");
        const data = await response.json();
        if (!active) return;
        if (!response.ok || !data.ok) throw new Error(data.error ?? "Unable to load dispatch.");
        setOrders(data.orders ?? []);
        setLastSyncedAt(new Date().toISOString());
        setLoadError("");
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : "Unable to load dispatch.");
      } finally {
        if (active) setHasLoaded(true);
      }
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);

  useEffect(() => {
    let active = true;
    async function refreshLocations() {
      if (document.hidden) return;
      try {
        const response = await fetch("/api/dispatch/location", { cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (!active) return;
        if (!response.ok || !data.ok) throw new Error(data.error ?? "Live rider locations are unavailable.");
        setLiveLocations(normalizeLiveLocations(data));
        setLocationError("");
      } catch (error) {
        if (!active) return;
        setLiveLocations([]);
        setLocationError(error instanceof Error ? error.message : "Live rider locations are unavailable.");
      }
    }
    void refreshLocations();
    const interval = window.setInterval(() => void refreshLocations(), liveLocationCadenceMs);
    return () => { active = false; window.clearInterval(interval); };
  }, []);

  return <DispatchBoard orders={orders} role="admin" basePath="/admin?view=orders" hasLoaded={hasLoaded} lastSyncedAt={lastSyncedAt} error={loadError} liveLocations={liveLocations} locationError={locationError} />;
}

function SharedOrderBoard({ role, userName, selectedOrderId = "", basePath }: { role: StaffRole; userName: string; selectedOrderId?: string; basePath: string }) {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [liveLocations, setLiveLocations] = useState<DispatchLiveLocation[]>([]);
  const [locationError, setLocationError] = useState("");
  const [status, setStatus] = useState("Loading shared order board…");
  const [lastSyncedAt, setLastSyncedAt] = useState("");
  const [hasLoaded, setHasLoaded] = useState(false);
  const [queueView, setQueueView] = useState<QueueView>("action");
  const [query, setQuery] = useState("");
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [visibleCount, setVisibleCount] = useState(12);
  const olderPagesLoaded = useRef(false);

  async function loadOrders(showLoading = true, offset = 0) {
    if (showLoading) setStatus("Loading shared order board…");
    olderPagesLoaded.current = offset > 0;
    try {
      const response = await fetch(`/api/orders?${new URLSearchParams({ offset: String(offset), q: selectedOrderId || query })}`);
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setStatus(data.error ?? "Unable to load shared orders.");
        setHasLoaded(true);
        return;
      }
      setOrders((current) => offset ? [...current, ...data.orders.filter((order: OrderSummary) => !current.some((existing) => existing.orderId === order.orderId))] : data.orders);
      setNextOffset(data.nextOffset);
      if (offset) setVisibleCount((count) => count + 100);
      setHasLoaded(true);
      setLastSyncedAt(new Date().toISOString());
      setStatus(data.orders.length ? "Updated." : "No shared orders yet.");
    } catch {
      setStatus("Unable to load shared orders.");
      setHasLoaded(true);
    }
  }

  useEffect(() => {
    let active = true;
    async function refresh(showLoading = false) {
      if (!active || (!showLoading && (document.hidden || olderPagesLoaded.current))) return;
      if (showLoading) setStatus("Loading shared order board…");
      try {
        const response = await fetch(`/api/orders?${new URLSearchParams({ q: selectedOrderId || query })}`);
        const data = await response.json();
        if (!active) return;
        if (!response.ok || !data.ok) {
          setStatus(data.error ?? "Unable to load shared orders.");
          setHasLoaded(true);
          return;
        }
        setOrders(data.orders);
        setNextOffset(data.nextOffset);
        setHasLoaded(true);
        setLastSyncedAt(new Date().toISOString());
        setStatus(data.orders.length ? "Updated." : "No shared orders yet.");
      } catch {
        if (active) {
          setStatus("Unable to load shared orders.");
          setHasLoaded(true);
        }
      }
    }
    refresh(true);
    const interval = window.setInterval(() => void refresh(false), 30_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [selectedOrderId, query]);

  useEffect(() => {
    if (role !== "admin" || !selectedOrderId) return;
    let active = true;
    async function refreshLocation() {
      if (document.hidden) return;
      try {
        const response = await fetch("/api/dispatch/location", { cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (!active) return;
        if (!response.ok || !data.ok) throw new Error(data.error ?? "Live rider location is unavailable.");
        setLiveLocations(normalizeLiveLocations(data));
        setLocationError("");
      } catch (error) {
        if (!active) return;
        setLiveLocations([]);
        setLocationError(error instanceof Error ? error.message : "Live rider location is unavailable.");
      }
    }
    void refreshLocation();
    const interval = window.setInterval(() => void refreshLocation(), liveLocationCadenceMs);
    return () => { active = false; window.clearInterval(interval); };
  }, [role, selectedOrderId]);

  const activeOrders = orders.filter((order) => !isClosedOrder(order));
  const focusOrders = activeOrders.filter((order) => orderMatchesRoleFocus(order, role, userName));
  const sourceOrders = queueView === "action" ? focusOrders : queueView === "active" ? activeOrders : orders;
  const normalizedQuery = query.trim().toLowerCase();
  const matchingOrders = normalizedQuery ? sourceOrders.filter((order) => [order.orderId, order.customer, order.phone, order.email, order.area, order.vendor, order.driver, order.status, order.payment].join(" ").toLowerCase().includes(normalizedQuery)) : sourceOrders;
  const visibleOrders = matchingOrders.slice(0, visibleCount);
  const stats = queueStats(activeOrders, role, userName);
  const queueHeading = !hasLoaded ? "Loading order queue…" : queueView === "action" ? (stats.focusCount ? `${stats.focusCount} ${stats.focusLabel}` : "No work needs this role right now") : queueView === "active" ? `${activeOrders.length} active orders` : `${orders.length} total orders`;
  const selectedOrder = selectedOrderId ? orders.find((order) => order.orderId.toLowerCase() === selectedOrderId.toLowerCase()) : null;
  const selectedLiveLocation = role === "admin" && selectedOrder ? liveLocationForOrder(selectedOrder, liveLocations) : undefined;
  const selectedDispatchEta = selectedOrder && dispatchStages.has(selectedOrder.workflowStage.key) ? dispatchEtaForLeg(selectedOrder) : null;
  const canSeePayment = role === "admin" || role === "support";
  const canSeeCollection = role !== "vendor";
  const detailHref = (orderId: string) => `${basePath}${basePath.includes("?") ? "&" : "?"}order=${encodeURIComponent(orderId)}`;
  const driverGroups = ["Customer pickups", "Vendor handoffs", "Return deliveries", "Other assigned work"].map((label) => ({ label, orders: visibleOrders.filter((order) => driverStopGroup(order) === label) })).filter((group) => group.orders.length);

  return (
    <section className="staffContentSection sharedBoardSection" aria-busy={!hasLoaded}>
      {role === "driver" && !selectedOrderId ? <DispatchBoard orders={orders} role="driver" basePath={basePath} hasLoaded={hasLoaded} lastSyncedAt={lastSyncedAt} error={/unable/i.test(status) ? status : ""} embedded /> : null}
      {selectedOrderId ? selectedOrder ? <article className="staffDetailView orderDetail">
        <Link className="staffBackLink" href={basePath}>← Back to order list</Link>
        <header className="staffDetailHeader">
          <div><span className="staffFieldLabel">{selectedOrder.orderId}</span><h2>{selectedOrder.customer}</h2><p>{selectedOrder.workflowStage.label} · {workflowPhaseLabel(selectedOrder.workflowStage.key)}</p></div>
          <StageCountdown order={selectedOrder} />
        </header>

        <section className="staffPrimaryAction" aria-labelledby="order-next-action"><div><span className="staffFieldLabel">Next verified action</span><h3 id="order-next-action">{selectedOrder.nextStep}</h3></div><AutomatedOrderActions order={selectedOrder} role={role} userName={userName} onSaved={() => loadOrders(false)} /></section>

        <div className="staffDetailSections">
          <details className="staffDetailDisclosure"><summary><span><strong>Customer and collection</strong><small>{selectedOrder.area} · {selectedOrder.routeWindow}</small></span></summary><div className="staffDisclosureBody"><dl className="staffDefinitionList">
            <div><dt>Customer</dt><dd>{selectedOrder.customer}</dd></div>
            <div><dt>Plan</dt><dd>{selectedOrder.plan || "Not recorded"}</dd></div>
            <div><dt>Service</dt><dd>{selectedOrder.serviceType || "Not recorded"}</dd></div>
            <div><dt>Area</dt><dd>{selectedOrder.area}</dd></div>
            <div><dt>Collection window</dt><dd>{selectedOrder.routeWindow}</dd></div>
            {canSeeCollection ? <><div><dt>Pickup address</dt><dd>{selectedOrder.pickupAddress || "Not recorded"}</dd></div><div><dt>Landmark</dt><dd>{selectedOrder.landmark || "Not recorded"}</dd></div><div><dt>Phone</dt><dd>{selectedOrder.phone || "Not recorded"}</dd></div></> : null}
          </dl>{canSeeCollection ? <CustomerContactActions order={selectedOrder} role={role} /> : null}</div></details>

          <details className="staffDetailDisclosure"><summary><span><strong>Assignment and route</strong><small>{selectedOrder.vendor} · {selectedOrder.driver}</small></span></summary><div className="staffDisclosureBody"><dl className="staffDefinitionList"><div><dt>Vendor</dt><dd>{selectedOrder.vendor}</dd></div><div><dt>Rider</dt><dd>{selectedOrder.driver}</dd></div><div><dt>Last reported checkpoint</dt><dd>{selectedOrder.dispatch?.checkpoint || selectedOrder.locationNote}</dd></div>{role !== "vendor" && selectedDispatchEta ? <><div><dt>{selectedDispatchEta.label}</dt><dd>{selectedDispatchEta.text}{selectedDispatchEta.source === "rider-reported" && selectedDispatchEta.updatedAt ? ` · reported ${dispatchFreshness(selectedDispatchEta.updatedAt)}` : ""}</dd></div><div><dt>Planning distance</dt><dd>{selectedDispatchEta.distance > 0 ? `${selectedDispatchEta.distance} km from dispatch hub to service area` : "Not available"}</dd></div></> : null}<div><dt>Priority</dt><dd>{selectedOrder.priority}</dd></div></dl>
            {role !== "support" ? <div className="staffDetailActions"><a className="button secondary" href={`/api/orders/label?orderId=${encodeURIComponent(selectedOrder.orderId)}`} target="_blank" rel="noopener noreferrer">Open printable bag QR</a></div> : null}
            {role === "driver" ? <DriverLiveLocationSharing key={selectedOrder.orderId} order={selectedOrder} /> : null}
            {(role === "admin" || role === "driver") ? hasCustomerRoutePreview(selectedOrder) || selectedLiveLocation ? <DispatchMap order={selectedOrder} detail liveLocation={selectedLiveLocation} /> : <DispatchDestinationUnavailable order={selectedOrder} detail /> : null}
            {role === "admin" && locationError ? <p className="status error" role="alert">{locationError} Live rider markers are hidden until tracking reconnects.</p> : null}
            {canSeeCollection && hasCustomerRoutePreview(selectedOrder) && (selectedOrder.route.directionsUrl || selectedOrder.route.googleMapsUrl) ? <div className="staffDetailActions">{hasHubToCustomerDirections(selectedOrder) && selectedOrder.route.directionsUrl ? <a className="button secondary" href={selectedOrder.route.directionsUrl} target="_blank" rel="noopener noreferrer">Open pickup directions</a> : null}{selectedOrder.route.googleMapsUrl ? <a className="button secondary" href={selectedOrder.route.googleMapsUrl} target="_blank" rel="noopener noreferrer">Open {selectedOrder.workflowStage.key === "out-for-delivery" ? "destination area" : "service area"}</a> : null}</div> : null}
            {role === "support" ? <p className="dispatchDetailDisclosure">{hasCustomerRoutePreview(selectedOrder) ? "Planning information only. Support cannot access live rider GPS, and live traffic is not available." : "Vendor location not recorded; route directions are unavailable for this leg. Support cannot access live rider GPS."}</p> : null}
          </div></details>

          {canSeePayment ? <StaffInvoicePanel key={`${selectedOrder.orderId}-${selectedOrder.activityUpdatedAt}`} orderId={selectedOrder.orderId} admin={role === "admin"} /> : null}
          {canSeePayment ? <details className="staffDetailDisclosure"><summary><span><strong>Payment</strong><small>{selectedOrder.payment}</small></span></summary><div className="staffDisclosureBody"><dl className="staffDefinitionList"><div><dt>Status</dt><dd>{selectedOrder.payment}</dd></div><div><dt>Customer email</dt><dd>{selectedOrder.email || "Not recorded"}</dd></div></dl></div></details> : null}

          <details className="staffDetailDisclosure"><summary><span><strong>Order history</strong><small>{compactTimelineLabel(selectedOrder.eventCount)}</small></span></summary><div className="staffDisclosureBody"><div className="staffTimeline">{selectedOrder.timeline.map((event) => <div key={`${selectedOrder.orderId}-${event.id}-${event.createdAt}`}><time>{formatShortTime(event.createdAt)}</time><div><strong>{event.status}</strong><span>{event.type} · {event.actor}</span><p>{event.note}</p></div></div>)}</div></div></details>
        </div>
      </article> : hasLoaded ? <div className="staffEmptyState"><h2>Order not found</h2><p>This order is not available to this staff role.</p><Link href={basePath}>Back to the order list</Link></div> : <LoadingSkeleton label="Loading order details" rows={4} variant="detail" /> : <>
        <div className="staffSectionHeader"><div><h2>{queueHeading}</h2><p>{stats.riskCount} at risk · {stats.automationCount} verified actions available</p></div><button className="button secondary" type="button" onClick={() => loadOrders()}>Refresh</button></div>
        <div className="staffFilterBar">
          <div className="staffTextFilters" aria-label="Order queue view">{([ ["action", "Needs action"], ["active", "All active"], ["all", "History"] ] as Array<[QueueView, string]>).map(([key, label]) => <button aria-pressed={queueView === key} className={queueView === key ? "active" : ""} key={key} type="button" onClick={() => setQueueView(key)}>{label}</button>)}</div>
          <label className="staffSearch"><span>Find an order</span><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setVisibleCount(12); }} placeholder="Reference or customer name…" /></label>
        </div>
        <div className="staffOrderList" role="list">
          <div className="staffOrderListHeader" aria-hidden="true"><span>Order</span><span>Stage</span><span>Collection</span><span>Assignment</span><span></span></div>
          {role === "driver" ? driverGroups.map((group) => <section className="staffOrderGroup" key={group.label} aria-labelledby={`driver-group-${group.label.replaceAll(" ", "-").toLowerCase()}`}><h3 className="staffOrderGroupTitle" id={`driver-group-${group.label.replaceAll(" ", "-").toLowerCase()}`}>{group.label}<span>{group.orders.length}</span></h3>{group.orders.map((order) => <OrderQueueRow href={detailHref(order.orderId)} key={order.orderId} order={order} />)}</section>) : visibleOrders.map((order) => <OrderQueueRow href={detailHref(order.orderId)} key={order.orderId} order={order} />)}
          {!visibleOrders.length ? !hasLoaded ? <LoadingSkeleton label="Loading order queue" rows={5} /> : <p className="staffEmptyState">{normalizedQuery ? "No orders match this search." : queueView === "action" ? "No orders currently need action from this role." : "No orders in this view yet."}</p> : null}
        </div>
        <div className="tableActionRow">{matchingOrders.length > visibleCount ? <button className="button secondary" onClick={() => setVisibleCount((count) => count + 24)}>Show more orders</button> : nextOffset !== null ? <button className="button secondary" onClick={() => loadOrders(false, nextOffset)}>Load older orders</button> : null}</div>
      </>}
      <p className={noticeClass(status)} role="status" aria-live="polite">{status}{lastSyncedAt ? ` Last synced ${formatMetricTime(lastSyncedAt)}. ${selectedOrderId ? "" : `Showing ${visibleOrders.length} of ${matchingOrders.length}.`}` : ""}</p>
    </section>
  );
}

async function postJSON<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

function PortalShell({ title, role, pageRole = role, userName, currentView, navigation, children }: PortalShellProps) {
  const promise = rolePromise(pageRole, currentView);

  async function logoutStaff() {
    try {
      await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: "{}" });
    } finally {
      window.location.replace("/login");
    }
  }

  return (
    <main className="portalPage">
      <header className="staffTopbar">
        <BrandLink />
        <div className="staffAccount"><span><strong>{userName}</strong><small>{title}</small></span><button className="staffSignOut" type="button" onClick={logoutStaff}>Sign out</button></div>
      </header>
      <nav className="staffSectionNav" aria-label={`${pageRole} workspace sections`}>
        {navigation.map((item) => {
          const Icon = workspaceIcons[item.view as keyof typeof workspaceIcons] ?? ActivityIcon;
          return <Link key={item.view} href={item.href} aria-current={item.view === currentView ? "page" : undefined}><Icon aria-hidden="true" /><span>{item.label}</span></Link>;
        })}
      </nav>
      <section className="staffViewHeader">
        <p className="eyebrow">{promise.eyebrow}</p>
        <h1>{promise.title}</h1>
        <p>{promise.subtitle}</p>
      </section>
      <div className="staffView">{children}</div>
    </main>
  );
}


function SupportTicketForm({ onSubmit, status, pending = false }: { userName: string; role: StaffRole; onSubmit: SubmitHandler; status?: string; pending?: boolean }) {
  return (
    <form className="panel supportForm" onSubmit={(event) => onSubmit(event, "support-ticket")}>
      <h3>Open support ticket</h3>
      <p className="formHint">The signed-in operator is recorded automatically.</p>
      <div className="two"><label>Related order<input name="orderId" placeholder="BW-…" /></label><label>Issue type<select name="issueType">{supportTypes.map((item) => <option key={item}>{item}</option>)}</select></label></div>
      <div className="two"><label>Priority<select name="priority"><option>Normal</option><option>High</option><option>Urgent</option></select></label><label>Current status<select name="ticketStatus"><option>Open</option><option>Waiting on Customer</option><option>Waiting on Vendor</option><option>Waiting on Driver</option></select></label></div>
      <label>Case note<textarea name="message" placeholder="Customer impact, delay reason, payment reference, or item issue" required /></label>
      <button className="button primary full" type="submit" disabled={pending}>{pending ? "Saving ticket…" : "Raise Support Ticket"}</button>
      {status && <p className={noticeClass(status)} role="status">{status}</p>}
    </form>
  );
}

function StaffAccessRoster({ refreshToken = 0 }: { refreshToken?: number }) {
  const [members, setMembers] = useState<StaffRosterMember[]>([]);
  const [status, setStatus] = useState("Loading staff roster…");
  const [hasLoaded, setHasLoaded] = useState(false);

  async function loadRoster() {
    setStatus("Loading staff roster…");
    try {
      const response = await fetch("/api/staff/roster");
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setStatus(data.error ?? "Unable to load staff roster.");
        setHasLoaded(true);
        return;
      }
      setMembers(data.members ?? []);
      setStatus(data.members?.length ? "Staff roster updated." : "No staff roster entries yet.");
      setHasLoaded(true);
    } catch {
      setStatus("Unable to load staff roster.");
      setHasLoaded(true);
    }
  }

  useEffect(() => {
    let active = true;
    fetch("/api/staff/roster")
      .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
      .then(({ ok, data }) => {
        if (!active) return;
        if (!ok || !data.ok) {
          setStatus(data.error ?? "Unable to load staff roster.");
          setHasLoaded(true);
          return;
        }
        setMembers(data.members ?? []);
        setStatus(data.members?.length ? "Staff roster updated." : "No staff roster entries yet.");
        setHasLoaded(true);
      })
      .catch(() => { if (active) { setStatus("Unable to load staff roster."); setHasLoaded(true); } });
    return () => { active = false; };
  }, [refreshToken]);

  return <section className="staffContentSection" aria-busy={!hasLoaded}>
    <div className="staffSectionHeader"><div><h2>Bubble Wash staff access</h2><p>Roster status and whether secure sign-in has been configured.</p></div><button className="button secondary" type="button" onClick={() => void loadRoster()}>Refresh</button></div>
    <div className="staffRosterList">
      {!hasLoaded ? <LoadingSkeleton label="Loading staff access roster" rows={4} /> : members.map((member) => <article className="staffRosterRow staffAccessRow" key={member.id}>
        <div><strong>{member.name}</strong><span>{member.email}</span></div>
        <div><span className="staffFieldLabel">Role</span><strong>{member.role}</strong></div>
        <div><span className="staffFieldLabel">Status</span><strong>{member.status}</strong></div>
        <div><span className="staffFieldLabel">Access</span><strong>{member.access === "configured" ? "Sign-in configured" : "Roster only"}</strong></div>
        <p>{member.workArea || member.phone || "Work area not recorded."}</p>
      </article>)}
      {hasLoaded && !members.length ? <p className="staffEmptyState">No staff roster entries yet.</p> : null}
    </div>
    <p className={noticeClass(status)} role="status" aria-live="polite">{status}</p>
  </section>;
}

function AdminOnboardingCenter({ onSubmit, status, pendingType = "" }: { onSubmit: SubmitHandler; status: Record<string, string>; pendingType?: string }) {
  return (
    <section className="staffContentSection onboardingCenter" aria-labelledby="admin-onboarding-title">
      <div className="staffSectionHeader"><div><h2 id="admin-onboarding-title">Onboard partners and staff</h2><p>Add one person or partner at a time. Roster entry does not expose or generate a password.</p></div></div>
      <div className="staffOnboardingList">
        <details className="staffRosterEditor"><summary><span><strong>Vendor partner</strong><small>Business, coverage, services, and capacity</small></span><b>Open form</b></summary><form className="staffForm" onSubmit={(event) => onSubmit(event, "vendor-application")}>
          <div className="formTitleRow"><h3>Onboard vendor</h3><span>Admin owned</span></div>
          <div className="two"><label>Vendor contact name<input name="name" required /></label><label>Vendor contact email<input name="email" type="email" required /></label></div>
          <div className="two"><label>Vendor phone<input name="phone" placeholder="Phone or WhatsApp" required /></label><label>Laundry business<input name="company" required /></label></div>
          <div className="two"><label>Approved zones<input name="area" placeholder="Osu, Labone" required /></label><label>Order slots today<input name="capacity" type="number" min="0" inputMode="numeric" placeholder="8" required /></label></div>
          <div className="two"><label>Availability<select name="availability"><option>Available today</option><option>Available tomorrow</option><option>Limited capacity</option><option>Paused today</option></select></label><label>Approved service<select name="services"><option>Wash + fold</option><option>Wash + iron + fold</option><option>Ironing only</option><option>Express capable</option><option>Bulk commercial</option></select></label></div>
          <label>Roster note<textarea name="message" placeholder="KYC checks, machine capacity, turnaround promise, pickup limits, or restrictions" required /></label>
          <button className="button primary full" type="submit" disabled={Boolean(pendingType)}>{pendingType === "vendor-application" ? "Saving vendor…" : "Save Vendor Roster"}</button>
          {status["vendor-application"] && <p className={noticeClass(status["vendor-application"])} role="status">{status["vendor-application"]}</p>}
        </form></details>
        <details className="staffRosterEditor"><summary><span><strong>Rider</strong><small>Identity, vehicle, route zones, and slots</small></span><b>Open form</b></summary><form className="staffForm" onSubmit={(event) => onSubmit(event, "driver-onboarding")}>
          <div className="formTitleRow"><h3>Onboard rider</h3><span>Dispatch source</span></div>
          <div className="two"><label>Rider full name<input name="name" required /></label><label>Rider email<input name="email" type="email" required /></label></div>
          <div className="two"><label>Rider phone<input name="phone" placeholder="Phone or WhatsApp" required /></label><label>Route team<input name="company" defaultValue="Bubble Wash Route Team" required /></label></div>
          <div className="two"><label>Approved route zones<input name="area" placeholder="Osu, Labone" required /></label><label>Bike or vehicle ID<input name="vehicle" required /></label></div>
          <div className="two"><label>Route slots today<input name="routeCapacity" type="number" min="0" inputMode="numeric" defaultValue="4" /></label><label>Rider status<select name="driverStatus"><option>Active</option><option>Training</option><option>Inactive</option><option>Suspended</option></select></label></div>
          <div className="two"><label>Availability<select name="availability"><option>Available today</option><option>Available tomorrow</option><option>Limited route capacity</option><option>Paused today</option></select></label><label>Backup zones<input name="serviceZones" placeholder="Airport, Cantonments" /></label></div>
          <label>Roster note<textarea name="message" placeholder="ID or licence check, route restrictions, emergency contact, or bag handoff rules" required /></label>
          <button className="button primary full" type="submit" disabled={Boolean(pendingType)}>{pendingType === "driver-onboarding" ? "Saving rider…" : "Save Rider Roster"}</button>
          {status["driver-onboarding"] && <p className={noticeClass(status["driver-onboarding"])} role="status">{status["driver-onboarding"]}</p>}
        </form></details>
        <details className="staffRosterEditor"><summary><span><strong>Bubble Wash staff</strong><small>Admin, support, or operations roster entry</small></span><b>Open form</b></summary><form className="staffForm" onSubmit={(event) => onSubmit(event, "staff-onboarding")}>
          <div className="formTitleRow"><h3>Onboard staff member</h3><span>Roster only</span></div>
          <div className="two"><label>Full name<input name="staffName" required /></label><label>Work email<input name="staffEmail" type="email" required /></label></div>
          <div className="two"><label>Phone<input name="staffPhone" required /></label><label>Role<select name="staffRole"><option>Support</option><option>Admin</option><option>Operations</option></select></label></div>
          <div className="two"><label>Employment status<select name="employmentStatus"><option>Active</option><option>Training</option><option>Pending checks</option><option>Inactive</option></select></label><label>Primary work area<input name="workArea" placeholder="Support desk, dispatch, finance…" required /></label></div>
          <label>Onboarding note<textarea name="message" placeholder="Checks completed, training still required, permissions requested, or start date" required /></label>
          <p className="formHint">Login access remains controlled by the secure deployment configuration. No password is stored in this roster form.</p>
          <button className="button primary full" type="submit" disabled={Boolean(pendingType)}>{pendingType === "staff-onboarding" ? "Saving staff member…" : "Save Staff Roster"}</button>
          {status["staff-onboarding"] && <p className={noticeClass(status["staff-onboarding"])} role="status">{status["staff-onboarding"]}</p>}
        </form></details>
      </div>
    </section>
  );
}

function AdminOverview({ userName }: { userName: string }) {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [vendors, setVendors] = useState<VendorAvailabilityRow[]>([]);
  const [drivers, setDrivers] = useState<DriverAvailabilityRow[]>([]);
  const [records, setRecords] = useState<SubmissionRecord[]>([]);
  const [status, setStatus] = useState("Loading today’s overview…");
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");

  async function loadOverview() {
    setStatus("Loading today’s overview…");
    setLoadError("");
    try {
      const [orderResponse, availabilityResponse, submissionResponse] = await Promise.all([fetch("/api/orders"), fetch("/api/availability"), fetch("/api/submissions")]);
      const [orderData, availabilityData, submissionData] = await Promise.all([orderResponse.json(), availabilityResponse.json(), submissionResponse.json()]);
      if (!orderResponse.ok || !orderData.ok) throw new Error(orderData.error ?? "Unable to load orders.");
      if (!availabilityResponse.ok || !availabilityData.ok) throw new Error(availabilityData.error ?? "Unable to load capacity.");
      if (!submissionResponse.ok || !submissionData.ok) throw new Error(submissionData.error ?? "Unable to load support activity.");
      setOrders(orderData.orders ?? []);
      setVendors(availabilityData.vendors ?? []);
      setDrivers(availabilityData.drivers ?? []);
      setRecords(submissionData.records ?? []);
      setStatus("Overview updated.");
      setLoadError("");
      setHasLoaded(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load operations overview.";
      setStatus(message);
      setLoadError(message);
      setHasLoaded(true);
    }
  }

  useEffect(() => {
    let active = true;
    Promise.all([fetch("/api/orders"), fetch("/api/availability"), fetch("/api/submissions")])
      .then(async ([orderResponse, availabilityResponse, submissionResponse]) => {
        const [orderData, availabilityData, submissionData] = await Promise.all([orderResponse.json(), availabilityResponse.json(), submissionResponse.json()]);
        if (!active) return;
        if (!orderResponse.ok || !orderData.ok) throw new Error(orderData.error ?? "Unable to load orders.");
        if (!availabilityResponse.ok || !availabilityData.ok) throw new Error(availabilityData.error ?? "Unable to load capacity.");
        if (!submissionResponse.ok || !submissionData.ok) throw new Error(submissionData.error ?? "Unable to load support activity.");
        setOrders(orderData.orders ?? []);
        setVendors(availabilityData.vendors ?? []);
        setDrivers(availabilityData.drivers ?? []);
        setRecords(submissionData.records ?? []);
        setStatus("Overview updated.");
        setLoadError("");
        setHasLoaded(true);
      })
      .catch((error) => { if (active) { const message = error instanceof Error ? error.message : "Unable to load operations overview."; setStatus(message); setLoadError(message); setHasLoaded(true); } });
    return () => { active = false; };
  }, []);

  const activeOrders = orders.filter((order) => !isClosedOrder(order));
  const riskOrders = activeOrders.filter(isRiskOrder);
  const unassignedOrders = activeOrders.filter((order) => order.vendor === "Unassigned" || order.driver === "Unassigned");
  const deliveredOrders = activeOrders.filter((order) => order.workflowStage.key === "delivered");
  const awaitingPayment = deliveredOrders.filter((order) => !paymentReadyForCloseout(order.payment));
  const readyForCloseout = deliveredOrders.filter((order) => paymentReadyForCloseout(order.payment));
  const activeVendors = vendors.filter((vendor) => !/paused|inactive|suspended|tomorrow/i.test(vendor.availabilityStatus));
  const activeDrivers = drivers.filter((driver) => !/paused|inactive|suspended|training|tomorrow/i.test(driver.availabilityStatus));
  const cases = supportCases(records.filter((record) => String(record.data.submissionType ?? "").includes("support-ticket")));
  const openCases = cases.filter((supportCase) => !/resolved|closed/i.test(supportCase.status));
  const urgentCases = openCases.filter((supportCase) => /urgent|high/i.test(supportCase.priority));
  const waitingCases = openCases.filter((supportCase) => /waiting/i.test(supportCase.status));
  const overviewRows = [
    { area: "Orders", state: `${activeOrders.length} active · ${unassignedOrders.length} unassigned`, attention: `${riskOrders.length} need attention`, href: "/admin?view=orders", link: "Review orders" },
    { area: "Vendors", state: `${activeVendors.length} taking work · ${activeVendors.reduce((sum, item) => sum + item.capacityRemaining, 0)} slots`, attention: `${vendors.length - activeVendors.length} paused or unavailable`, href: "/admin?view=people", link: "View partners" },
    { area: "Routes", state: `${activeDrivers.length} active riders · ${activeDrivers.reduce((sum, item) => sum + item.capacityRemaining, 0)} route slots`, attention: `${unassignedOrders.filter((order) => order.driver === "Unassigned").length} awaiting rider`, href: "/admin?view=dispatch", link: "Open dispatch" },
    { area: "Support", state: `${openCases.length} open · ${waitingCases.length} waiting`, attention: `${urgentCases.length} high priority`, href: "/admin?view=cases", link: "Review cases" },
    { area: "Payments", state: `${awaitingPayment.length} delivered awaiting evidence`, attention: `${readyForCloseout.length} ready for closeout`, href: "/admin?view=orders", link: "Review payments" },
  ];
  const priorityOrders = activeOrders.filter((order) => isRiskOrder(order) || order.vendor === "Unassigned" || order.driver === "Unassigned" || automationActionsForOrder(order, "admin", userName).length > 0).sort((left, right) => Number(isRiskOrder(right)) - Number(isRiskOrder(left)) || Number(right.vendor === "Unassigned" || right.driver === "Unassigned") - Number(left.vendor === "Unassigned" || left.driver === "Unassigned") || new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime()).slice(0, 5);

  if (!hasLoaded) return <section className="staffContentSection" aria-busy="true"><LoadingSkeleton label="Loading today’s operations overview" rows={4} variant="metrics" /></section>;
  if (loadError) return <section className="staffContentSection"><div className="staffEmptyState" role="alert"><h2>Operations overview unavailable</h2><p>{loadError} No totals are shown until all overview sources load successfully.</p><button className="button secondary" type="button" onClick={() => void loadOverview()}>Try again</button></div></section>;

  return <>
    <section className="staffContentSection adminOverview" aria-labelledby="operations-by-area"><div className="staffSectionHeader"><div><h2 id="operations-by-area">Operations by area</h2><p>A read-only view across the pilot. Open a section to take action.</p></div><button className="button secondary" type="button" onClick={() => void loadOverview()}>Refresh</button></div>
      <div className="overviewLedger">{overviewRows.map((row) => <article className="overviewRow" key={row.area}><h3>{row.area}</h3><p>{row.state}</p><p className="overviewAttention">{row.attention}</p><Link href={row.href}>{row.link}</Link></article>)}</div><p className="status" role="status" aria-live="polite">{status}</p>
    </section>
    <section className="staffContentSection"><div className="staffSectionHeader"><div><h2>Needs attention</h2><p>The highest-risk active orders, limited to five.</p></div><Link href="/admin?view=orders">View full order queue</Link></div>
      <div className="staffPriorityList">{priorityOrders.length ? priorityOrders.map((order) => <article className={`staffPriorityRow timer-${order.stageTimer.tone}`} key={order.orderId}><div><strong>{order.orderId}</strong><span>{order.customer}</span></div><div><strong>{order.workflowStage.label}</strong><span>{order.nextStep}</span></div><div><strong>{order.stageTimer.label}</strong><span>{order.vendor === "Unassigned" || order.driver === "Unassigned" ? "Assignment incomplete" : order.priority}</span></div><Link href={`/admin?view=orders&order=${encodeURIComponent(order.orderId)}`}>Review order</Link></article>) : <p className="staffEmptyState">No active orders need attention.</p>}</div>
    </section>
    <section className="staffContentSection"><div className="staffSectionHeader"><div><h2>Latest operational changes</h2><p>The five most recent saved records.</p></div><Link href="/admin?view=activity">Open activity</Link></div><div className="staffSimpleList">{records.slice(0, 5).map((record) => <div className="staffSimpleRow" key={record.id}><strong>{activityTypeLabel(activityType(record))}</strong><span>{activitySubject(record)}</span><p>{activityChangeSummary(record)}</p><time>{formatActivityTime(record.createdAt)}</time></div>)}</div></section>
  </>;
}

function SupportTicketDesk({ userName, selectedCaseId = "", basePath, refreshToken = 0 }: { userName: string; selectedCaseId?: string; basePath: string; refreshToken?: number }) {
  const [records, setRecords] = useState<SubmissionRecord[]>([]);
  const [status, setStatus] = useState("Loading support tickets…");
  const [hasLoaded, setHasLoaded] = useState(false);
  const [formStatus, setFormStatus] = useState<Record<string, string>>({});
  const pendingActions = useRef(new Set<string>());
  const [pendingCaseId, setPendingCaseId] = useState("");

  async function loadTickets(showLoading = true) {
    if (showLoading) setStatus("Loading support tickets…");
    try {
      const response = await fetch("/api/submissions");
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setStatus(data.error ?? "Unable to load support tickets.");
        setHasLoaded(true);
        return;
      }
      const tickets = data.records.filter((record: SubmissionRecord) => String(record.data.submissionType ?? "").includes("support-ticket"));
      setRecords(tickets.slice(0, 200));
      setStatus(tickets.length ? "Support ticket desk loaded." : "No support tickets yet.");
      setHasLoaded(true);
    } catch {
      setStatus("Unable to load support tickets.");
      setHasLoaded(true);
    }
  }

  async function action(event: FormEvent<HTMLFormElement>, supportCase: SupportCase) {
    event.preventDefault();
    if (pendingActions.current.has(supportCase.ticketId)) return;
    pendingActions.current.add(supportCase.ticketId);
    setPendingCaseId(supportCase.ticketId);
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.submissionType = "support-ticket-action";
    payload.ticketId = supportCase.ticketId;
    payload.orderId = supportCase.orderId || supportCase.root.id;
    payload.company = String(supportCase.root.data.company || "Bubble Wash Support");
    payload.phone = String(supportCase.root.data.phone || "support-desk");
    payload.name = userName;
    try {
      const data = await postJSON<{ ok: boolean; message: string; id: string }>("/api/submit", payload);
      setFormStatus((current) => ({ ...current, [supportCase.ticketId]: `${data.message} Action: ${data.id}` }));
      form.reset();
      await loadTickets(false);
    } catch (error) {
      setFormStatus((current) => ({ ...current, [supportCase.ticketId]: error instanceof Error ? error.message : "Unable to save ticket action." }));
    } finally {
      pendingActions.current.delete(supportCase.ticketId);
      setPendingCaseId((current) => current === supportCase.ticketId ? "" : current);
    }
  }

  useEffect(() => { loadTickets(); }, [refreshToken]);

  const cases = supportCases(records);
  const selectedCase = selectedCaseId ? cases.find((supportCase) => supportCase.ticketId.toLowerCase() === selectedCaseId.toLowerCase()) : null;
  const caseHref = (ticketId: string) => `${basePath}${basePath.includes("?") ? "&" : "?"}case=${encodeURIComponent(ticketId)}`;

  return (
    <section className="staffContentSection supportDeskSection" aria-busy={!hasLoaded}>
      {selectedCaseId ? selectedCase ? <article className="staffDetailView caseDetail">
        <Link className="staffBackLink" href={basePath}>← Back to case list</Link>
        <header className="staffDetailHeader"><div><span className="staffFieldLabel">{selectedCase.ticketId}</span><h2>{String(selectedCase.root.data.issueType || "Support ticket")}</h2><p>{selectedCase.orderId || "Not linked to an order"}</p></div><div className="staffDetailReference"><span>Status</span><strong>{selectedCase.status}</strong><small>{selectedCase.priority} priority</small></div></header>
        <div className="staffDetailSections">
          <details className="staffDetailDisclosure"><summary><span><strong>Case context</strong><small>{selectedCase.orderId || "Unlinked case"}</small></span></summary><div className="staffDisclosureBody"><dl className="staffDefinitionList"><div><dt>Order</dt><dd>{selectedCase.orderId || "Unlinked case"}</dd></div><div><dt>Raised by</dt><dd>{String(selectedCase.root.data.name || "Team member")}</dd></div><div><dt>Customer/team</dt><dd>{String(selectedCase.root.data.company || "Bubble Wash")}</dd></div><div><dt>Last updated</dt><dd>{formatActivityTime(selectedCase.latest.createdAt)}</dd></div></dl></div></details>
          <details className="staffDetailDisclosure"><summary><span><strong>Case history</strong><small>{selectedCase.events.length} updates</small></span></summary><div className="staffDisclosureBody"><div className="staffTimeline">{[...selectedCase.events].reverse().map((event) => <div key={event.id}><time>{formatActivityTime(event.createdAt)}</time><div><strong>{String(event.data.ticketStatus || event.data.issueType || "Open")}</strong><span>{String(event.data.name || "Staff")}</span><p>{String(event.data.message || "No note supplied.")}</p></div></div>)}</div></div></details>
          {selectedCase.root.data.customerAction ? <CustomerDecisionPanel ticketId={selectedCase.ticketId} action={String(selectedCase.root.data.customerAction)} onSaved={() => loadTickets(false)} /> : null}
          <details className="staffDetailDisclosure staffControlDisclosure"><summary><span><strong>Record next case action</strong><small>{selectedCase.status} · {selectedCase.priority} priority</small></span></summary><div className="staffDisclosureBody"><form className="staffForm" onSubmit={(event) => action(event, selectedCase)}>
            <div className="two"><label>Case status<select name="ticketStatus" defaultValue={selectedCase.status}><option>Open</option><option>In Review</option><option>Assigned</option><option>Waiting on Customer</option><option>Waiting on Vendor</option><option>Waiting on Driver</option><option>Escalated</option><option>Resolved</option><option>Closed</option><option>Reopened</option></select></label><label>Priority<select name="priority" defaultValue={selectedCase.priority}><option>Normal</option><option>High</option><option>Urgent</option></select></label></div>
            <div className="two"><label>Assigned desk<select name="assignedRole" defaultValue={selectedCase.assignedRole}><option>Support</option><option>Admin</option><option>Vendor</option><option>Driver</option></select></label><label>Escalation level<select name="escalationLevel" defaultValue={selectedCase.escalationLevel}><option>Level 0</option><option>Level 1</option><option>Level 2</option><option>Level 3</option></select></label></div>
            <label>Case note<textarea name="message" placeholder="Action, escalation reason, customer impact, or resolution summary" required /></label>
            <button className="button primary" type="submit" disabled={pendingCaseId === selectedCase.ticketId}>{pendingCaseId === selectedCase.ticketId ? "Saving action…" : "Save case action"}</button>
            {formStatus[selectedCase.ticketId] ? <p className={noticeClass(formStatus[selectedCase.ticketId])} role="status">{formStatus[selectedCase.ticketId]}</p> : null}
          </form></div></details>
        </div>
      </article> : hasLoaded ? <div className="staffEmptyState"><h2>Case not found</h2><p>This case is unavailable to this staff role.</p><Link href={basePath}>Back to cases</Link></div> : <LoadingSkeleton label="Loading support case details" rows={4} variant="detail" /> : <>
        <div className="staffSectionHeader"><div><h2>Customer cases</h2><p>Each case appears once. Open it to see history and record an action.</p></div><button className="button secondary" type="button" onClick={() => loadTickets()}>Refresh</button></div>
        <div className="staffCaseList" role="list"><div className="staffCaseListHeader" aria-hidden="true"><span>Case</span><span>Status</span><span>Priority</span><span>Updated</span><span></span></div>
          {!hasLoaded ? <LoadingSkeleton label="Loading support tickets" rows={5} /> : cases.map((supportCase) => <article className="staffCaseRow" key={supportCase.ticketId} role="listitem"><div><strong>{String(supportCase.root.data.issueType || "Support ticket")}</strong><span>{supportCase.ticketId}</span><small>{supportCase.orderId || "Unlinked case"}</small></div><div><strong>{supportCase.status}</strong><span>{String(supportCase.latest.data.message || supportCase.root.data.message || "No note supplied.")}</span></div><strong>{supportCase.priority}</strong><time>{formatActivityTime(supportCase.latest.createdAt)}</time><Link href={caseHref(supportCase.ticketId)}>View case</Link></article>)}
          {hasLoaded && !cases.length ? <p className="staffEmptyState">No customer cases yet.</p> : null}
        </div>
      </>}
      <p className={noticeClass(status)} role="status" aria-live="polite">{status}</p>
    </section>
  );
}

export function AdminWorkspace({ userName, role, initialView = "overview", selectedOrderId, selectedCaseId, selectedActivityId }: WorkspaceProps) {
  const [formStatus, setFormStatus] = useState<Record<string, string>>({});
  const pendingSubmission = useRef(false);
  const [pendingType, setPendingType] = useState("");
  const [casesVersion, setCasesVersion] = useState(0);
  const [rosterVersion, setRosterVersion] = useState(0);
  const [availabilityVersion, setAvailabilityVersion] = useState(0);

  async function submitLead(event: FormEvent<HTMLFormElement>, type: string) {
    event.preventDefault();
    if (pendingSubmission.current) return;
    pendingSubmission.current = true;
    setPendingType(type);
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.submissionType = type;
    try {
      const data = await postJSON<{ ok: boolean; message: string; id: string }>("/api/submit", payload);
      setFormStatus((current) => ({ ...current, [type]: `${data.message} Reference: ${data.id}` }));
      form.reset();
      if (type === "support-ticket") setCasesVersion((current) => current + 1);
      if (type === "staff-onboarding") setRosterVersion((current) => current + 1);
      if (type === "vendor-application" || type === "driver-onboarding") setAvailabilityVersion((current) => current + 1);
    } catch (error) {
      setFormStatus((current) => ({ ...current, [type]: error instanceof Error ? error.message : "Unable to save request." }));
    } finally {
      pendingSubmission.current = false;
      setPendingType((current) => current === type ? "" : current);
    }
  }

  const navigation = [
    { href: "/admin", label: "Overview", view: "overview" },
    { href: "/admin?view=dispatch", label: "Dispatch", view: "dispatch" },
    { href: "/admin?view=orders", label: "Orders", view: "orders" },
    { href: "/admin?view=people", label: "People & onboarding", view: "people" },
    { href: "/admin?view=cases", label: "Cases", view: "cases" },
    { href: "/admin?view=operations", label: "Operations health", view: "operations" },
    { href: "/admin?view=activity", label: "Activity", view: "activity" },
  ];

  return (
    <PortalShell role={role} userName={userName} title="Admin workspace" currentView={initialView} navigation={navigation}>
      {initialView === "overview" ? <AdminOverview userName={userName} /> : null}
      {initialView === "dispatch" ? <AdminDispatchWorkspace /> : null}
      {initialView === "orders" ? <SharedOrderBoard role="admin" userName={userName} selectedOrderId={selectedOrderId} basePath="/admin?view=orders" /> : null}
      {initialView === "people" ? <><AvailabilityBoard role="admin" refreshToken={availabilityVersion} /><StaffAccessRoster refreshToken={rosterVersion} /><StaffAccountPanel /><AdminOnboardingCenter onSubmit={submitLead} status={formStatus} pendingType={pendingType} /></> : null}
      {initialView === "cases" ? <><section className="staffContentSection"><details className="staffRosterEditor staffStandaloneEditor"><summary><span><strong>Open a new case</strong><small>Use when an existing case does not cover the issue</small></span><b>Open form</b></summary><SupportTicketForm userName={userName} role="admin" onSubmit={submitLead} status={formStatus["support-ticket"]} pending={pendingType === "support-ticket"} /></details></section><SupportTicketDesk userName={userName} selectedCaseId={selectedCaseId} basePath="/admin?view=cases" refreshToken={casesVersion} /></> : null}
      {initialView === "operations" ? <AdminOperationsHealth /> : null}
      {initialView === "activity" ? <RecentActivity initialSelectedId={selectedActivityId} basePath="/admin?view=activity" /> : null}
    </PortalShell>
  );
}

type OperationsMetrics = {
  submissions: number;
  earlyAccess: { total: number; active: number };
  privacyRequests: { total: number; open: number };
  notifications: { pending: number; failed: number; sent: number };
};

type PrivacyOperationsRequest = {
  id: string; requestType: string; name: string; contact: string; orderId: string; status: string; createdAt: string;
};

function AdminOperationsHealth() {
  const [metrics, setMetrics] = useState<OperationsMetrics | null>(null);
  const [privacyRequests, setPrivacyRequests] = useState<PrivacyOperationsRequest[]>([]);
  const [status, setStatus] = useState("Loading operational controls…");
  const [hasLoaded, setHasLoaded] = useState(false);

  async function load() {
    try {
      const response = await fetch("/api/admin/operations", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Unable to load operations health.");
      setMetrics(data.metrics);
      setPrivacyRequests(data.privacyRequests);
      setStatus("Operational data loaded.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to load operations health.");
    } finally {
      setHasLoaded(true);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function changePrivacyStatus(id: string, nextStatus: string) {
    setStatus(`Updating ${id}…`);
    try {
      await postJSON("/api/admin/operations", { id, status: nextStatus });
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to update the privacy request.");
    }
  }

  return <section className="staffContentSection" aria-busy={!hasLoaded}><div className="staffSectionHeader"><div><h2>Operations health and privacy queue</h2><p>Delivery retries and retention run through the protected maintenance worker. Privacy cases require an explicit review status.</p></div><button className="button secondary" type="button" onClick={() => void load()}>Refresh</button></div>{!hasLoaded ? <LoadingSkeleton label="Loading operations health metrics" rows={4} variant="metrics" /> : metrics ? <div className="overviewGrid"><article><span className="staffFieldLabel">Order records</span><strong>{metrics.submissions}</strong><small>SQLite submission events</small></article><article><span className="staffFieldLabel">Early access</span><strong>{metrics.earlyAccess.active}</strong><small>{metrics.earlyAccess.total} total consent records</small></article><article><span className="staffFieldLabel">Privacy queue</span><strong>{metrics.privacyRequests.open}</strong><small>{metrics.privacyRequests.total} total requests</small></article><article><span className="staffFieldLabel">Notification outbox</span><strong>{metrics.notifications.pending + metrics.notifications.failed}</strong><small>{metrics.notifications.pending} pending · {metrics.notifications.failed} failed · {metrics.notifications.sent} sent</small></article></div> : null}<p className={noticeClass(status)} role="status">{status}</p><div className="staffSectionHeader"><div><h3>Privacy and data-rights requests</h3><p>Verify identity before disclosure, correction, or deletion. Mark completion only after the requested work is recorded.</p></div></div><div className="staffSimpleList">{!hasLoaded ? <LoadingSkeleton label="Loading privacy requests" rows={4} /> : privacyRequests.length ? privacyRequests.map((request) => <article className="privacyOpsRow" key={request.id}><div><strong>{request.id}</strong><span>{request.requestType.replaceAll("_", " ")}</span></div><div><strong>{request.name}</strong><span>{request.contact}</span><small>{request.orderId || "No order supplied"}</small></div><div><strong>{request.status.replaceAll("_", " ")}</strong><time>{formatActivityTime(request.createdAt)}</time></div><div className="tableActionRow"><button className="button secondary" type="button" onClick={() => void changePrivacyStatus(request.id, "identity_review")}>Identity review</button><button className="button secondary" type="button" onClick={() => void changePrivacyStatus(request.id, "completed")}>Complete</button><button className="button secondary" type="button" onClick={() => void changePrivacyStatus(request.id, "declined")}>Decline</button></div></article>) : <p className="staffEmptyState">No privacy requests are waiting.</p>}</div></section>;
}

export function VendorWorkspace({ userName, role, initialView = "jobs", selectedOrderId, selectedActivityId }: WorkspaceProps) {
  const [formStatus, setFormStatus] = useState<Record<string, string>>({});
  const pendingSubmission = useRef(false);
  const [pendingType, setPendingType] = useState("");
  const [availabilityVersion, setAvailabilityVersion] = useState(0);

  async function submitLead(event: FormEvent<HTMLFormElement>, type: string) {
    event.preventDefault();
    if (pendingSubmission.current) return;
    pendingSubmission.current = true;
    setPendingType(type);
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.submissionType = type;
    try {
      const data = await postJSON<{ ok: boolean; message: string; id: string }>("/api/submit", payload);
      setFormStatus((current) => ({ ...current, [type]: `${data.message} Reference: ${data.id}` }));
      form.reset();
      if (type === "vendor-application") setAvailabilityVersion((current) => current + 1);
    } catch (error) {
      setFormStatus((current) => ({ ...current, [type]: error instanceof Error ? error.message : "Unable to save request." }));
    } finally {
      pendingSubmission.current = false;
      setPendingType((current) => current === type ? "" : current);
    }
  }

  const navigation = [
    { href: "/vendors", label: "Jobs", view: "jobs" },
    { href: "/vendors?view=capacity", label: "Capacity", view: "capacity" },
    { href: "/vendors?view=activity", label: "Activity", view: "activity" },
  ];

  return (
    <PortalShell role={role} pageRole="vendor" userName={userName} title="Vendor workspace" currentView={initialView} navigation={navigation}>
      {initialView === "jobs" ? <><SharedOrderBoard role="vendor" userName={userName} selectedOrderId={selectedOrderId} basePath="/vendors?view=jobs" />{selectedOrderId ? <section className="staffContentSection"><details className="staffRosterEditor staffStandaloneEditor"><summary><span><strong>Report a production exception</strong><small>Open a case when the verified job actions do not cover it</small></span><b>Open form</b></summary><SupportTicketForm userName={userName} role="vendor" onSubmit={submitLead} status={formStatus["support-ticket"]} pending={pendingType === "support-ticket"} /></details></section> : null}</> : null}
      {initialView === "capacity" ? <><AvailabilityBoard role="vendor" mode="vendors" refreshToken={availabilityVersion} /><section className="staffContentSection"><details className="staffRosterEditor staffStandaloneEditor"><summary><span><strong>Update today&apos;s capacity</strong><small>The signed-in vendor is applied automatically</small></span><b>Open form</b></summary><form className="staffForm staffNarrowForm" onSubmit={(event) => submitLead(event, "vendor-application")}><div className="two"><label>Service areas<input name="area" placeholder="Osu, Labone" required /></label><label>Order slots remaining<input name="capacity" type="number" min="0" inputMode="numeric" required /></label></div><div className="two"><label>Availability<select name="availability"><option>Available today</option><option>Available tomorrow</option><option>Limited capacity</option><option>Paused today</option></select></label><label>Available service<select name="services"><option>Wash + fold</option><option>Wash + iron + fold</option><option>Ironing only</option><option>Express capable</option><option>Bulk commercial</option></select></label></div><label>Capacity note<textarea name="message" placeholder="Turnaround, machine, or service restrictions" /></label><button className="button primary" type="submit" disabled={pendingType === "vendor-application"}>{pendingType === "vendor-application" ? "Updating capacity…" : "Update capacity"}</button>{formStatus["vendor-application"] ? <p className={noticeClass(formStatus["vendor-application"])} role="status">{formStatus["vendor-application"]}</p> : null}</form></details></section></> : null}
      {initialView === "activity" ? <RecentActivity filter="vendor" initialSelectedId={selectedActivityId} basePath="/vendors?view=activity" /> : null}
    </PortalShell>
  );
}

export function DriverWorkspace({ userName, role, initialView = "route", selectedOrderId, selectedActivityId }: WorkspaceProps) {
  const [formStatus, setFormStatus] = useState<Record<string, string>>({});
  const pendingSubmission = useRef(false);
  const [pendingType, setPendingType] = useState("");

  async function submitLead(event: FormEvent<HTMLFormElement>, type: string) {
    event.preventDefault();
    if (pendingSubmission.current) return;
    pendingSubmission.current = true;
    setPendingType(type);
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.submissionType = type;
    try {
      const data = await postJSON<{ ok: boolean; message: string; id: string }>("/api/submit", payload);
      setFormStatus((current) => ({ ...current, [type]: `${data.message} Reference: ${data.id}` }));
      form.reset();
    } catch (error) {
      setFormStatus((current) => ({ ...current, [type]: error instanceof Error ? error.message : "Unable to save route update." }));
    } finally {
      pendingSubmission.current = false;
      setPendingType((current) => current === type ? "" : current);
    }
  }

  const navigation = [
    { href: "/drivers", label: "Today’s route", view: "route" },
    { href: "/drivers?view=activity", label: "Activity", view: "activity" },
  ];

  return (
    <PortalShell role={role} pageRole="driver" userName={userName} title="Driver route board" currentView={initialView} navigation={navigation}>
      {initialView === "route" ? <><SharedOrderBoard role="driver" userName={userName} selectedOrderId={selectedOrderId} basePath="/drivers?view=route" />{selectedOrderId ? <section className="staffContentSection"><details className="staffRosterEditor staffStandaloneEditor"><summary><span><strong>Report a route exception</strong><small>Use when the delay or handoff actions do not cover it</small></span><b>Open form</b></summary><SupportTicketForm userName={userName} role="driver" onSubmit={submitLead} status={formStatus["support-ticket"]} pending={pendingType === "support-ticket"} /></details></section> : null}</> : null}
      {initialView === "activity" ? <RecentActivity filter="driver-route-log" initialSelectedId={selectedActivityId} basePath="/drivers?view=activity" /> : null}
    </PortalShell>
  );
}

export function SupportWorkspace({ userName, role, initialView = "cases", selectedOrderId, selectedCaseId, selectedActivityId }: WorkspaceProps) {
  const [formStatus, setFormStatus] = useState<Record<string, string>>({});
  const pendingSubmission = useRef(false);
  const [pendingType, setPendingType] = useState("");
  const [casesVersion, setCasesVersion] = useState(0);

  async function submitLead(event: FormEvent<HTMLFormElement>, type: string) {
    event.preventDefault();
    if (pendingSubmission.current) return;
    pendingSubmission.current = true;
    setPendingType(type);
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.submissionType = type;
    try {
      const data = await postJSON<{ ok: boolean; message: string; id: string }>("/api/submit", payload);
      setFormStatus((current) => ({ ...current, [type]: `${data.message} Reference: ${data.id}` }));
      form.reset();
      if (type === "support-ticket") setCasesVersion((current) => current + 1);
    } catch (error) {
      setFormStatus((current) => ({ ...current, [type]: error instanceof Error ? error.message : "Unable to save request." }));
    } finally {
      pendingSubmission.current = false;
      setPendingType((current) => current === type ? "" : current);
    }
  }

  const navigation = [
    { href: "/support", label: "Cases", view: "cases" },
    { href: "/support?view=orders", label: "Orders", view: "orders" },
    { href: "/support?view=activity", label: "Activity", view: "activity" },
  ];

  return (
    <PortalShell role={role} pageRole="support" userName={userName} title="Support workspace" currentView={initialView} navigation={navigation}>
      {initialView === "cases" ? <><section className="staffContentSection"><details className="staffRosterEditor staffStandaloneEditor"><summary><span><strong>Open a new case</strong><small>Use when an existing case does not cover the issue</small></span><b>Open form</b></summary><SupportTicketForm userName={userName} role="support" onSubmit={submitLead} status={formStatus["support-ticket"]} pending={pendingType === "support-ticket"} /></details></section><SupportTicketDesk userName={userName} selectedCaseId={selectedCaseId} basePath="/support?view=cases" refreshToken={casesVersion} /></> : null}
      {initialView === "orders" ? <SharedOrderBoard role="support" userName={userName} selectedOrderId={selectedOrderId} basePath="/support?view=orders" /> : null}
      {initialView === "activity" ? <RecentActivity filter="support" initialSelectedId={selectedActivityId} basePath="/support?view=activity" /> : null}
    </PortalShell>
  );
}
