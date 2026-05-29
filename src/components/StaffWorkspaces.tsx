"use client";

import Link from "next/link";
import Image from "next/image";
import { FormEvent, ReactNode, useEffect, useState } from "react";
import type { StaffRole } from "@/lib/auth";
import { automationActionsForOrder } from "@/lib/order-workflow";

const adminQueues = [
  ["Intake", "New pickup requests, payment checks, and customer confirmation."],
  ["Dispatch", "Auto-assign vendor from capacity, attach admin-onboarded drivers, and review every handoff."],
  ["Quality", "Log washing issues, missing items, stain escalations, and rework."],
];

const supportTypes = ["Pickup delay", "Payment issue", "Missing item", "Quality complaint", "Vendor escalation", "General question"];

type PortalShellProps = {
  title: string;
  eyebrow: string;
  description: string;
  role: StaffRole;
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

type AutomationAction = ReturnType<typeof automationActionsForOrder>[number];

const workflowStages = [
  ["01", "Received → Pickup Scheduled", "Admin validates the original booking once, then schedules pickup from inherited customer data."],
  ["02", "Auto-assign → Vendor accepts/declines", "Admin can auto-assign from vendor capacity and the driver roster; vendors accept or decline without retyping order context."],
  ["03", "Driver Route → At Vendor", "Driver route, pickup, and vendor drop-off actions append checkpoints to the same Order ID."],
  ["04", "Washing → Ready → Delivered", "Vendor and driver move the order through production and return delivery; support handles only exceptions."],
];

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
    setStatus(`Running ${action.label.toLowerCase()}…`);
    try {
      const data = await postJSON<{ ok: boolean; message: string; id: string; nextStatus: string }>("/api/orders/advance", { orderId: order.orderId, actionKey: action.key });
      setStatus(`${data.message} Automation event: ${data.id}. Next: ${data.nextStatus}`);
      await onSaved();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to run automation.");
    } finally {
      setPendingLabel("");
    }
  }

  return (
    <div className="automationPanel">
      <div>
        <b>Automation shortcuts</b>
        <span>No retyping: these actions reuse the original order data and append the next event to this timeline.</span>
      </div>
      <div className="automationActions">
        {actions.length ? actions.map((action) => <button className="button secondary" disabled={Boolean(pendingLabel)} key={action.label} onClick={() => run(action)} title={action.description} type="button">{pendingLabel === action.label ? "Working…" : action.label}</button>) : <span className="status">No safe automated action for this role at the current stage.</span>}
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
    setStatus(data.orders.length ? "Shared order board loaded from the same event log." : "No shared orders yet.");
  }

  useEffect(() => {
    let active = true;
    fetch("/api/orders")
      .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
      .then(({ ok, data }) => {
        if (!active) return;
        if (!ok || !data.ok) {
          setStatus(data.error ?? "Unable to load shared orders.");
          return;
        }
        setOrders(data.orders.slice(0, 10));
        setStatus(data.orders.length ? "Shared order board loaded from the same event log." : "No shared orders yet.");
      })
      .catch(() => {
        if (active) setStatus("Unable to load shared orders.");
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="section sharedBoardSection">
      <div className="activityHeader"><div><p className="eyebrow">Automation workflow board</p><h2>One order entry feeds admin, vendor, driver, support, and tracking.</h2><p>Customer booking data now follows the order. Staff use one-click workflow actions instead of retyping details that already exist.</p></div><button className="button secondary" type="button" onClick={() => loadOrders()}>Refresh Board</button></div>
      <div className="workflowStages">{workflowStages.map(([step, title, copy]) => <article key={step}><b>{step}</b><h3>{title}</h3><p>{copy}</p></article>)}</div>
      <div className="orderBoardList">
        {orders.map((order) => <article className="orderBoardCard" key={order.orderId}>
          <div className="orderBoardTop"><strong>{order.orderId}</strong><span>{order.workflowStage.label}</span></div>
          <h3>{order.customer}</h3>
          <div className="orderMeta"><span>Status detail: {order.status}</span><span>Vendor: {order.vendor}</span><span>Driver: {order.driver}</span><span>ETA/window: {order.routeWindow}</span><span>Timer: {order.stageTimer.label}</span><span>Driver note: {order.locationNote}</span><span>Area: {order.area}</span><span>Payment: {order.payment}</span><span>Priority: {order.priority}</span><span>Events: {order.eventCount}</span><span>Updated: {new Date(order.updatedAt).toLocaleString()}</span></div>
          <div className="mapActions"><a className="button secondary" href={order.route.directionsUrl} target="_blank" rel="noreferrer">Open Route</a><a className="button secondary" href={order.route.googleMapsUrl} target="_blank" rel="noreferrer">View Area</a></div>
          <AutomatedOrderActions order={order} role={role} userName={userName} onSaved={() => loadOrders(false)} />
          <p>{order.nextStep}</p>
          <details><summary>Timeline</summary><div className="timelineList">{order.timeline.slice(0, 5).map((event) => <div key={`${order.orderId}-${event.id}-${event.createdAt}`}><b>{event.status}</b><span>{event.type} · {event.actor} · {new Date(event.createdAt).toLocaleString()}</span><p>{event.note}</p></div>)}</div></details>
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

function PortalShell({ title, eyebrow, description, role, userName, children }: PortalShellProps) {
  const portalLinks = role === "admin" ? [["/admin", "Admin"], ["/vendors", "Vendors"], ["/drivers", "Drivers"], ["/support", "Support"]] : role === "vendor" ? [["/vendors", "Vendor workspace"]] : role === "driver" ? [["/drivers", "Driver workspace"]] : [["/support", "Support desk"]];
  return (
    <main className="portalPage">
      <header className="portalNav">
        <Link className="brand" href="/" aria-label="Bubble Wash home"><Image className="brandMark" src="/bubble-wash-icon.jpg" alt="Bubble Wash logo" width={58} height={58} /><span>Bubble Wash</span></Link>
        <nav className="portalLinks">
          {portalLinks.map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}
          <a className="button secondary" href="/api/logout">Logout</a>
        </nav>
      </header>
      <section className="section portalHero">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p className="lead">{description}</p>
        </div>
        <aside className="portalIdentity">
          <span>Signed in</span>
          <strong>{userName}</strong>
          <small>{role.toUpperCase()} access</small>
        </aside>
      </section>
      {children}
    </main>
  );
}


function SupportTicketForm({ userName, role, onSubmit, status }: { userName: string; role: StaffRole; onSubmit: SubmitHandler; status?: string }) {
  return (
    <form className="panel supportForm" onSubmit={(event) => onSubmit(event, "support-ticket")}>
      <h3>Create support ticket</h3>
      <p className="formHint">Use this when an order needs help from support. Support can attend, assign, escalate, de-escalate, or resolve it from the ticket desk.</p>
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
      <div className="activityHeader"><div><p className="eyebrow">Ticket command desk</p><h2>Attend, assign, escalate, de-escalate, and resolve support tickets.</h2><p>Tickets raised by admin, vendors, drivers, and support land here with the related Order ID.</p></div><button className="button secondary" type="button" onClick={() => loadTickets()}>Refresh Tickets</button></div>
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
    <PortalShell role={role} userName={userName} eyebrow="Admin operations" title="Admin dashboard" description="A dedicated control room for intake, dispatch, payments, priority changes, and quality checks.">
      <section className="section opsSection portalSection">
        <div className="opsGrid">
          <div className="opsBoard">
            {adminQueues.map(([title, copy]) => <article key={title}><h3>{title}</h3><p>{copy}</p></article>)}
          </div>
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
            <p className="formHint">Drivers do not self-onboard. Admin adds the route roster, then automated dispatch can attach active drivers to orders.</p>
            <div className="two"><input name="name" placeholder="Driver full name" required /><input name="email" type="email" placeholder="Driver email" required /></div>
            <div className="two"><input name="phone" placeholder="Driver phone / WhatsApp" required /><input name="company" placeholder="Route team / contractor" defaultValue="Bubble Wash Route Team" required /></div>
            <div className="two"><input name="area" placeholder="Primary route area e.g. Osu, Labone" /><input name="vehicle" placeholder="Vehicle / bike ID" /></div>
            <div className="two"><select name="driverStatus"><option>Active</option><option>Training</option><option>Inactive</option><option>Suspended</option></select><select name="availability"><option>Available today</option><option>Available tomorrow</option><option>Limited route capacity</option><option>Paused today</option></select></div>
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
      </section>
      <section className="section portalSection supportCreateSection">
        <SupportTicketForm userName={userName} role={role} onSubmit={submitLead} status={formStatus["support-ticket"]} />
      </section>
      <SharedOrderBoard role={role} userName={userName} />
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
    <PortalShell role={role} userName={userName} eyebrow="Vendor operations" title="Vendor dashboard" description="A separate lane for laundromat partners to report capacity, accept work, and update job status.">
      <section className="section vendorSection dark portalSection">
        <div className="vendorGrid">
          <form className="panel vendorForm" onSubmit={(event) => submitLead(event, "vendor-application")}>
            <h3>Register / update vendor capacity</h3>
            <div className="two"><input name="name" placeholder="Contact name" defaultValue={userName} required /><input name="email" type="email" placeholder="Email" defaultValue="vendor@bubblewash.local" required /></div>
            <div className="two"><input name="phone" placeholder="Phone / WhatsApp" required /><input name="company" placeholder="Laundromat name" required /></div>
            <div className="two"><input name="area" placeholder="Operating area" /><input name="capacity" placeholder="Today capacity e.g. 200kg" /></div>
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
      </section>
      <section className="section portalSection supportCreateSection">
        <SupportTicketForm userName={userName} role={role} onSubmit={submitLead} status={formStatus["support-ticket"]} />
      </section>
      <SharedOrderBoard role={role} userName={userName} />
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
    <PortalShell role={role} userName={userName} eyebrow="Driver operations" title="Driver route board" description="A focused route workflow for pickup, vendor handoff, customer ETA, and delivery updates without exposing live GPS before consent is ready.">
      <section className="section driverSection portalSection">
        <div className="driverGrid">
          <div className="driverChecklist">
            <article><strong>1. Confirm assignment</strong><span>Use the shared Order ID from dispatch. Do not create a second order.</span></article>
            <article><strong>2. Share ETA</strong><span>Update pickup/delivery window before moving, especially when traffic changes.</span></article>
            <article><strong>3. Log handoff</strong><span>Record bag count, vendor/customer handoff, and any photo or QR reference.</span></article>
            <article><strong>4. Escalate delays</strong><span>Mark delayed early so support can notify the customer before they chase.</span></article>
          </div>
          <form className="panel driverForm" onSubmit={(event) => submitLead(event, "driver-route-log")}>
            <h3>Update route status</h3>
            <p className="formHint">Pilot-safe driver workflow: manual ETA/checkpoint updates now; browser GPS only after explicit driver opt-in and production privacy rules.</p>
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
      </section>
      <section className="section portalSection supportCreateSection">
        <SupportTicketForm userName={userName} role={role} onSubmit={submitLead} status={formStatus["support-ticket"]} />
      </section>
      <SharedOrderBoard role={role} userName={userName} />
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
    <PortalShell role={role} userName={userName} eyebrow="Support desk" title="Support dashboard" description="Customer, vendor, payment, and delivery issues now have their own ticket page after login.">
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
          <div className="supportRules">
            <article><strong>Pickup delay</strong><span>Confirm driver, update ETA, notify customer.</span></article>
            <article><strong>Missing item</strong><span>Check bag count, vendor intake notes, and delivery handoff.</span></article>
            <article><strong>Quality issue</strong><span>Log photos, approve rewash, assign vendor correction.</span></article>
            <article><strong>Payment issue</strong><span>Confirm method, reference, invoice, and receipt status.</span></article>
          </div>
        </div>
      </section>
      <SupportTicketDesk userName={userName} />
      <SharedOrderBoard role={role} userName={userName} />
      <RecentActivity filter="support" />
    </PortalShell>
  );
}
