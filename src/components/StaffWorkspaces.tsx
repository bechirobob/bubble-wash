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
  customer: string;
  email: string;
  phone: string;
  area: string;
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

function rolePromise(role: StaffRole) {
  if (role === "admin") return { eyebrow: "Operations desk", title: "Admin queue", subtitle: "Review active jobs, reassign work, and resolve exceptions before the customer has to chase." };
  if (role === "vendor") return { eyebrow: "Vendor workspace", title: "Washing queue", subtitle: "Start each load, mark it ready, or flag a problem without opening separate partner tools first." };
  if (role === "driver") return { eyebrow: "Driver workspace", title: "Route handoffs", subtitle: "See the next stop, confirm arrival, and keep proof attached to the same order trail." };
  return { eyebrow: "Support Desk", title: "Tickets and follow-up", subtitle: "Track at-risk orders, open cases, and customer-facing resolutions from one queue." };
}

function isRiskOrder(order: OrderSummary) {
  return order.workflowStage.key === "exception" || order.stageTimer.tone === "breached" || order.priority === "Urgent";
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
    return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 11.5 12 5l8 6.5" /><path d="M6.5 10.5v8h11v-8" /><path d="M10 18.5v-5h4v5" /></svg>;
  }
  if (type === "vendor") {
    return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3.5 8.5h6l1.6 2h9.4v7.5h-17z" /><path d="M3.5 8.5v-2h6.5l1.5 2" /></svg>;
  }
  if (type === "routes") {
    return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 19V9" /><path d="M10 19V5" /><path d="M15 19v-7" /><path d="M20 19V8" /></svg>;
  }
  if (type === "support") {
    return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 7.5h14" /><path d="M5 12h10" /><path d="M5 16.5h7" /><path d="M18 15.5v3l-2.5-2" /></svg>;
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
    return <div className="slaPill timer-paused" aria-label="Phase timer complete"><span>Phase timer</span><b>Complete</b><small>{workflowPhaseLabel(order.workflowStage.key)} · {order.priority}</small></div>;
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
    <div className={`slaPill countdown timer-${tone}`} aria-label={`${label} ${duration}`}>
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
            {vendors.slice(0, 6).map((vendor) => <tr key={vendor.vendorId}><td><strong>{vendor.vendorName}</strong><small>Vendor</small></td><td>{vendor.availabilityStatus}</td><td>{vendor.capacityRemaining}</td><td>{vendor.serviceZones.join(", ") || "Any"}<small>{vendor.serviceTypes.join(", ") || "Any service"}</small></td><td>{vendor.notes || "No vendor note."}</td></tr>)}
            {(role === "admin" || role === "driver") && drivers.slice(0, 6).map((driver) => <tr key={driver.driverId}><td><strong>{driver.driverName}</strong><small>Rider</small></td><td>{driver.availabilityStatus}</td><td>{driver.capacityRemaining}</td><td>{driver.serviceZones.join(", ") || "Any"}<small>{driver.vehicle || "Vehicle not set"}</small></td><td>{driver.notes || "No driver note."}</td></tr>)}
            {!vendors.length && !(role === "admin" || role === "driver") ? <tr><td colSpan={5}>No capacity rows yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
      {role === "admin" && declines.length > 0 && <div className="opsTableWrap declineTableWrap"><table className="opsTable"><caption>Recent vendor declines</caption><thead><tr><th scope="col">Order</th><th scope="col">Vendor</th><th scope="col">Reason</th><th scope="col">Saved</th></tr></thead><tbody>{declines.slice(0, 4).map((decline) => <tr key={decline.id}><td><strong>{decline.orderId}</strong><small>By {decline.declinedBy}</small></td><td>{decline.vendorName}</td><td>{decline.reason}</td><td>{formatActivityTime(decline.createdAt)}</td></tr>)}</tbody></table></div>}
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
                  {visibleRecords.length ? visibleRecords.map((record) => <tr className={`${selectedId === record.id ? "is-selected" : ""} ${freshIds.includes(record.id) ? "is-new" : ""}`} key={record.id} onClick={() => setSelectedId(record.id)}>
                    <td><strong>{record.id}</strong></td>
                    <td>{activityTypeLabel(activityType(record))}</td>
                    <td>{activitySubject(record)}</td>
                    <td>{changeSummaries.get(record.id)}</td>
                    <td>{formatActivityTime(record.createdAt)}</td>
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
  const actions = automationActionsForOrder(order, role, userName);

  async function run(action: AutomationAction) {
    setPendingLabel(action.label);
    setStatus(`${action.label}…`);
    const payload: Record<string, string> = { orderId: order.orderId, actionKey: action.key };
    if (action.key === "vendor-decline-job") {
      const reason = window.prompt("Why is this job being declined? Admin needs the reason for reassignment.");
      if (!reason?.trim()) {
        setStatus("Decline cancelled — reason required for reassignment.");
        setPendingLabel("");
        return;
      }
      payload.reason = reason.trim();
    }
    try {
      const data = await postJSON<{ ok: boolean; message: string; id: string; nextStatus: string }>("/api/orders/advance", payload);
      setStatus(`Saved ${data.id} → ${data.nextStatus}`);
      await onSaved();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to run automation.");
    } finally {
      setPendingLabel("");
    }
  }

  return (
    <div className="automationPanel">
      <div className="automationSummary">
        <b>{actions.length ? "Action rail" : "No action"}</b>
        <span>{actions.length ? `${actions.length} available` : "Waiting"}</span>
      </div>
      <div className="automationActions">
        {actions.length ? actions.map((action, index) => <button className={`button ${index === 0 ? "primary" : "secondary"}`} disabled={Boolean(pendingLabel)} key={action.label} onClick={() => run(action)} type="button">{pendingLabel === action.label ? "Working…" : action.label}</button>) : <span className="status">Waiting</span>}
      </div>
      {status && <p className="status success" role="status" aria-live="polite">{status}</p>}
    </div>
  );
}

function SharedOrderBoard({ role, userName }: { role: StaffRole; userName: string }) {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [status, setStatus] = useState("Loading shared order board…");

  async function loadOrders(showLoading = true) {
    if (showLoading) setStatus("Loading shared order board…");
    const response = await fetch("/api/orders");
    const data = await response.json();
    if (!response.ok || !data.ok) {
      setStatus(data.error ?? "Unable to load shared orders.");
      return;
    }
    setOrders(data.orders.slice(0, 10));
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
        setOrders(data.orders.slice(0, 10));
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

  const focusOrders = orders.filter((order) => orderMatchesRoleFocus(order, role, userName));
  const visibleOrders = (focusOrders.length ? focusOrders : orders).slice(0, 6);
  const stats = queueStats(orders, role, userName);

  return (
    <section className="section sharedBoardSection">
      <div className="staffQueueHeader">
        <div>
          <p className="eyebrow">Live queue</p>
          <h2>{stats.focusCount ? `${stats.focusCount} ${stats.focusLabel}` : "No urgent follow-up right now"}</h2>
          <p className="formHint">{role === "admin" ? "Assignment, reassignment, and escalations should appear here before any manual office work." : role === "vendor" ? "Open the jobs that need a production action before touching secondary partner tools." : role === "driver" ? "Use this queue to work the next stop, handoff, or delay before opening manual route tools." : "Start with at-risk orders and follow-up work before creating manual tickets."}</p>
        </div>
        <button className="button secondary" type="button" onClick={() => loadOrders()}>Refresh queue</button>
      </div>
      <div className="queueMetricGrid" aria-label="Queue summary">
        <article><span>{stats.focusLabel}</span><strong>{stats.focusCount}</strong></article>
        <article><span>available actions</span><strong>{stats.automationCount}</strong></article>
        <article><span>at risk</span><strong>{stats.riskCount}</strong></article>
        <article><span>latest update</span><strong>{orders[0] ? formatMetricTime(orders[0].updatedAt) : "—"}</strong></article>
      </div>
      <div className="opsTableWrap queueTableWrap">
        <table className="opsTable queueTable">
          <thead>
            <tr><th scope="col">Order</th><th scope="col">Stage</th><th scope="col">Route</th><th scope="col">Assignment</th><th scope="col">Payment</th><th scope="col">Next action</th></tr>
          </thead>
          <tbody>
            {visibleOrders.map((order) => <tr className={`timer-${order.stageTimer.tone}`} key={order.orderId}>
              <td><strong>{order.orderId}</strong><small>{order.customer}</small><small>{order.phone || "No phone"}</small></td>
              <td><span className="textFlag">{order.workflowStage.label}</span><small>{workflowPhaseLabel(order.workflowStage.key)} · {isRiskOrder(order) ? "Needs intervention" : order.priority}</small><StageCountdown order={order} /></td>
              <td>{order.area}<small>{order.routeWindow}</small><div className="tableActionRow"><a className="button secondary" href={order.route.directionsUrl} target="_blank" rel="noopener noreferrer">Directions</a><a className="button secondary" href={order.route.googleMapsUrl} target="_blank" rel="noopener noreferrer">Zone</a></div></td>
              <td>{order.vendor !== "Unassigned" ? order.vendor : "Vendor pending"}<small>{order.driver !== "Unassigned" ? order.driver : "Driver pending"}</small></td>
              <td>{order.payment}<small>{order.email || "No email"}</small></td>
              <td><p className="nextActionLine"><strong>Next:</strong> {order.nextStep}</p><AutomatedOrderActions order={order} role={role} userName={userName} onSaved={() => loadOrders(false)} /><details className="quietDetails"><summary>Timeline · {compactTimelineLabel(order.eventCount)}</summary><div className="timelineList">{order.timeline.slice(0, 4).map((event) => <div key={`${order.orderId}-${event.id}-${event.createdAt}`}><b>{event.status}</b><span>{event.type} · {event.actor} · {formatShortTime(event.createdAt)}</span><p>{event.note}</p></div>)}</div></details></td>
            </tr>)}
            {!visibleOrders.length ? <tr><td colSpan={6}>No live order rows for this desk yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <p className="status">{status}</p>
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
  const portalLinks = role === "admin"
    ? [{ href: "/admin", label: "Admin", icon: "admin" }, { href: "/vendors", label: "Vendor", icon: "vendor" }, { href: "/drivers", label: "Routes", icon: "routes" }, { href: "/support", label: "Support", icon: "support" }] satisfies PortalLink[]
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
        <Link className="brand" href="/" aria-label="Bubble Wash home"><Image className="brandMark" src="/bubble-wash-icon.jpg" alt="Bubble Wash logo" width={58} height={58} /><span>Bubble Wash</span></Link>
        <nav className="portalLinks">
          {portalLinks.map(({ href, label, icon }) => <Link className="portalNavItem" key={href} href={href} aria-current={href === pageHome ? "page" : undefined}><StaffNavIcon type={icon} /><span>{label}</span></Link>)}
          <button className="portalNavItem logoutButton" type="button" onClick={logoutStaff}><StaffNavIcon type="exit" /><span>Exit</span></button>
        </nav>
      </header>
      <section className="staffPageHeader">
        <div>
          <p className="eyebrow">{promise.eyebrow}</p>
          <h1>{promise.title}</h1>
          <p>{promise.subtitle}</p>
        </div>
        <p className="staffSessionLine"><strong>{userName}</strong><span>{title}</span><span>{pageRole} workspace · queue first</span></p>
      </section>
      {children}
    </main>
  );
}


function SupportTicketForm({ userName, role, onSubmit, status }: { userName: string; role: StaffRole; onSubmit: SubmitHandler; status?: string }) {
  return (
    <form className="panel supportForm" onSubmit={(event) => onSubmit(event, "support-ticket")}>
      <h3>Open support ticket</h3>
      <div className="two"><input name="name" placeholder="Your name" defaultValue={userName} required /><input name="email" type="email" placeholder="Email" defaultValue={`${role}@bubblewash.local`} required /></div>
      <div className="two"><input name="phone" placeholder="Phone / WhatsApp" required /><input name="company" placeholder="Team, vendor, or customer" defaultValue={role === "admin" ? "Bubble Wash Operations" : role === "driver" ? "Bubble Wash Route Team" : role === "vendor" ? "Vendor Partner" : "Bubble Wash Support"} required /></div>
      <div className="two"><input name="orderId" placeholder="Related Order ID" /><select name="issueType">{supportTypes.map((item) => <option key={item}>{item}</option>)}</select></div>
      <div className="two"><select name="priority"><option>Normal</option><option>High</option><option>Urgent</option></select><select name="ticketStatus"><option>Open</option><option>Waiting on Customer</option><option>Waiting on Vendor</option><option>Waiting on Driver</option></select></div>
      <textarea name="message" placeholder="What happened? Include the timeline, customer impact, delay reason, payment reference, or item issue." required />
      <button className="button primary full" type="submit">Raise Support Ticket</button>
      {status && <p className="status success">{status}</p>}
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
        <div className="onboardingBadges" aria-label="Onboarding automation summary">
          <span>Vendor capacity → assignment</span>
          <span>Rider slots → dispatch</span>
          <span>Paused rows excluded</span>
        </div>
      </div>
      <div className="onboardingGrid">
        <form className="panel opsForm onboardingForm" onSubmit={(event) => onSubmit(event, "vendor-application")}>
          <div className="formTitleRow"><h3>Onboard vendor</h3><span>Admin owned</span></div>
          <div className="two"><input name="name" placeholder="Admin contact" defaultValue={userName} required /><input name="email" type="email" placeholder="Admin email" defaultValue="admin@bubblewash.local" required /></div>
          <div className="two"><input name="phone" placeholder="Vendor phone / WhatsApp" required /><input name="company" placeholder="Vendor / laundromat name" required /></div>
          <div className="two"><input name="area" placeholder="Approved zones e.g. Osu, Labone" required /><input name="capacity" inputMode="numeric" placeholder="Order slots today e.g. 8" required /></div>
          <div className="two"><select name="availability"><option>Available today</option><option>Available tomorrow</option><option>Limited capacity</option><option>Paused today</option></select><select name="services"><option>Wash + fold</option><option>Wash + iron + fold</option><option>Ironing only</option><option>Express capable</option><option>Bulk commercial</option></select></div>
          <textarea name="message" placeholder="KYC checks, machine capacity, turnaround promise, pickup limits, service restrictions..." required />
          <button className="button primary full" type="submit">Save Vendor Roster</button>
          {status["vendor-application"] && <p className="status success">{status["vendor-application"]}</p>}
        </form>
        <form className="panel opsForm onboardingForm" onSubmit={(event) => onSubmit(event, "driver-onboarding")}>
          <div className="formTitleRow"><h3>Onboard rider</h3><span>Dispatch source</span></div>
          <div className="two"><input name="name" placeholder="Rider full name" required /><input name="email" type="email" placeholder="Rider email" required /></div>
          <div className="two"><input name="phone" placeholder="Rider phone / WhatsApp" required /><input name="company" placeholder="Route team / contractor" defaultValue="Bubble Wash Route Team" required /></div>
          <div className="two"><input name="area" placeholder="Approved route zones e.g. Osu, Labone" required /><input name="vehicle" placeholder="Bike / vehicle ID" required /></div>
          <div className="two"><input name="routeCapacity" inputMode="numeric" placeholder="Route slots today e.g. 4" defaultValue="4" /><select name="driverStatus"><option>Active</option><option>Training</option><option>Inactive</option><option>Suspended</option></select></div>
          <div className="two"><select name="availability"><option>Available today</option><option>Available tomorrow</option><option>Limited route capacity</option><option>Paused today</option></select><input name="serviceZones" placeholder="Backup zones e.g. Airport, Cantonments" /></div>
          <textarea name="message" placeholder="ID/license check, route restrictions, emergency contact, bag handoff rules..." required />
          <button className="button primary full" type="submit">Save Rider Roster</button>
          {status["driver-onboarding"] && <p className="status success">{status["driver-onboarding"]}</p>}
        </form>
      </div>
    </section>
  );
}

function SupportOpsOverview({ records, orders }: { records: SubmissionRecord[]; orders: OrderSummary[] }) {
  const openTickets = records.filter((record) => !/closed|resolved/i.test(String(record.data.ticketStatus ?? "")));
  const urgentTickets = records.filter((record) => /urgent|high/i.test(String(record.data.priority ?? "")));
  const waitingTickets = records.filter((record) => /waiting/i.test(String(record.data.ticketStatus ?? "")));
  const breachedOrders = orders.filter((order) => isRiskOrder(order));
  const lanes = [
    { label: "Triage", value: openTickets.length, note: "New or unresolved tickets" },
    { label: "Escalate", value: urgentTickets.length + breachedOrders.length, note: "Urgent tickets + SLA risk" },
    { label: "Waiting", value: waitingTickets.length, note: "Customer/vendor/driver response" },
    { label: "Resolve", value: records.filter((record) => /resolved|closed/i.test(String(record.data.ticketStatus ?? ""))).length, note: "Closed support loops" },
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
    setRecords(tickets.slice(0, 16));
    setStatus(tickets.length ? "Support ticket desk loaded." : "No support tickets yet.");
  }

  async function action(event: FormEvent<HTMLFormElement>, record: SubmissionRecord) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.submissionType = "support-ticket-action";
    payload.orderId = String(record.data.orderId || record.id);
    payload.company = String(record.data.company || "Bubble Wash Support");
    payload.email = "support@bubblewash.local";
    payload.phone = String(record.data.phone || "support-desk");
    payload.name = userName;
    try {
      const data = await postJSON<{ ok: boolean; message: string; id: string }>("/api/submit", payload);
      setFormStatus((current) => ({ ...current, [record.id]: `${data.message} Action: ${data.id}` }));
      form.reset();
      await loadTickets(false);
    } catch (error) {
      setFormStatus((current) => ({ ...current, [record.id]: error instanceof Error ? error.message : "Unable to save ticket action." }));
    }
  }

  useEffect(() => { loadTickets(); }, []);

  return (
    <section className="section supportDeskSection">
      <div className="activityHeader"><div><p className="eyebrow">Case queue</p><h2>Open tickets</h2></div><button className="button secondary" type="button" onClick={() => loadTickets()}>Refresh</button></div>
      <div className="supportTicketList">
        {records.map((record) => <article className="orderBoardCard supportTicketCard" key={record.id}>
          <div className="orderBoardTop"><strong>{record.data.orderId || record.id}</strong><span>{record.data.ticketStatus || record.data.issueType || "Open"}</span></div>
          <h3>{record.data.issueType || "Support ticket"}</h3>
          <div className="orderMeta"><span>Raised by: {record.data.name || "Team member"}</span><span>Team/customer: {record.data.company || "Bubble Wash"}</span><span>Priority: {record.data.priority || "Normal"}</span><span>Created: {new Date(record.createdAt).toLocaleString()}</span></div>
          <p>{record.data.message || "No ticket note supplied."}</p>
          <form className="ticketActionForm" onSubmit={(event) => action(event, record)}>
            <div className="two"><select name="ticketStatus"><option>In Review</option><option>Assigned</option><option>Waiting on Customer</option><option>Waiting on Vendor</option><option>Waiting on Driver</option><option>Escalated</option><option>Resolved</option><option>Closed</option><option>Reopened</option></select><select name="priority"><option>Normal</option><option>High</option><option>Urgent</option></select></div>
            <div className="two"><select name="assignedRole"><option>Support</option><option>Admin</option><option>Vendor</option><option>Driver</option></select><select name="escalationLevel"><option>Level 0</option><option>Level 1</option><option>Level 2</option><option>Level 3</option></select></div>
            <textarea name="message" placeholder="Action note, escalation reason, de-escalation reason, or resolution summary..." required />
            <button className="button primary full" type="submit">Save Ticket Action</button>
            {formStatus[record.id] && <p className="status success">{formStatus[record.id]}</p>}
          </form>
        </article>)}
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
          <summary><div><span>Roster updates</span><small>Only when vendor or rider access changes</small></div><em>Secondary tools</em></summary>
          <AdminOnboardingCenter userName={userName} onSubmit={submitLead} status={formStatus} />
        </details>
      </section>
      <section className="section opsSection portalSection manualSection">
        <details className="manualToolbox">
          <summary><div><span>Manual Actions</span><small>Use only when the queue cannot advance the order</small></div><em>Secondary tools</em></summary>
          <div className="opsGrid compactManualGrid">
          <form className="panel opsForm" onSubmit={(event) => submitLead(event, "admin-operation")}> 
            <h3>Log admin action</h3>
            <div className="two"><input name="name" placeholder="Operator name" defaultValue={userName} required /><input name="email" type="email" placeholder="Operator email" defaultValue="admin@bubblewash.local" required /></div>
            <div className="two"><input name="phone" placeholder="Operator phone" required /><input name="company" placeholder="Bubble Wash operations" defaultValue="Bubble Wash Operations" required /></div>
            <div className="two"><input name="orderId" placeholder="Shared Order ID e.g. BW-1779979663969" required /><input name="vendorName" placeholder="Assigned vendor e.g. CleanPro Laundry" /></div>
            <div className="two"><input name="driverName" placeholder="Assigned driver e.g. Kofi Route 1" /><input name="routeWindow" placeholder="ETA/window e.g. 2:30–3:00 PM" /></div>
            <div className="two"><select name="actionType"><option>New order intake</option><option>Assign vendor</option><option>Update order status</option><option>Payment follow-up</option><option>Quality issue</option><option>Customer escalation</option></select><select name="orderStatus"><option>Received</option><option>Pickup scheduled</option><option>Vendor assigned</option><option>In washing</option><option>Ready for delivery</option><option>Delivered</option><option>Needs attention</option></select></div>
            <div className="two"><select name="priority"><option>Normal</option><option>High</option><option>Urgent</option></select><select name="paymentPreference"><option>Payment not confirmed</option><option>MTN MoMo</option><option>Telecel Cash</option><option>Card</option><option>Bank transfer</option><option>Invoice</option></select></div>
            <textarea name="message" placeholder="Action notes: customer, vendor, route, promised time, payment status, or quality issue..." required />
            <button className="button primary full" type="submit">Save Admin Action</button>
            {formStatus["admin-operation"] && <p className="status success">{formStatus["admin-operation"]}</p>}
          </form>
          </div>
        </details>
      </section>
      <section className="section portalSection supportCreateSection manualSection">
        <details className="manualToolbox">
          <summary><div><span>Case Actions</span><small>Open a manual ticket only when automation is not enough</small></div><em>Secondary tools</em></summary>
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
          <summary><div><span>Partner Actions</span><small>Use these only for manual partner-side updates</small></div><em>Secondary tools</em></summary>
          <div className="vendorGrid">
          <form className="panel vendorForm" onSubmit={(event) => submitLead(event, "vendor-application")}>
            <h3>Update today&apos;s capacity</h3>
            <div className="two"><input name="name" placeholder="Contact name" defaultValue={userName} required /><input name="email" type="email" placeholder="Email" defaultValue="vendor@bubblewash.local" required /></div>
            <div className="two"><input name="phone" placeholder="Phone / WhatsApp" required /><input name="company" placeholder="Laundromat name" required /></div>
            <div className="two"><input name="area" placeholder="Service zones e.g. Osu, Labone" /><input name="capacity" inputMode="numeric" placeholder="Order slots today e.g. 8" /></div>
            <div className="two"><select name="availability"><option>Available today</option><option>Available tomorrow</option><option>Limited capacity</option><option>Paused today</option></select><select name="services"><option>Wash + fold</option><option>Wash + iron + fold</option><option>Ironing only</option><option>Express capable</option><option>Bulk commercial</option></select></div>
            <textarea name="message" placeholder="Machines available, turnaround time, pickup limits, delivery support, service notes..." />
            <button className="button primary full" type="submit">Update Capacity</button>
            {formStatus["vendor-application"] && <p className="status success">{formStatus["vendor-application"]}</p>}
          </form>
          <form className="panel vendorForm" onSubmit={(event) => submitLead(event, "vendor-job-update")}>
            <h3>Accept or update a job</h3>
            <div className="two"><input name="name" placeholder="Vendor contact" defaultValue={userName} required /><input name="email" type="email" placeholder="Vendor email" defaultValue="vendor@bubblewash.local" required /></div>
            <div className="two"><input name="phone" placeholder="Vendor phone" required /><input name="company" placeholder="Laundromat name" required /></div>
            <div className="two"><input name="orderId" placeholder="Order ID" /><select name="jobStatus"><option>Accepted</option><option>Picked up by vendor</option><option>Washing started</option><option>Ironing / finishing</option><option>Ready for driver</option><option>Issue found</option></select></div>
            <textarea name="message" placeholder="Weight received, bag count, expected completion, issue notes, missing item notes..." required />
            <button className="button secondary full" type="submit">Submit Job Update</button>
            {formStatus["vendor-job-update"] && <p className="status success">{formStatus["vendor-job-update"]}</p>}
          </form>
          <form className="panel vendorForm" onSubmit={(event) => submitLead(event, "qr-bag-intake")}> 
            <h3>QR / bag intake check</h3>
            <div className="two"><input name="name" placeholder="Vendor contact" defaultValue={userName} required /><input name="email" type="email" placeholder="Vendor email" defaultValue="vendor@bubblewash.local" required /></div>
            <div className="two"><input name="phone" placeholder="Vendor phone" required /><input name="company" placeholder="Laundromat name" required /></div>
            <div className="two"><input name="orderId" placeholder="Order ID" required /><input name="qrTag" placeholder="QR / bag tag e.g. BW-BAG-04" /></div>
            <div className="two"><input name="bagCount" placeholder="Bag count / received kg" /><select name="itemCondition"><option>All items accepted</option><option>Stain issue found</option><option>Delicate item flagged</option><option>Missing count mismatch</option><option>Damage risk flagged</option></select></div>
            <textarea name="message" placeholder="Garment/category notes, stain photos needed, item count mismatch, or special care instruction..." required />
            <button className="button primary full" type="submit">Save QR Intake</button>
            {formStatus["qr-bag-intake"] && <p className="status success">{formStatus["qr-bag-intake"]}</p>}
          </form>
          </div>
        </details>
      </section>
      <section className="section portalSection supportCreateSection manualSection">
        <details className="manualToolbox">
          <summary><div><span>Case Actions</span><small>Open a manual ticket only if the queue cannot resolve it</small></div><em>Secondary tools</em></summary>
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
      <section className="section driverSection portalSection manualSection">
        <details className="manualToolbox">
          <summary><div><span>Route Actions</span><small>Use these only for manual route updates or exceptions</small></div><em>Secondary tools</em></summary>
          <div className="driverGrid">
          <div className="driverChecklist operatorChips">
            <article><strong>Assignment</strong></article>
            <article><strong>ETA</strong></article>
            <article><strong>Handoff</strong></article>
            <article><strong>Delay</strong></article>
          </div>
          <form className="panel driverForm" onSubmit={(event) => submitLead(event, "driver-route-log")}>
            <h3>Update route status</h3>
            <div className="two"><input name="name" placeholder="Driver name" defaultValue={userName} required /><input name="email" type="email" placeholder="Driver email" defaultValue="driver@bubblewash.local" required /></div>
            <div className="two"><input name="phone" placeholder="Driver phone" required /><input name="company" placeholder="Bubble Wash route team" defaultValue="Bubble Wash Route Team" required /></div>
            <div className="two"><input name="orderId" placeholder="Shared Order ID e.g. BW-1234" required /><select name="orderStatus"><option>Driver en route</option><option>Pickup scheduled</option><option>Picked up</option><option>Dropped at vendor</option><option>Collected from vendor</option><option>Out for delivery</option><option>Delivered</option><option>Delayed</option></select></div>
            <div className="two"><input name="area" placeholder="Route area / customer area" /><input name="driverEta" placeholder="ETA e.g. 25 min / 3:20 PM" /></div>
            <div className="two"><input name="locationNote" placeholder="Checkpoint e.g. Spintex Road near Palace" /><input name="bagCount" placeholder="Bag count / kg" /></div>
            <textarea name="message" placeholder="Pickup note, vendor/customer handoff, delay reason, QR/photo reference, or delivery confirmation..." required />
            <button className="button primary full" type="submit">Save Driver Route Update</button>
            {formStatus["driver-route-log"] && <p className="status success">{formStatus["driver-route-log"]}</p>}
          </form>
          </div>
        </details>
      </section>
      <section className="section portalSection supportCreateSection manualSection">
        <details className="manualToolbox">
          <summary><div><span>Case Actions</span><small>Open a manual ticket only if the route queue cannot resolve it</small></div><em>Secondary tools</em></summary>
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
      setRecords(supportRecords.slice(0, 24));
      setOrders(ordersData.orders.slice(0, 12));
      setDeskStatus("Support desk updated.");
    } catch {
      setDeskStatus("Unable to load support desk.");
    }
  }

  useEffect(() => { loadSupportDesk(); }, []);

  return (
    <PortalShell role={role} pageRole="support" userName={userName} title="Support workspace">
      <SupportOpsOverview records={records} orders={orders} />
      <SupportOrderWatchlist orders={orders} />
      <SupportTicketDesk userName={userName} />
      <SharedOrderBoard role="support" userName={userName} />
      <section className="section portalSection supportCreateSection manualSection">
        <details className="manualToolbox">
          <summary><div><span>Case Actions</span><small>Open a manual ticket only when existing orders do not cover the case</small></div><em>Secondary tools</em></summary>
          <SupportTicketForm userName={userName} role="support" onSubmit={submitLead} status={formStatus["support-ticket"]} />
        </details>
      </section>
      <RecentActivity filter="support" />
      <p className="status supportDeskStatus">{deskStatus}</p>
    </PortalShell>
  );
}
