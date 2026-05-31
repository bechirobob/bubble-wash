"use client";

import Link from "next/link";
import Image from "next/image";
import { FormEvent, ReactNode, useEffect, useState } from "react";
import type { StaffRole } from "@/lib/auth";
import { automationActionsForOrder } from "@/lib/order-workflow";

const supportTypes = ["Pickup delay", "Payment issue", "Missing item", "Quality complaint", "Vendor escalation", "General question"];

type PortalShellProps = {
  title: string;
  eyebrow: string;
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

function rolePromise(role: StaffRole) {
  if (role === "admin") return { eyebrow: "Control room", title: "Exceptions. Dispatch. Closeout." };
  if (role === "vendor") return { eyebrow: "Vendor lane", title: "Accept. Wash. Ready." };
  if (role === "driver") return { eyebrow: "Route lane", title: "Pickup. Handoff. Deliver." };
  return { eyebrow: "Support lane", title: "Tickets. Escalations. Resolutions." };
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
    focusLabel: role === "admin" ? "needs dispatch" : role === "vendor" ? "ready for vendor" : role === "driver" ? "route actions" : "needs support",
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

function StageCountdown({ order }: { order: OrderSummary }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (!order.stageTimer.targetMinutes) {
    return <div className="slaPill timer-paused" aria-label="SLA timer complete"><span>SLA</span><b>Complete</b><small>{order.priority}</small></div>;
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
      <span>{label}</span>
      <b>{duration}</b>
      <small>{order.workflowStage.label} · {order.priority}</small>
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
      <div className="activityHeader"><div><p className="eyebrow">Availability</p><h2>Roster capacity</h2></div><button className="button secondary" type="button" onClick={() => loadAvailability()}>Refresh</button></div>
      <div className="orderBoardGrid">
        {vendors.slice(0, 6).map((vendor) => <article className="orderBoardCard" key={vendor.vendorId}><div className="orderBoardTop"><strong>{vendor.vendorName}</strong><span>{vendor.availabilityStatus}</span></div><div className="orderMeta"><span>Capacity: {vendor.capacityRemaining}</span><span>Zones: {vendor.serviceZones.join(", ") || "Any"}</span><span>Services: {vendor.serviceTypes.join(", ") || "Any"}</span></div><p>{vendor.notes || "No vendor note."}</p></article>)}
        {(role === "admin" || role === "driver") && drivers.slice(0, 6).map((driver) => <article className="orderBoardCard" key={driver.driverId}><div className="orderBoardTop"><strong>{driver.driverName}</strong><span>{driver.availabilityStatus}</span></div><div className="orderMeta"><span>Route slots: {driver.capacityRemaining}</span><span>Zones: {driver.serviceZones.join(", ") || "Any"}</span><span>Vehicle: {driver.vehicle || "Not set"}</span></div><p>{driver.notes || "No driver note."}</p></article>)}
      </div>
      {role === "admin" && declines.length > 0 && <div className="supportTicketList">{declines.slice(0, 4).map((decline) => <article className="orderBoardCard supportTicketCard" key={decline.id}><div className="orderBoardTop"><strong>{decline.orderId}</strong><span>Declined</span></div><p>{decline.vendorName}: {decline.reason}</p><div className="orderMeta"><span>By: {decline.declinedBy}</span><span>{new Date(decline.createdAt).toLocaleString()}</span></div></article>)}</div>}
      <p className="status">{status}</p>
    </section>
  );
}

function RecentActivity({ filter }: { filter?: string }) {
  const [records, setRecords] = useState<SubmissionRecord[]>([]);
  const [status, setStatus] = useState("Loading recent activity…");

  async function loadRecords(showLoading = true) {
    if (showLoading) setStatus("Loading recent activity…");
    const response = await fetch("/api/submissions");
    const data = await response.json();
    if (!response.ok || !data.ok) {
      setStatus(data.error ?? "Unable to load activity.");
      return;
    }
    const filtered = filter ? data.records.filter((record: SubmissionRecord) => String(record.data.submissionType ?? "").includes(filter)) : data.records;
    setRecords(filtered.slice(0, 8));
    setStatus(filtered.length ? "Recent activity loaded." : "No matching activity yet.");
  }

  useEffect(() => {
    async function loadInitialRecords() {
      const response = await fetch("/api/submissions");
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setStatus(data.error ?? "Unable to load activity.");
        return;
      }
      const filtered = filter ? data.records.filter((record: SubmissionRecord) => String(record.data.submissionType ?? "").includes(filter)) : data.records;
      setRecords(filtered.slice(0, 8));
      setStatus(filtered.length ? "Recent activity loaded." : "No matching activity yet.");
    }
    loadInitialRecords();
  }, [filter]);

  return (
    <section className="section activitySection">
      <div className="activityHeader"><div><p className="eyebrow">Live activity</p><h2>Recent saved requests</h2></div><button className="button secondary" type="button" onClick={() => loadRecords()}>Refresh</button></div>
      <div className="activityList">
        {records.map((record) => <article className="activityCard" key={record.id}><strong>{record.id}</strong><span>{record.data.submissionType}</span><p>{record.data.company || record.data.name || "Bubble Wash request"}</p><small>{new Date(record.createdAt).toLocaleString()}</small></article>)}
      </div>
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
    try {
      const data = await postJSON<{ ok: boolean; message: string; id: string; nextStatus: string }>("/api/orders/advance", { orderId: order.orderId, actionKey: action.key });
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
      <div className="staffCommandHeader">
        <div>
          <p className="eyebrow">Live command board</p>
          <h2>{stats.focusCount ? `${stats.focusCount} ${stats.focusLabel}` : "No urgent moves right now"}</h2>
        </div>
        <button className="button secondary" type="button" onClick={() => loadOrders()}>Refresh</button>
      </div>
      <div className="queueMetricGrid" aria-label="Queue summary">
        <article><span>{stats.focusLabel}</span><strong>{stats.focusCount}</strong></article>
        <article><span>next actions</span><strong>{stats.automationCount}</strong></article>
        <article><span>risk / SLA</span><strong>{stats.riskCount}</strong></article>
        <article><span>last refresh</span><strong>{orders[0] ? formatMetricTime(orders[0].updatedAt) : "—"}</strong></article>
      </div>
      <div className="orderBoardList compactOrders">
        {visibleOrders.map((order) => <article className={`orderBoardCard compactOrderCard timer-${order.stageTimer.tone}`} key={order.orderId}>
          <div className="orderBoardTop"><strong>{order.orderId}</strong><span>{order.workflowStage.label}</span></div>
          <div className="orderFocusRow">
            <div>
              <h3>{order.customer}</h3>
              <div className="operatorFacts"><span>{order.phone || "No phone"}</span><span>{order.email || "No email"}</span><span>{order.eventCount} events</span></div>
            </div>
            <StageCountdown order={order} />
          </div>
          <div className="orderMeta minimalMeta"><span>{order.area}</span><span>{order.routeWindow}</span><span>{order.vendor}</span><span>{order.driver}</span><span>{order.payment}</span></div>
          <AutomatedOrderActions order={order} role={role} userName={userName} onSaved={() => loadOrders(false)} />
          <div className="mapActions"><a className="button secondary" href={order.route.directionsUrl} target="_blank" rel="noreferrer">Route</a><a className="button secondary" href={order.route.googleMapsUrl} target="_blank" rel="noreferrer">Area</a></div>
          <details className="quietDetails"><summary>Timeline and full context</summary><div className="timelineList">{order.timeline.slice(0, 5).map((event) => <div key={`${order.orderId}-${event.id}-${event.createdAt}`}><b>{event.status}</b><span>{event.type} · {event.actor} · {formatShortTime(event.createdAt)}</span><p>{event.note}</p></div>)}</div></details>
        </article>)}
      </div>
      <p className="status">{role.toUpperCase()} view · {status}</p>
    </section>
  );
}

async function postJSON<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

function PortalShell({ title, eyebrow, role, pageRole = role, userName, children }: PortalShellProps) {
  const pageHome = pageRole === "admin" ? "/admin" : pageRole === "vendor" ? "/vendors" : pageRole === "driver" ? "/drivers" : "/support";
  const portalLinks = role === "admin"
    ? [["/admin", "Admin home"], ["/vendors", "Vendor lane"], ["/drivers", "Driver lane"], ["/support", "Support lane"]]
    : pageRole === "vendor" ? [["/vendors", "Vendor workspace"]]
    : pageRole === "driver" ? [["/drivers", "Driver workspace"]]
    : [["/support", "Support desk"]];
  const promise = rolePromise(pageRole);

  async function logoutStaff() {
    try {
      await fetch("/api/logout", { method: "POST", cache: "no-store" });
    } finally {
      window.location.replace("/login");
    }
  }

  return (
    <main className="portalPage">
      <header className="portalNav">
        <Link className="brand" href="/" aria-label="Bubble Wash home"><Image className="brandMark" src="/bubble-wash-icon.jpg" alt="Bubble Wash logo" width={58} height={58} /><span>Bubble Wash</span></Link>
        <nav className="portalLinks">
          {portalLinks.map(([href, label]) => <Link key={href} href={href} aria-current={href === pageHome ? "page" : undefined}>{label}</Link>)}
          <button className="button secondary logoutButton" type="button" onClick={logoutStaff}>Logout</button>
        </nav>
      </header>
      <section className="section portalHero">
        <div>
          <p className="eyebrow">{promise.eyebrow}</p>
          <h1>{promise.title}</h1>
          <div className="roleBreadcrumb"><Link href={pageHome}>Current lane</Link><span>{eyebrow}</span><span>{title}</span></div>
        </div>
        <aside className="portalIdentity">
          <span>Signed in</span>
          <strong>{userName}</strong>
          <small>{role.toUpperCase()} access · viewing {pageRole.toUpperCase()}</small>
        </aside>
      </section>
      <section className="section workflowMapSection" aria-label="Staff workflow overview">
        <div className="workflowMapHeader">
          <p className="eyebrow">Automation-first workflow</p>
          <h2>One Order ID moves through every lane.</h2>
          <p>Customer booking is the source of truth. Staff should use the action rail first; manual forms are only for exceptions, capacity changes, or notes that did not come from the customer order.</p>
        </div>
        <div className="workflowStepRail" aria-label="Order workflow stages">
          <span>Received</span><span>Schedule</span><span>Assign</span><span>Accept</span><span>Pickup</span><span>Wash</span><span>Ready</span><span>Deliver</span><span>Close</span>
        </div>
        <div className="workflowPrinciples">
          <article><strong>Inherited context</strong><span>Name, phone, area, route window, payment, vendor, and driver stay attached.</span></article>
          <article><strong>Action rail first</strong><span>Buttons append the next valid event server-side instead of asking staff to retype the order.</span></article>
          <article><strong>Exceptions only</strong><span>Manual tools stay collapsed for declines, delays, count mismatches, payment issues, or support cases.</span></article>
        </div>
      </section>
      {children}
    </main>
  );
}


function SupportTicketForm({ userName, role, onSubmit, status }: { userName: string; role: StaffRole; onSubmit: SubmitHandler; status?: string }) {
  return (
    <form className="panel supportForm" onSubmit={(event) => onSubmit(event, "support-ticket")}>
      <h3>Create support ticket</h3>
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
      <div className="activityHeader"><div><p className="eyebrow">Ticket desk</p><h2>Open tickets</h2></div><button className="button secondary" type="button" onClick={() => loadTickets()}>Refresh</button></div>
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
    <PortalShell role={role} userName={userName} eyebrow="Admin operations" title="Admin dashboard">
      <section className="section opsSection portalSection manualSection">
        <details className="manualToolbox">
          <summary><span>Exception tools</span><small>Admin</small></summary>
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
          <form className="panel opsForm routeLogForm" onSubmit={(event) => submitLead(event, "driver-onboarding")}>
            <h3>Onboard driver</h3>
            <div className="two"><input name="name" placeholder="Driver full name" required /><input name="email" type="email" placeholder="Driver email" required /></div>
            <div className="two"><input name="phone" placeholder="Driver phone / WhatsApp" required /><input name="company" placeholder="Route team / contractor" defaultValue="Bubble Wash Route Team" required /></div>
            <div className="two"><input name="area" placeholder="Primary route zones e.g. Osu, Labone" /><input name="vehicle" placeholder="Vehicle / bike ID" /></div>
            <div className="two"><input name="routeCapacity" inputMode="numeric" placeholder="Route slots today e.g. 4" defaultValue="4" /><select name="driverStatus"><option>Active</option><option>Training</option><option>Inactive</option><option>Suspended</option></select></div>
            <div className="two"><select name="availability"><option>Available today</option><option>Available tomorrow</option><option>Limited route capacity</option><option>Paused today</option></select><input name="serviceZones" placeholder="Backup zones e.g. Airport, Cantonments" /></div>
            <textarea name="message" placeholder="License check, ID check, route restrictions, emergency contact, or onboarding notes..." required />
            <button className="button secondary full" type="submit">Save Driver Onboarding</button>
            {formStatus["driver-onboarding"] && <p className="status success">{formStatus["driver-onboarding"]}</p>}
          </form>
          <form className="panel opsForm inventoryLogForm" onSubmit={(event) => submitLead(event, "linen-inventory-log")}> 
            <h3>Commercial linen inventory</h3>
            <div className="two"><input name="name" placeholder="Inventory operator" defaultValue={userName} required /><input name="email" type="email" placeholder="Operator email" defaultValue="admin@bubblewash.local" required /></div>
            <div className="two"><input name="phone" placeholder="Operator phone" required /><input name="company" placeholder="Client / property name" required /></div>
            <div className="two"><input name="orderId" placeholder="Order or account ID" /><select name="itemCategory"><option>Towels</option><option>Bedsheets</option><option>Uniforms</option><option>Table linen</option><option>Medical gowns</option><option>Mixed inventory</option></select></div>
            <div className="two"><input name="countReceived" placeholder="Count received" /><input name="countReturned" placeholder="Count returned / expected" /></div>
            <textarea name="message" placeholder="Shortage notes, damaged items, replacement action, or invoice adjustment..." />
            <button className="button primary full" type="submit">Log Linen Count</button>
            {formStatus["linen-inventory-log"] && <p className="status success">{formStatus["linen-inventory-log"]}</p>}
          </form>
          </div>
        </details>
      </section>
      <section className="section portalSection supportCreateSection manualSection">
        <details className="manualToolbox">
          <summary><span>Raise ticket</span><small>Exception</small></summary>
          <SupportTicketForm userName={userName} role="admin" onSubmit={submitLead} status={formStatus["support-ticket"]} />
        </details>
      </section>
      <SharedOrderBoard role={role} userName={userName} />
      <AvailabilityBoard role={role} />
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
    <PortalShell role={role} pageRole="vendor" userName={userName} eyebrow="Vendor operations" title="Vendor dashboard">
      <section className="section vendorSection dark portalSection manualSection">
        <details className="manualToolbox">
          <summary><span>Exception tools</span><small>Vendor</small></summary>
          <div className="vendorGrid">
          <form className="panel vendorForm" onSubmit={(event) => submitLead(event, "vendor-application")}>
            <h3>Register / update vendor capacity</h3>
            <div className="two"><input name="name" placeholder="Contact name" defaultValue={userName} required /><input name="email" type="email" placeholder="Email" defaultValue="vendor@bubblewash.local" required /></div>
            <div className="two"><input name="phone" placeholder="Phone / WhatsApp" required /><input name="company" placeholder="Laundromat name" required /></div>
            <div className="two"><input name="area" placeholder="Service zones e.g. Osu, Labone" /><input name="capacity" inputMode="numeric" placeholder="Order slots today e.g. 8" /></div>
            <div className="two"><select name="availability"><option>Available today</option><option>Available tomorrow</option><option>Limited capacity</option><option>Paused today</option></select><select name="services"><option>Wash + fold</option><option>Wash + iron + fold</option><option>Ironing only</option><option>Express capable</option><option>Bulk commercial</option></select></div>
            <textarea name="message" placeholder="Machines available, turnaround time, pickup limits, delivery support, service notes..." />
            <button className="button primary full" type="submit">Save Vendor Capacity</button>
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
          <summary><span>Raise ticket</span><small>Exception</small></summary>
          <SupportTicketForm userName={userName} role="vendor" onSubmit={submitLead} status={formStatus["support-ticket"]} />
        </details>
      </section>
      <SharedOrderBoard role="vendor" userName={userName} />
      <AvailabilityBoard role="vendor" />
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
    <PortalShell role={role} pageRole="driver" userName={userName} eyebrow="Driver operations" title="Driver route board">
      <section className="section driverSection portalSection manualSection">
        <details className="manualToolbox">
          <summary><span>Exception tools</span><small>Route</small></summary>
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
          <summary><span>Raise ticket</span><small>Exception</small></summary>
          <SupportTicketForm userName={userName} role="driver" onSubmit={submitLead} status={formStatus["support-ticket"]} />
        </details>
      </section>
      <SharedOrderBoard role="driver" userName={userName} />
      <AvailabilityBoard role="driver" />
      <RecentActivity filter="driver-route-log" />
    </PortalShell>
  );
}

export function SupportWorkspace({ userName, role }: { userName: string; role: StaffRole }) {
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
    <PortalShell role={role} pageRole="support" userName={userName} eyebrow="Support desk" title="Support dashboard">
      <section className="section supportSection portalSection">
        <div className="supportGrid">
          <form className="panel supportForm" onSubmit={(event) => submitLead(event, "support-ticket")}>
            <h3>Open support ticket</h3>
            <div className="two"><input name="name" placeholder="Your name" defaultValue={userName} required /><input name="email" type="email" placeholder="Email" defaultValue="support@bubblewash.local" required /></div>
            <div className="two"><input name="phone" placeholder="Phone / WhatsApp" required /><input name="company" placeholder="Company / household / vendor" required /></div>
            <div className="two"><input name="orderId" placeholder="Order ID if available" /><select name="issueType">{supportTypes.map((item) => <option key={item}>{item}</option>)}</select></div>
            <div className="two"><select name="priority"><option>Normal</option><option>High</option><option>Urgent</option></select><select name="preferredContact"><option>WhatsApp</option><option>Phone call</option><option>Email</option></select></div>
            <textarea name="message" placeholder="What happened? Include pickup area, time, items affected, photos requested, or payment reference..." required />
            <button className="button primary full" type="submit">Create Support Ticket</button>
            {formStatus["support-ticket"] && <p className="status success">{formStatus["support-ticket"]}</p>}
          </form>
          <div className="supportRules operatorChips">
            <article><strong>Pickup delay</strong></article>
            <article><strong>Missing item</strong></article>
            <article><strong>Quality issue</strong></article>
            <article><strong>Payment issue</strong></article>
          </div>
        </div>
      </section>
      <SupportTicketDesk userName={userName} />
      <SharedOrderBoard role="support" userName={userName} />
      <RecentActivity filter="support" />
    </PortalShell>
  );
}
