"use client";

import Link from "next/link";
import Image from "next/image";
import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { StaffRole } from "@/lib/auth";
import { automationActionsForOrder } from "@/lib/order-workflow";

const supportTypes = ["Pickup delay", "Payment issue", "Missing item", "Quality complaint", "Vendor escalation", "General question"];

type PortalShellProps = {
  title: string;
  role: StaffRole;
  pageRole?: StaffRole;
  userName: string;
  children: ReactNode;
};


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
  vendor: string;
  driver: string;
  routeWindow: string;
  locationNote: string;
  status: string;
  workflowStage: { key: string; label: string; targetMinutes: number; customerNext: string; staffNext: string };
  payment: string;
  priority: string;
  nextStep: string;
  eventCount: number;
  lastEventType: string;
  route: { googleMapsUrl: string; directionsUrl: string; zoneLabel: string; zoneNote: string };
  stageTimer: { label: string; tone: "ok" | "due" | "breached" | "paused"; elapsedMinutes: number; targetMinutes: number };
  timeline: Array<{ id: string; createdAt: string; type: string; status: string; actor: string; note: string }>;
};

type SubmitHandler = (event: FormEvent<HTMLFormElement>, type: string) => Promise<void>;

type VendorAvailabilityRow = { vendorId: string; vendorName: string; serviceZones: string[]; serviceTypes: string[]; capacityRemaining: number; availabilityStatus: string; updatedAt: string; notes?: string };
type DriverAvailabilityRow = { driverId: string; driverName: string; serviceZones: string[]; vehicle?: string; capacityRemaining: number; availabilityStatus: string; updatedAt: string; notes?: string };
type VendorDeclineRow = { id: string; orderId: string; vendorName: string; reason: string; declinedBy: string; createdAt: string };

type AutomationAction = ReturnType<typeof automationActionsForOrder>[number];

type QueueStats = { focusLabel: string; focusCount: number; automationCount: number; riskCount: number; capacityLabel: string };
type PortalLink = { href: string; label: string; icon: "admin" | "vendor" | "routes" | "support" };
type QueueView = "action" | "active" | "all";
type SupportCase = {
  ticketId: string;
  orderId: string;
  root: SubmissionRecord;
  latest: SubmissionRecord;
  events: SubmissionRecord[];
  status: string;
  priority: string;
};

function noticeClass(message: string) {
  return `status ${/(unable|failed|invalid|missing|required|not allowed|not available|too many)/i.test(message) ? "error" : "success"}`;
}

function rolePromise(role: StaffRole) {
  if (role === "admin") return { eyebrow: "Operations desk", title: "Admin queue", subtitle: "Review active jobs, reassign work, and resolve exceptions before the customer has to chase." };
  if (role === "vendor") return { eyebrow: "Vendor workspace", title: "Washing queue", subtitle: "Start each load, mark it ready, or flag a problem without opening separate partner tools first." };
  if (role === "driver") return { eyebrow: "Driver workspace", title: "Route handoffs", subtitle: "See the next stop, confirm arrival, and keep proof attached to the same order trail." };
  return { eyebrow: "Support Desk", title: "Tickets and follow-up", subtitle: "Track at-risk orders, open cases, and customer-facing resolutions from one queue." };
}

function isRiskOrder(order: OrderSummary) {
  return order.workflowStage.key === "exception" || order.stageTimer.tone === "breached" || order.priority === "Urgent";
}

function isClosedOrder(order: OrderSummary) {
  return order.workflowStage.key === "closed";
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
  if (role === "admin") return isRiskOrder(order) || actions.some((action) => action.key.includes("assign") || action.key.includes("schedule"));
  if (role === "vendor") return actions.some((action) => action.key.includes("vendor"));
  if (role === "driver") return actions.some((action) => action.key.includes("driver"));
  return isRiskOrder(order) || actions.some((action) => action.key.includes("support"));
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

function StaffNavIcon({ type }: { type: PortalLink["icon"] | "exit" }) {
  if (type === "admin") {
    return <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="16" rx="2.5" /><circle cx="12" cy="13" r="4" /><path d="M8 7h3" /><path d="M15.5 7h.1" /></svg>;
  }
  if (type === "vendor") {
    return <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="7" rx="3.5" /><path d="M8 13.5h7" /><circle cx="8" cy="7" r="1.2" /><circle cx="12" cy="5" r="1" /><circle cx="16" cy="7.2" r="1.1" /></svg>;
  }
  if (type === "routes") {
    return <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="7" cy="17" r="2" /><circle cx="17" cy="17" r="2" /><path d="M7 17h4l2.5-5H17l-2-4h-3" /><path d="M10 12H7.5" /><path d="M14 8h3" /><path d="M5 14.5h2" /></svg>;
  }
  if (type === "support") {
    return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12a7 7 0 0 1 14 0" /><path d="M5 12v3a2 2 0 0 0 2 2h1v-5H5Z" /><path d="M19 12v3a2 2 0 0 1-2 2h-1v-5h3Z" /><path d="M9 19h4" /></svg>;
  }
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 5H5v14h4" /><path d="M12 12h8" /><path d="m17 8 4 4-4 4" /></svg>;
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
  return activityValue(record, "company", "name", "orderId", "ticketId") || "Bubble Wash request";
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
        ["Vendor", activityValue(record, "vendorName", "vendor")],
        ["Driver", activityValue(record, "driverName", "driver")],
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

function AvailabilityBoard({ role }: { role: StaffRole }) {
  const [vendors, setVendors] = useState<VendorAvailabilityRow[]>([]);
  const [drivers, setDrivers] = useState<DriverAvailabilityRow[]>([]);
  const [declines, setDeclines] = useState<VendorDeclineRow[]>([]);
  const [status, setStatus] = useState("Loading availability table…");

  async function loadAvailability(showLoading = true) {
    if (showLoading) setStatus("Loading availability table…");
    const response = await fetch("/api/availability");
    const data = await response.json();
    if (!response.ok || !data.ok) {
      setStatus(data.error ?? "Unable to load availability table.");
      return;
    }
    setVendors(data.vendors ?? []);
    setDrivers(data.drivers ?? []);
    setDeclines(data.declines ?? []);
    setStatus("Availability table loaded.");
  }

  useEffect(() => {
    let active = true;
    fetch("/api/availability")
      .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
      .then(({ ok, data }) => {
        if (!active) return;
        if (!ok || !data.ok) {
          setStatus(data.error ?? "Unable to load availability table.");
          return;
        }
        setVendors(data.vendors ?? []);
        setDrivers(data.drivers ?? []);
        setDeclines(data.declines ?? []);
        setStatus("Availability table loaded.");
      })
      .catch(() => {
        if (active) setStatus("Unable to load availability table.");
      });
    return () => { active = false; };
  }, []);

  return (
    <section className="section portalSection availabilitySection">
      <div className="activityHeader"><div><p className="eyebrow">Capacity summary</p><h2>Availability and coverage</h2></div><button className="button secondary" type="button" onClick={() => loadAvailability()}>Refresh summary</button></div>
      <div className="opsTableWrap">
        <table className="opsTable availabilityTable">
          <thead>
            <tr><th scope="col">Desk</th><th scope="col">Status</th><th scope="col">Capacity</th><th scope="col">Coverage</th><th scope="col">Note</th></tr>
          </thead>
          <tbody>
            {vendors.slice(0, 6).map((vendor) => <tr key={vendor.vendorId}><td data-label="Desk"><strong>{vendor.vendorName}</strong><small>Vendor</small></td><td data-label="Status">{vendor.availabilityStatus}</td><td data-label="Capacity">{vendor.capacityRemaining}</td><td data-label="Coverage">{vendor.serviceZones.join(", ") || "Any"}<small>{vendor.serviceTypes.join(", ") || "Any service"}</small></td><td data-label="Note">{vendor.notes || "No vendor note."}</td></tr>)}
            {(role === "admin" || role === "driver") && drivers.slice(0, 6).map((driver) => <tr key={driver.driverId}><td data-label="Desk"><strong>{driver.driverName}</strong><small>Rider</small></td><td data-label="Status">{driver.availabilityStatus}</td><td data-label="Capacity">{driver.capacityRemaining}</td><td data-label="Coverage">{driver.serviceZones.join(", ") || "Any"}<small>{driver.vehicle || "Vehicle not set"}</small></td><td data-label="Note">{driver.notes || "No driver note."}</td></tr>)}
            {!vendors.length && !(role === "admin" || role === "driver") ? <tr><td colSpan={5}>No capacity rows yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
      {role === "admin" && declines.length > 0 && <div className="opsTableWrap declineTableWrap"><table className="opsTable"><caption>Recent vendor declines</caption><thead><tr><th scope="col">Order</th><th scope="col">Vendor</th><th scope="col">Reason</th><th scope="col">Saved</th></tr></thead><tbody>{declines.slice(0, 4).map((decline) => <tr key={decline.id}><td data-label="Order"><strong>{decline.orderId}</strong><small>By {decline.declinedBy}</small></td><td data-label="Vendor">{decline.vendorName}</td><td data-label="Reason">{decline.reason}</td><td data-label="Saved">{formatActivityTime(decline.createdAt)}</td></tr>)}</tbody></table></div>}
      <p className="status">{status}</p>
    </section>
  );
}

function RecentActivity({ filter }: { filter?: string }) {
  const [records, setRecords] = useState<SubmissionRecord[]>([]);
  const [status, setStatus] = useState("Loading recent activity…");
  const [isOpen, setIsOpen] = useState(true);
  const [category, setCategory] = useState<ActivityCategory>("all");
  const [scope, setScope] = useState<ActivityScope>("active");
  const [windowMode, setWindowMode] = useState<ActivityWindow>("20");
  const [sortKey, setSortKey] = useState<ActivitySortKey>("saved");
  const [sortDirection, setSortDirection] = useState<ActivitySortDirection>("desc");
  const [selectedId, setSelectedId] = useState("");
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
      if (newIds.length && !showLoading) {
        setStatus(`${newIds.length} new update${newIds.length === 1 ? "" : "s"} just landed.`);
        return;
      }
      setStatus(nextRecords.length ? "Recent activity loaded." : "No matching activity yet.");
    } catch {
      setStatus("Unable to load activity.");
    }
  }

  useEffect(() => {
    let active = true;

    async function refresh(showLoading = true) {
      if (!active) return;
      if (showLoading) setStatus("Loading recent activity…");
      try {
        const response = await fetch("/api/submissions");
        const data = await response.json();
        if (!active) return;
        if (!response.ok || !data.ok) {
          setStatus(data.error ?? "Unable to load activity.");
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
        if (newIds.length && !showLoading) {
          setStatus(`${newIds.length} new update${newIds.length === 1 ? "" : "s"} just landed.`);
          return;
        }
        setStatus(nextRecords.length ? "Recent activity loaded." : "No matching activity yet.");
      } catch {
        if (active) setStatus("Unable to load activity.");
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

  const selectedRecord = visibleRecords.find((record) => record.id === selectedId) ?? visibleRecords[0] ?? null;
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
    <section className="section activitySection">
      <details className="activityGroup" open={isOpen} onToggle={(event) => setIsOpen(event.currentTarget.open)}>
        <summary>
          <div>
            <p className="eyebrow">Recent activity</p>
            <h2>Latest saved updates</h2>
            <small>{visibleRecords.length ? `${visibleRecords.length} saved updates in this view` : "No saved updates yet"}</small>
          </div>
          <div className="activitySummaryMeta">
            <span className="activityCountPill">{visibleRecords.length} updates</span>
            <em>{isOpen ? "Minimize" : "Expand"}</em>
          </div>
        </summary>
        <div className="activityGroupBody">
          <div className="activityUtilityBar">
            <div className="activityChipRow" aria-label="Quick activity filters">
              {([
                ["all", "All"],
                ["orders", "Orders"],
                ["support", "Support"],
                ["onboarding", "Onboarding"],
                ["payments", "Payments"],
                ["ops", "Ops"],
              ] as Array<[ActivityCategory, string]>).map(([key, label]) => <button className={`activityChip ${category === key ? "active" : ""}`} key={key} onClick={() => setCategory(key)} type="button">{label}<span>{categoryCounts[key]}</span></button>)}
            </div>
            <div className="activityControlGroup">
              <div className="activitySegmented" aria-label="Retention scope">
                {([
                  ["active", "Active"],
                  ["archived", "Archived"],
                  ["all", "All"],
                ] as Array<[ActivityScope, string]>).map(([key, label]) => <button className={scope === key ? "active" : ""} key={key} onClick={() => setScope(key)} type="button">{label}</button>)}
              </div>
              <div className="activitySegmented" aria-label="Retention window">
                {([
                  ["20", "Last 20"],
                  ["50", "Last 50"],
                  ["today", "Today"],
                ] as Array<[ActivityWindow, string]>).map(([key, label]) => <button className={windowMode === key ? "active" : ""} key={key} onClick={() => setWindowMode(key)} type="button">{label}</button>)}
              </div>
            </div>
          </div>

          <div className="activityGroupActions">
            <div className="activityLiveMeta">
              <strong>Auto-refresh</strong>
              <span>Every 30s{lastUpdatedAt ? ` · Last sync ${formatMetricTime(lastUpdatedAt)}` : ""}</span>
            </div>
            <div className="activityActionButtons">
              <button className="button secondary" type="button" onClick={exportVisibleCsv}>Export CSV</button>
              <button className="button secondary" type="button" onClick={() => void loadRecords()}>Refresh</button>
            </div>
          </div>

          <div className="activityWorkbench">
            <div className="activityTableWrap">
              <table className="activityTable">
                <thead>
                  <tr>
                    <th scope="col"><button className="activitySortButton" onClick={() => toggleSort("saved")} type="button">Reference</button></th>
                    <th scope="col"><button className="activitySortButton" onClick={() => toggleSort("type")} type="button">Type</button></th>
                    <th scope="col"><button className="activitySortButton" onClick={() => toggleSort("subject")} type="button">Subject</button></th>
                    <th scope="col">What changed</th>
                    <th scope="col"><button className="activitySortButton" onClick={() => toggleSort("saved")} type="button">Saved</button></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRecords.length ? visibleRecords.map((record) => <tr className={`${selectedId === record.id ? "is-selected" : ""} ${freshIds.includes(record.id) ? "is-new" : ""}`} key={record.id}>
                    <td data-label="Reference"><button className="activityRowButton" type="button" aria-pressed={selectedId === record.id} onClick={() => setSelectedId(record.id)}><strong>{record.id}</strong><span>View details</span></button></td>
                    <td data-label="Type">{activityTypeLabel(activityType(record))}</td>
                    <td data-label="Subject">{activitySubject(record)}</td>
                    <td data-label="What changed">{changeSummaries.get(record.id)}</td>
                    <td data-label="Saved">{formatActivityTime(record.createdAt)}</td>
                  </tr>) : <tr><td className="activityEmptyState" colSpan={5}>No matching activity yet.</td></tr>}
                </tbody>
              </table>
            </div>

            <aside className="activityDetailPanel" aria-live="polite">
              {selectedRecord ? <>
                <div className="activityDetailHeader">
                  <p className="eyebrow">Update details</p>
                  <h3>{activitySubject(selectedRecord)}</h3>
                  <span>{activityTypeLabel(activityType(selectedRecord))}</span>
                </div>
                <div className="activityDetailCard">
                  <strong>{changeSummaries.get(selectedRecord.id)}</strong>
                  <small>Saved {formatActivityTime(selectedRecord.createdAt)} · Ref {selectedRecord.id}</small>
                </div>
                <div className="activityDetailActions">
                  <button className="activityQuietButton" onClick={() => void copyValue("Reference", selectedRecord.id)} type="button">Copy ref</button>
                  {activityValue(selectedRecord, "orderId") ? <button className="activityQuietButton" onClick={() => void copyValue("Order ID", activityValue(selectedRecord, "orderId"))} type="button">Copy order</button> : null}
                  {activityValue(selectedRecord, "phone") ? <button className="activityQuietButton" onClick={() => void copyValue("Phone", activityValue(selectedRecord, "phone"))} type="button">Copy phone</button> : null}
                  {activityValue(selectedRecord, "email") ? <button className="activityQuietButton" onClick={() => void copyValue("Email", activityValue(selectedRecord, "email"))} type="button">Copy email</button> : null}
                  <button className="activityQuietButton" onClick={() => filterToSubject(selectedRecord)} type="button">Show similar</button>
                  <button className="activityQuietButton" onClick={() => toggleSort("saved")} type="button">Newest first</button>
                </div>
                {copyStatus ? <p className="activityCopyStatus" role="status">{copyStatus}</p> : null}
                <div className="activityDetailSections">
                  {selectedSections.map((section) => <section className="activityDetailSection" key={section.title}>
                    <header>
                      <h4>{section.title}</h4>
                    </header>
                    <dl className="activityDetailList">
                      {section.entries.map(([key, value]) => <div key={`${section.title}-${key}`}><dt>{key}</dt><dd>{value}</dd></div>)}
                    </dl>
                  </section>)}
                </div>
              </> : <div className="activityDetailEmpty"><strong>Select an update</strong><p>Click any row to inspect the saved payload without leaving the queue view.</p></div>}
            </aside>
          </div>
        </div>
      </details>
      <p className="status">{status}</p>
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
        {actions.length ? actions.map((action, index) => <button className={`button ${index === 0 ? "primary" : "secondary"}`} disabled={Boolean(pendingLabel)} key={action.label} onClick={() => action.key === "vendor-decline-job" ? setDeclineOpen(true) : ["admin-schedule-pickup", "support-log-customer-contact", "admin-confirm-bank-transfer", "admin-approve-invoice", "vendor-log-intake", "vendor-mark-ready", "driver-mark-picked-up", "driver-drop-at-vendor", "driver-mark-delivered", "driver-report-delay"].includes(action.key) ? setStructuredAction(action.key) : void run(action)} type="button">{pendingLabel === action.label ? "Working…" : action.label}</button>) : <span className="status">Waiting</span>}
      </div>
      {declineOpen ? <form className="declineReasonForm" onSubmit={(event) => { event.preventDefault(); const decline = actions.find((action) => action.key === "vendor-decline-job"); if (decline && declineReason.trim()) void run(decline, { reason: declineReason.trim() }); }}><label>Reason for admin reassignment<textarea value={declineReason} onChange={(event) => setDeclineReason(event.target.value)} maxLength={300} placeholder="Capacity, machine issue, service mismatch, or timing conflict" required /></label><div className="tableActionRow"><button className="button primary" type="submit" disabled={!declineReason.trim() || Boolean(pendingLabel)}>Confirm decline</button><button className="button secondary" type="button" onClick={() => { setDeclineOpen(false); setDeclineReason(""); }}>Cancel</button></div></form> : null}
      {structuredAction === "admin-schedule-pickup" ? <form className="structuredActionForm" onSubmit={(event) => submitStructured(event, structuredAction)}><label>Confirmed pickup window<input name="confirmedPickupWindow" placeholder="Tuesday, 10:00–12:00" maxLength={120} required /></label><label>Scheduling note<textarea name="operatorNote" placeholder="Who confirmed the window and any access or collection instructions" maxLength={600} required /></label><div className="tableActionRow"><button className="button primary" type="submit" disabled={Boolean(pendingLabel)}>Save pickup window</button><button className="button secondary" type="button" onClick={() => setStructuredAction("")}>Cancel</button></div></form> : null}
      {structuredAction === "support-log-customer-contact" ? <form className="structuredActionForm" onSubmit={(event) => submitStructured(event, structuredAction)}><div className="two"><label>Contact channel<select name="contactChannel" required><option>Phone call</option><option>Email</option></select></label><label>Outcome<select name="contactOutcome" required><option>Reached customer</option><option>No answer</option><option>Message left</option><option>Email sent</option><option>Follow-up required</option></select></label></div><label>Next follow-up<input name="nextFollowUpAt" type="datetime-local" required /></label><label>Operator note<textarea name="operatorNote" placeholder="What was discussed, promised, or left unresolved" maxLength={600} required /></label><div className="tableActionRow"><button className="button primary" type="submit" disabled={Boolean(pendingLabel)}>Save contact log</button><button className="button secondary" type="button" onClick={() => setStructuredAction("")}>Cancel</button></div></form> : null}
      {["admin-confirm-bank-transfer", "admin-approve-invoice"].includes(structuredAction) ? <form className="structuredActionForm" onSubmit={(event) => submitStructured(event, structuredAction)}><div className="two"><label>{structuredAction === "admin-approve-invoice" ? "Invoice number" : "Transfer reference"}<input name="paymentReference" maxLength={120} required /></label><label>Amount (GHS)<input name="paymentAmount" type="number" min="0.01" max="250000" step="0.01" inputMode="decimal" required /></label></div><label>{structuredAction === "admin-approve-invoice" ? "Approval date" : "Received date"}<input name="paymentReceivedAt" type="date" required /></label><label>Reconciliation note<textarea name="operatorNote" placeholder="Account checked, approver, payer name, or exception reviewed" maxLength={600} required /></label><div className="tableActionRow"><button className="button primary" type="submit" disabled={Boolean(pendingLabel)}>{structuredAction === "admin-approve-invoice" ? "Save invoice approval" : "Confirm bank transfer"}</button><button className="button secondary" type="button" onClick={() => setStructuredAction("")}>Cancel</button></div></form> : null}
      {structuredAction === "vendor-log-intake" ? <form className="structuredActionForm" onSubmit={(event) => submitStructured(event, structuredAction)}><div className="two"><label>Bag tag<input name="bagTag" defaultValue={`${order.orderId}-BAG`} maxLength={120} required /></label><label>Bag/item count<input name="intakeBagCount" inputMode="numeric" maxLength={40} required /></label></div><div className="two"><label>Received weight (kg, optional)<input name="receivedWeightKg" type="number" min="0.01" max="10000" step="0.01" inputMode="decimal" /></label><label>Intake condition<select name="intakeCondition" required><option>Count and condition matched</option><option>Stain or special care flagged</option><option>Count mismatch</option><option>Damage risk flagged</option></select></label></div><label>Intake note<textarea name="operatorNote" placeholder="Count check, visible condition, special care, or discrepancy" maxLength={600} required /></label><div className="tableActionRow"><button className="button primary" type="submit" disabled={Boolean(pendingLabel)}>Confirm intake</button><button className="button secondary" type="button" onClick={() => setStructuredAction("")}>Cancel</button></div></form> : null}
      {structuredAction === "vendor-mark-ready" ? <form className="structuredActionForm" onSubmit={(event) => submitStructured(event, structuredAction)}><div className="two"><label>Ready bag/item count<input name="readyBagCount" inputMode="numeric" maxLength={40} required /></label><label>Quality check<select name="qualityCheck" required><option>Count, finish, and packaging checked</option><option>Ready with noted exception</option></select></label></div><label>Dispatch note<textarea name="operatorNote" placeholder="Packaging, storage point, collection instructions, or exception" maxLength={600} required /></label><div className="tableActionRow"><button className="button primary" type="submit" disabled={Boolean(pendingLabel)}>Mark ready</button><button className="button secondary" type="button" onClick={() => setStructuredAction("")}>Cancel</button></div></form> : null}
      {structuredAction === "driver-mark-picked-up" ? <form className="structuredActionForm" onSubmit={(event) => submitStructured(event, structuredAction)}><label>Collected bag/item count<input name="pickupBagCount" inputMode="numeric" maxLength={40} required /></label><label>Customer handoff note<textarea name="operatorNote" placeholder="Who released the order, collection point, and any count or access exception" maxLength={600} required /></label><div className="tableActionRow"><button className="button primary" type="submit" disabled={Boolean(pendingLabel)}>Confirm pickup</button><button className="button secondary" type="button" onClick={() => setStructuredAction("")}>Cancel</button></div></form> : null}
      {structuredAction === "driver-drop-at-vendor" ? <form className="structuredActionForm" onSubmit={(event) => submitStructured(event, structuredAction)}><div className="two"><label>Vendor recipient<input name="vendorRecipient" maxLength={160} required /></label><label>Handed-over bag/item count<input name="handoffBagCount" inputMode="numeric" maxLength={40} required /></label></div><label>Vendor handoff note<textarea name="operatorNote" placeholder="Handoff point, time, recipient confirmation, or discrepancy" maxLength={600} required /></label><div className="tableActionRow"><button className="button primary" type="submit" disabled={Boolean(pendingLabel)}>Confirm vendor handoff</button><button className="button secondary" type="button" onClick={() => setStructuredAction("")}>Cancel</button></div></form> : null}
      {structuredAction === "driver-mark-delivered" ? <form className="structuredActionForm" onSubmit={(event) => submitStructured(event, structuredAction)}><div className="two"><label>Recipient name<input name="recipientName" maxLength={160} required /></label><label>Returned bag/item count<input name="bagCount" maxLength={40} inputMode="numeric" required /></label></div><label>Handoff note<textarea name="operatorNote" placeholder="Where and to whom the order was handed over; note any exception" maxLength={600} required /></label><div className="tableActionRow"><button className="button primary" type="submit" disabled={Boolean(pendingLabel)}>Confirm delivery</button><button className="button secondary" type="button" onClick={() => setStructuredAction("")}>Cancel</button></div></form> : null}
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

function SharedOrderBoard({ role, userName }: { role: StaffRole; userName: string }) {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [status, setStatus] = useState("Loading shared order board…");
  const [lastSyncedAt, setLastSyncedAt] = useState("");
  const [queueView, setQueueView] = useState<QueueView>("action");
  const [query, setQuery] = useState("");

  async function loadOrders(showLoading = true) {
    if (showLoading) setStatus("Loading shared order board…");
    const response = await fetch("/api/orders");
    const data = await response.json();
    if (!response.ok || !data.ok) {
      setStatus(data.error ?? "Unable to load shared orders.");
      return;
    }
    setOrders(data.orders);
    setLastSyncedAt(new Date().toISOString());
    setStatus(data.orders.length ? "Updated." : "No shared orders yet.");
  }

  useEffect(() => {
    let active = true;
    async function refresh(showLoading = false) {
      if (!active) return;
      if (showLoading) setStatus("Loading shared order board…");
      try {
        const response = await fetch("/api/orders");
        const data = await response.json();
        if (!active) return;
        if (!response.ok || !data.ok) {
          setStatus(data.error ?? "Unable to load shared orders.");
          return;
        }
        setOrders(data.orders);
        setLastSyncedAt(new Date().toISOString());
        setStatus(data.orders.length ? "Updated." : "No shared orders yet.");
      } catch {
        if (active) setStatus("Unable to load shared orders.");
      }
    }
    refresh(true);
    const interval = window.setInterval(() => refresh(false), 30_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  const activeOrders = orders.filter((order) => !isClosedOrder(order));
  const focusOrders = activeOrders.filter((order) => orderMatchesRoleFocus(order, role, userName));
  const sourceOrders = queueView === "action" ? focusOrders : queueView === "active" ? activeOrders : orders;
  const normalizedQuery = query.trim().toLowerCase();
  const matchingOrders = normalizedQuery ? sourceOrders.filter((order) => [order.orderId, order.customer, order.phone, order.email, order.area, order.vendor, order.driver, order.status, order.payment].join(" ").toLowerCase().includes(normalizedQuery)) : sourceOrders;
  const visibleOrders = matchingOrders.slice(0, 12);
  const stats = queueStats(activeOrders, role, userName);
  const showPayment = role === "admin" || role === "support";
  const columnCount = showPayment ? 6 : 5;
  const queueHeading = queueView === "action" ? (stats.focusCount ? `${stats.focusCount} ${stats.focusLabel}` : "No work needs this role right now") : queueView === "active" ? `${activeOrders.length} active orders` : `${orders.length} total orders`;

  return (
    <section className="section sharedBoardSection">
      <div className="staffQueueHeader">
        <div>
          <p className="eyebrow">Live queue</p>
          <h2>{queueHeading}</h2>
          <p className="formHint">{role === "admin" ? "Use this queue for assignment, payment checks, closeout, and exceptions." : role === "vendor" ? "Use each order row to accept, receive, wash, or mark work ready." : role === "driver" ? "Use each order row for the next stop, handoff, delay, or delivery proof." : "Start with at-risk orders and customer follow-up before opening a new case."}</p>
        </div>
        <button className="button secondary" type="button" onClick={() => loadOrders()}>Refresh queue</button>
      </div>
      <div className="queueMetricGrid" aria-label="Queue summary">
        <article><span>{stats.focusLabel}</span><strong>{stats.focusCount}</strong></article>
        <article><span>available actions</span><strong>{stats.automationCount}</strong></article>
        <article><span>at risk</span><strong>{stats.riskCount}</strong></article>
        <article><span>latest update</span><strong>{orders[0] ? formatMetricTime(orders[0].updatedAt) : "—"}</strong></article>
      </div>
      <div className="queueTools">
        <div className="queueViewLinks" aria-label="Order queue view">{([['action', 'Needs action'], ['active', 'All active'], ['all', 'Recent history']] as Array<[QueueView, string]>).map(([key, label]) => <button className={queueView === key ? "active" : ""} key={key} type="button" onClick={() => setQueueView(key)}>{label}</button>)}</div>
        <label className="queueSearch"><span>Find an order</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Reference, customer, area, vendor…" /></label>
      </div>
      <div className="opsTableWrap queueTableWrap">
        <table className="opsTable queueTable">
          <thead>
            <tr><th scope="col">Order</th><th scope="col">Stage</th><th scope="col">Route</th><th scope="col">Assignment</th>{showPayment ? <th scope="col">Payment</th> : null}<th scope="col">Next action</th></tr>
          </thead>
          <tbody>
            {visibleOrders.map((order) => <tr className={`timer-${order.stageTimer.tone}`} key={order.orderId}>
              <td data-label="Order"><strong>{order.orderId}</strong><small>{order.customer}</small>{role !== "vendor" ? <small>{order.phone || "No phone"}</small> : null}<CustomerContactActions order={order} role={role} /></td>
              <td data-label="Stage"><span className="textFlag">{order.workflowStage.label}</span><small>{workflowPhaseLabel(order.workflowStage.key)} · {isRiskOrder(order) ? "Needs intervention" : order.priority}</small><StageCountdown order={order} /></td>
              <td data-label="Route">{role === "vendor" ? order.area : order.pickupAddress || order.area}<small>{role !== "vendor" && order.landmark ? `${order.landmark} · ${order.routeWindow}` : order.routeWindow}</small><div className="tableActionRow"><a className="button secondary" href={order.route.directionsUrl} target="_blank" rel="noopener noreferrer">Directions</a><a className="button secondary" href={order.route.googleMapsUrl} target="_blank" rel="noopener noreferrer">Area map</a></div></td>
              <td data-label="Assignment">{order.vendor !== "Unassigned" ? order.vendor : "Vendor pending"}<small>{order.driver !== "Unassigned" ? order.driver : "Driver pending"}</small></td>
              {showPayment ? <td data-label="Payment">{order.payment}<small>{order.email || "No email"}</small></td> : null}
              <td data-label="Next action"><p className="nextActionLine"><strong>Next:</strong> {order.nextStep}</p><AutomatedOrderActions order={order} role={role} userName={userName} onSaved={() => loadOrders(false)} /><details className="quietDetails"><summary>Timeline · {compactTimelineLabel(order.eventCount)}</summary><div className="timelineList">{order.timeline.slice(0, 4).map((event) => <div key={`${order.orderId}-${event.id}-${event.createdAt}`}><b>{event.status}</b><span>{event.type} · {event.actor} · {formatShortTime(event.createdAt)}</span><p>{event.note}</p></div>)}</div></details></td>
            </tr>)}
            {!visibleOrders.length ? <tr><td colSpan={columnCount}>{normalizedQuery ? "No orders match this search." : queueView === "action" ? "No orders currently need action from this role." : "No order rows in this view yet."}</td></tr> : null}
          </tbody>
        </table>
      </div>
      <p className="status">{status}{lastSyncedAt ? ` Last synced ${formatMetricTime(lastSyncedAt)}. Showing ${visibleOrders.length} of ${matchingOrders.length}.` : ""}</p>
    </section>
  );
}

async function postJSON<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

function PortalShell({ title, role, pageRole = role, userName, children }: PortalShellProps) {
  const pageHome = pageRole === "admin" ? "/admin" : pageRole === "vendor" ? "/vendors" : pageRole === "driver" ? "/drivers" : "/support";
  const portalLinks = pageRole === "admin" ? [{ href: "/admin", label: "Admin", icon: "admin" }] satisfies PortalLink[]
    : pageRole === "vendor" ? [{ href: "/vendors", label: "Vendor", icon: "vendor" }] satisfies PortalLink[]
    : pageRole === "driver" ? [{ href: "/drivers", label: "Routes", icon: "routes" }] satisfies PortalLink[]
    : [{ href: "/support", label: "Support", icon: "support" }] satisfies PortalLink[];
  const promise = rolePromise(pageRole);

  async function logoutStaff() {
    try {
      await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: "{}" });
    } finally {
      window.location.replace("/login");
    }
  }

  return (
    <main className="portalPage">
      <header className="portalNav">
        <Link className="brand" href="/" aria-label="Bubble Wash home"><span className="brandCrop"><Image className="brandMark" src="/bubble-wash-icon.jpg" alt="" width={58} height={58} /></span><span>Bubble Wash</span></Link>
        <nav className="portalLinks">
          {portalLinks.map(({ href, label, icon }) => <Link className="portalNavItem" key={href} href={href} aria-current={href === pageHome ? "page" : undefined}><StaffNavIcon type={icon} /><span>{label}</span></Link>)}
          <button className="portalNavItem logoutButton" type="button" onClick={logoutStaff}><StaffNavIcon type="exit" /><span>Sign out</span></button>
        </nav>
      </header>
      <section className="staffPageHeader">
        <div>
          <p className="eyebrow">{promise.eyebrow}</p>
          <h1>{promise.title}</h1>
          <p>{promise.subtitle}</p>
        </div>
        <p className="staffSessionLine"><strong>{userName}</strong><span>{title}</span><span>{pageRole} workspace · today&apos;s work</span></p>
      </section>
      {children}
    </main>
  );
}


function SupportTicketForm({ onSubmit, status }: { userName: string; role: StaffRole; onSubmit: SubmitHandler; status?: string }) {
  return (
    <form className="panel supportForm" onSubmit={(event) => onSubmit(event, "support-ticket")}>
      <h3>Open support ticket</h3>
      <p className="formHint">The signed-in operator is recorded automatically.</p>
      <div className="two"><label>Related order<input name="orderId" placeholder="BW-…" /></label><label>Issue type<select name="issueType">{supportTypes.map((item) => <option key={item}>{item}</option>)}</select></label></div>
      <div className="two"><label>Priority<select name="priority"><option>Normal</option><option>High</option><option>Urgent</option></select></label><label>Current status<select name="ticketStatus"><option>Open</option><option>Waiting on Customer</option><option>Waiting on Vendor</option><option>Waiting on Driver</option></select></label></div>
      <label>Case note<textarea name="message" placeholder="Customer impact, delay reason, payment reference, or item issue" required /></label>
      <button className="button primary full" type="submit">Raise Support Ticket</button>
      {status && <p className={noticeClass(status)} role="status">{status}</p>}
    </form>
  );
}

function AdminOnboardingCenter({ userName, onSubmit, status }: { userName: string; onSubmit: SubmitHandler; status: Record<string, string> }) {
  return (
    <section className="section portalSection onboardingCenter" aria-labelledby="admin-onboarding-title">
      <div className="onboardingHeader">
        <div>
          <p className="eyebrow">Roster updates</p>
          <h2 id="admin-onboarding-title">Vendor and rider access</h2>
          <p>Use these forms only when roster access, capacity ownership, or route coverage actually needs a manual update.</p>
        </div>
        <div className="onboardingBadges" aria-label="Roster workflow summary">
          <span>Vendor capacity → assignment</span>
          <span>Rider slots → dispatch</span>
          <span>Paused rows excluded</span>
        </div>
      </div>
      <div className="onboardingGrid">
        <form className="panel opsForm onboardingForm" onSubmit={(event) => onSubmit(event, "vendor-application")}>
          <div className="formTitleRow"><h3>Onboard vendor</h3><span>Admin owned</span></div>
          <div className="two"><label>Admin contact<input name="name" defaultValue={userName} required /></label><label>Admin email<input name="email" type="email" defaultValue="admin@bubblewash.local" required /></label></div>
          <div className="two"><label>Vendor phone<input name="phone" placeholder="Phone or WhatsApp" required /></label><label>Laundry business<input name="company" required /></label></div>
          <div className="two"><label>Approved zones<input name="area" placeholder="Osu, Labone" required /></label><label>Order slots today<input name="capacity" type="number" min="0" inputMode="numeric" placeholder="8" required /></label></div>
          <div className="two"><label>Availability<select name="availability"><option>Available today</option><option>Available tomorrow</option><option>Limited capacity</option><option>Paused today</option></select></label><label>Approved service<select name="services"><option>Wash + fold</option><option>Wash + iron + fold</option><option>Ironing only</option><option>Express capable</option><option>Bulk commercial</option></select></label></div>
          <label>Roster note<textarea name="message" placeholder="KYC checks, machine capacity, turnaround promise, pickup limits, or restrictions" required /></label>
          <button className="button primary full" type="submit">Save Vendor Roster</button>
          {status["vendor-application"] && <p className={noticeClass(status["vendor-application"])} role="status">{status["vendor-application"]}</p>}
        </form>
        <form className="panel opsForm onboardingForm" onSubmit={(event) => onSubmit(event, "driver-onboarding")}>
          <div className="formTitleRow"><h3>Onboard rider</h3><span>Dispatch source</span></div>
          <div className="two"><label>Rider full name<input name="name" required /></label><label>Rider email<input name="email" type="email" required /></label></div>
          <div className="two"><label>Rider phone<input name="phone" placeholder="Phone or WhatsApp" required /></label><label>Route team<input name="company" defaultValue="Bubble Wash Route Team" required /></label></div>
          <div className="two"><label>Approved route zones<input name="area" placeholder="Osu, Labone" required /></label><label>Bike or vehicle ID<input name="vehicle" required /></label></div>
          <div className="two"><label>Route slots today<input name="routeCapacity" type="number" min="0" inputMode="numeric" defaultValue="4" /></label><label>Rider status<select name="driverStatus"><option>Active</option><option>Training</option><option>Inactive</option><option>Suspended</option></select></label></div>
          <div className="two"><label>Availability<select name="availability"><option>Available today</option><option>Available tomorrow</option><option>Limited route capacity</option><option>Paused today</option></select></label><label>Backup zones<input name="serviceZones" placeholder="Airport, Cantonments" /></label></div>
          <label>Roster note<textarea name="message" placeholder="ID or licence check, route restrictions, emergency contact, or bag handoff rules" required /></label>
          <button className="button primary full" type="submit">Save Rider Roster</button>
          {status["driver-onboarding"] && <p className={noticeClass(status["driver-onboarding"])} role="status">{status["driver-onboarding"]}</p>}
        </form>
      </div>
    </section>
  );
}

function SupportOpsOverview({ cases, orders }: { cases: SupportCase[]; orders: OrderSummary[] }) {
  const openTickets = cases.filter((item) => !/closed|resolved/i.test(item.status));
  const urgentTickets = cases.filter((item) => /urgent|high/i.test(item.priority));
  const waitingTickets = cases.filter((item) => /waiting/i.test(item.status));
  const breachedOrders = orders.filter((order) => isRiskOrder(order));
  const lanes = [
    { label: "Triage", value: openTickets.length, note: "New or unresolved tickets" },
    { label: "Escalate", value: urgentTickets.length + breachedOrders.length, note: "Urgent tickets + SLA risk" },
    { label: "Waiting", value: waitingTickets.length, note: "Customer/vendor/driver response" },
    { label: "Resolve", value: cases.filter((item) => /resolved|closed/i.test(item.status)).length, note: "Closed support loops" },
  ];
  return (
    <section className="section supportOpsHero" aria-label="Support queue overview">
      <div className="supportOpsCopy">
        <p className="eyebrow">Support desk</p>
        <h2>Work the queue before opening manual case forms.</h2>
        <p>Start from customer impact: delayed pickup, payment issue, missing item, quality problem, or vendor escalation. Ticket actions should keep the original Order ID attached.</p>
      </div>
      <div className="supportLaneGrid">
        {lanes.map((lane) => <article key={lane.label}><span>{lane.label}</span><strong>{lane.value}</strong><small>{lane.note}</small></article>)}
      </div>
    </section>
  );
}

function SupportOrderWatchlist({ orders }: { orders: OrderSummary[] }) {
  const watchlist = orders.filter(isRiskOrder).slice(0, 5);
  return (
    <section className="section supportWatchlist" aria-label="Support SLA watchlist">
      <div className="activityHeader"><div><p className="eyebrow">At-risk orders</p><h2>Orders support should watch now</h2></div></div>
      <div className="supportWatchGrid">
        {watchlist.length ? watchlist.map((order) => <article className={`supportWatchCard timer-${order.stageTimer.tone}`} key={order.orderId}>
          <div className="orderBoardTop"><strong>{order.orderId}</strong><span>{order.workflowStage.label}</span></div>
          <h3>{order.customer}</h3>
          <div className="orderMeta minimalMeta"><span>{order.phone || "No phone"}</span><span>{order.area}</span><span>{order.stageTimer.label}</span></div>
          <p>{order.nextStep}</p>
        </article>) : <article className="supportWatchCard empty"><strong>No breached SLA right now</strong><p>The support desk can stay focused on new tickets and customer replies.</p></article>}
      </div>
    </section>
  );
}

function SupportTicketDesk({ userName }: { userName: string }) {
  const [records, setRecords] = useState<SubmissionRecord[]>([]);
  const [status, setStatus] = useState("Loading support tickets…");
  const [formStatus, setFormStatus] = useState<Record<string, string>>({});

  async function loadTickets(showLoading = true) {
    if (showLoading) setStatus("Loading support tickets…");
    const response = await fetch("/api/submissions");
    const data = await response.json();
    if (!response.ok || !data.ok) {
      setStatus(data.error ?? "Unable to load support tickets.");
      return;
    }
    const tickets = data.records.filter((record: SubmissionRecord) => String(record.data.submissionType ?? "").includes("support-ticket"));
    setRecords(tickets.slice(0, 200));
    setStatus(tickets.length ? "Support ticket desk loaded." : "No support tickets yet.");
  }

  async function action(event: FormEvent<HTMLFormElement>, supportCase: SupportCase) {
    event.preventDefault();
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
    }
  }

  useEffect(() => { loadTickets(); }, []);

  const cases = supportCases(records);

  return (
    <section className="section supportDeskSection">
      <div className="activityHeader"><div><p className="eyebrow">Case queue</p><h2>Customer cases</h2><p className="formHint">Each case appears once; actions remain attached to its history.</p></div><button className="button secondary" type="button" onClick={() => loadTickets()}>Refresh</button></div>
      <div className="supportTicketList">
        {cases.map((supportCase) => <article className="orderBoardCard supportTicketCard" key={supportCase.ticketId}>
          <div className="orderBoardTop"><strong>{supportCase.orderId || "Unlinked case"}</strong><span>{supportCase.status}</span></div>
          <h3>{supportCase.root.data.issueType || "Support ticket"}</h3>
          <div className="orderMeta"><span>Case: {supportCase.ticketId}</span><span>Raised by: {supportCase.root.data.name || "Team member"}</span><span>Team/customer: {supportCase.root.data.company || "Bubble Wash"}</span><span>Priority: {supportCase.priority}</span><span>Updated: {formatActivityTime(supportCase.latest.createdAt)}</span></div>
          <p>{supportCase.latest.data.message || supportCase.root.data.message || "No ticket note supplied."}</p>
          <details className="quietDetails"><summary>Case history · {compactTimelineLabel(supportCase.events.length)}</summary><div className="timelineList">{[...supportCase.events].reverse().map((event) => <div key={event.id}><b>{event.data.ticketStatus || event.data.issueType || "Open"}</b><span>{formatActivityTime(event.createdAt)} · {event.data.name || "Staff"}</span><p>{event.data.message || "No note supplied."}</p></div>)}</div></details>
          <form className="ticketActionForm" onSubmit={(event) => action(event, supportCase)}>
            <div className="two"><label>Case status<select name="ticketStatus" defaultValue={supportCase.status}><option>Open</option><option>In Review</option><option>Assigned</option><option>Waiting on Customer</option><option>Waiting on Vendor</option><option>Waiting on Driver</option><option>Escalated</option><option>Resolved</option><option>Closed</option><option>Reopened</option></select></label><label>Priority<select name="priority" defaultValue={supportCase.priority}><option>Normal</option><option>High</option><option>Urgent</option></select></label></div>
            <div className="two"><label>Assigned desk<select name="assignedRole"><option>Support</option><option>Admin</option><option>Vendor</option><option>Driver</option></select></label><label>Escalation level<select name="escalationLevel"><option>Level 0</option><option>Level 1</option><option>Level 2</option><option>Level 3</option></select></label></div>
            <label>Case note<textarea name="message" placeholder="Action, escalation reason, customer impact, or resolution summary" required /></label>
            <button className="button primary full" type="submit">Save Ticket Action</button>
            {formStatus[supportCase.ticketId] && <p className={noticeClass(formStatus[supportCase.ticketId])} role="status">{formStatus[supportCase.ticketId]}</p>}
          </form>
        </article>)}
        {!cases.length ? <p className="status">No customer cases yet.</p> : null}
      </div>
      <p className="status">{status}</p>
    </section>
  );
}

export function AdminWorkspace({ userName, role }: { userName: string; role: StaffRole }) {
  const [formStatus, setFormStatus] = useState<Record<string, string>>({});

  async function submitLead(event: FormEvent<HTMLFormElement>, type: string) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.submissionType = type;
    try {
      const data = await postJSON<{ ok: boolean; message: string; id: string }>("/api/submit", payload);
      setFormStatus((current) => ({ ...current, [type]: `${data.message} Reference: ${data.id}` }));
      form.reset();
    } catch (error) {
      setFormStatus((current) => ({ ...current, [type]: error instanceof Error ? error.message : "Unable to save request." }));
    }
  }

  return (
    <PortalShell role={role} userName={userName} title="Admin workspace">
      <SharedOrderBoard role={role} userName={userName} />
      <AvailabilityBoard role={role} />
      <section className="section portalSection manualSection">
        <details className="manualToolbox">
          <summary><div><span>Roster and capacity</span><small>Only when vendor or rider access changes</small></div><em>Open when needed</em></summary>
          <AdminOnboardingCenter userName={userName} onSubmit={submitLead} status={formStatus} />
        </details>
      </section>
      <section className="section portalSection supportCreateSection manualSection">
        <details className="manualToolbox">
          <summary><div><span>Open a case</span><small>Use for an exception that the order queue does not cover</small></div><em>Open when needed</em></summary>
          <SupportTicketForm userName={userName} role="admin" onSubmit={submitLead} status={formStatus["support-ticket"]} />
        </details>
      </section>
      <RecentActivity />
    </PortalShell>
  );
}

export function VendorWorkspace({ userName, role }: { userName: string; role: StaffRole }) {
  const [formStatus, setFormStatus] = useState<Record<string, string>>({});

  async function submitLead(event: FormEvent<HTMLFormElement>, type: string) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.submissionType = type;
    try {
      const data = await postJSON<{ ok: boolean; message: string; id: string }>("/api/submit", payload);
      setFormStatus((current) => ({ ...current, [type]: `${data.message} Reference: ${data.id}` }));
      form.reset();
    } catch (error) {
      setFormStatus((current) => ({ ...current, [type]: error instanceof Error ? error.message : "Unable to save request." }));
    }
  }

  return (
    <PortalShell role={role} pageRole="vendor" userName={userName} title="Vendor workspace">
      <SharedOrderBoard role="vendor" userName={userName} />
      <AvailabilityBoard role="vendor" />
      <section className="section vendorSection portalSection manualSection">
        <details className="manualToolbox">
          <summary><div><span>Today&apos;s capacity</span><small>Update the slots and services the partner can accept</small></div><em>Open when needed</em></summary>
          <div className="vendorGrid">
          <form className="panel vendorForm" onSubmit={(event) => submitLead(event, "vendor-application")}>
            <h3>Update today&apos;s capacity</h3>
            <p className="formHint">The signed-in vendor account is recorded automatically.</p>
            <div className="two"><label>Laundry business<input name="company" required /></label><label>Service areas<input name="area" placeholder="Osu, Labone" /></label></div>
            <div className="two"><label>Order slots remaining<input name="capacity" type="number" min="0" inputMode="numeric" /></label><label>Availability<select name="availability"><option>Available today</option><option>Available tomorrow</option><option>Limited capacity</option><option>Paused today</option></select></label></div>
            <label>Available service<select name="services"><option>Wash + fold</option><option>Wash + iron + fold</option><option>Ironing only</option><option>Express capable</option><option>Bulk commercial</option></select></label>
            <label>Capacity note<textarea name="message" placeholder="Turnaround, machine, or service restrictions" /></label>
            <button className="button primary full" type="submit">Update Capacity</button>
            {formStatus["vendor-application"] && <p className={noticeClass(formStatus["vendor-application"])} role="status">{formStatus["vendor-application"]}</p>}
          </form>
          </div>
        </details>
      </section>
      <section className="section portalSection supportCreateSection manualSection">
        <details className="manualToolbox">
          <summary><div><span>Open a case</span><small>Use for a production exception that the order queue does not cover</small></div><em>Open when needed</em></summary>
          <SupportTicketForm userName={userName} role="vendor" onSubmit={submitLead} status={formStatus["support-ticket"]} />
        </details>
      </section>
      <RecentActivity filter="vendor" />
    </PortalShell>
  );
}

export function DriverWorkspace({ userName, role }: { userName: string; role: StaffRole }) {
  const [formStatus, setFormStatus] = useState<Record<string, string>>({});

  async function submitLead(event: FormEvent<HTMLFormElement>, type: string) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.submissionType = type;
    try {
      const data = await postJSON<{ ok: boolean; message: string; id: string }>("/api/submit", payload);
      setFormStatus((current) => ({ ...current, [type]: `${data.message} Reference: ${data.id}` }));
      form.reset();
    } catch (error) {
      setFormStatus((current) => ({ ...current, [type]: error instanceof Error ? error.message : "Unable to save route update." }));
    }
  }

  return (
    <PortalShell role={role} pageRole="driver" userName={userName} title="Driver route board">
      <SharedOrderBoard role="driver" userName={userName} />
      <AvailabilityBoard role="driver" />
      <section className="section portalSection supportCreateSection manualSection">
        <details className="manualToolbox">
          <summary><div><span>Open a route case</span><small>Use for an exception that the order queue does not cover</small></div><em>Open when needed</em></summary>
          <SupportTicketForm userName={userName} role="driver" onSubmit={submitLead} status={formStatus["support-ticket"]} />
        </details>
      </section>
      <RecentActivity filter="driver-route-log" />
    </PortalShell>
  );
}

export function SupportWorkspace({ userName, role }: { userName: string; role: StaffRole }) {
  const [formStatus, setFormStatus] = useState<Record<string, string>>({});
  const [records, setRecords] = useState<SubmissionRecord[]>([]);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [deskStatus, setDeskStatus] = useState("Loading support desk…");

  async function submitLead(event: FormEvent<HTMLFormElement>, type: string) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.submissionType = type;
    try {
      const data = await postJSON<{ ok: boolean; message: string; id: string }>("/api/submit", payload);
      setFormStatus((current) => ({ ...current, [type]: `${data.message} Reference: ${data.id}` }));
      form.reset();
      await loadSupportDesk(false);
    } catch (error) {
      setFormStatus((current) => ({ ...current, [type]: error instanceof Error ? error.message : "Unable to save request." }));
    }
  }

  async function loadSupportDesk(showLoading = true) {
    if (showLoading) setDeskStatus("Loading support desk…");
    try {
      const [submissionsResponse, ordersResponse] = await Promise.all([fetch("/api/submissions"), fetch("/api/orders")]);
      const submissionsData = await submissionsResponse.json();
      const ordersData = await ordersResponse.json();
      if (!submissionsResponse.ok || !submissionsData.ok) {
        setDeskStatus(submissionsData.error ?? "Unable to load support tickets.");
        return;
      }
      if (!ordersResponse.ok || !ordersData.ok) {
        setDeskStatus(ordersData.error ?? "Unable to load support order watchlist.");
        return;
      }
      const supportRecords = submissionsData.records.filter((record: SubmissionRecord) => String(record.data.submissionType ?? "").includes("support-ticket"));
      setRecords(supportRecords.slice(0, 200));
      setOrders(ordersData.orders);
      setDeskStatus("Support desk updated.");
    } catch {
      setDeskStatus("Unable to load support desk.");
    }
  }

  useEffect(() => { loadSupportDesk(); }, []);

  return (
    <PortalShell role={role} pageRole="support" userName={userName} title="Support workspace">
      <SupportOpsOverview cases={supportCases(records)} orders={orders} />
      <SupportOrderWatchlist orders={orders} />
      <SupportTicketDesk userName={userName} />
      <SharedOrderBoard role="support" userName={userName} />
      <section className="section portalSection supportCreateSection manualSection">
        <details className="manualToolbox">
          <summary><div><span>Open a case</span><small>Use when an existing order or case does not cover the issue</small></div><em>Open when needed</em></summary>
          <SupportTicketForm userName={userName} role="support" onSubmit={submitLead} status={formStatus["support-ticket"]} />
        </details>
      </section>
      <RecentActivity filter="support" />
      <p className="status supportDeskStatus">{deskStatus}</p>
    </PortalShell>
  );
}
