"use client";

import Link from "next/link";
import { FormEvent, ReactNode, useEffect, useState } from "react";
import type { StaffRole } from "@/lib/auth";

const adminQueues = [
  ["Intake", "New pickup requests, payment checks, and customer confirmation."],
  ["Dispatch", "Assign vendor, route, driver window, and promised delivery time."],
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
  area: string;
  vendor: string;
  status: string;
  payment: string;
  priority: string;
  nextStep: string;
  eventCount: number;
  lastEventType: string;
  timeline: Array<{ id: string; createdAt: string; type: string; status: string; actor: string; note: string }>;
};

const workflowStages = [
  ["01", "Admin receives", "Validate booking, route, payment preference, and customer notes."],
  ["02", "Admin assigns vendor", "Use one shared Order ID and assign the vendor before handoff."],
  ["03", "Vendor accepts", "Vendor updates capacity, QR/bag intake, item condition, and completion ETA."],
  ["04", "Driver + support sync", "Route updates, delivery status, and support issues attach to the same Order ID."],
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

function SharedOrderBoard({ role }: { role: StaffRole }) {
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
      <div className="activityHeader"><div><p className="eyebrow">Shared workflow board</p><h2>One Order ID across admin, vendor, support, and tracking.</h2><p>Research-backed fix: every team writes events to the same order timeline instead of creating disconnected records.</p></div><button className="button secondary" type="button" onClick={() => loadOrders()}>Refresh Board</button></div>
      <div className="workflowStages">{workflowStages.map(([step, title, copy]) => <article key={step}><b>{step}</b><h3>{title}</h3><p>{copy}</p></article>)}</div>
      <div className="orderBoardList">
        {orders.map((order) => <article className="orderBoardCard" key={order.orderId}>
          <div className="orderBoardTop"><strong>{order.orderId}</strong><span>{order.status}</span></div>
          <h3>{order.customer}</h3>
          <div className="orderMeta"><span>Vendor: {order.vendor}</span><span>Area: {order.area}</span><span>Payment: {order.payment}</span><span>Priority: {order.priority}</span><span>Events: {order.eventCount}</span><span>Updated: {new Date(order.updatedAt).toLocaleString()}</span></div>
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
  return (
    <main className="portalPage">
      <header className="portalNav">
        <Link className="brand" href="/"><span className="brandMark textMark">BW</span><span>Bubble Wash</span></Link>
        <nav className="portalLinks">
          <Link href="/admin">Admin</Link>
          <Link href="/vendors">Vendors</Link>
          <Link href="/support">Support</Link>
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
            <div className="two"><select name="actionType"><option>New order intake</option><option>Assign vendor</option><option>Update order status</option><option>Payment follow-up</option><option>Quality issue</option><option>Customer escalation</option></select><select name="orderStatus"><option>Received</option><option>Pickup scheduled</option><option>Vendor assigned</option><option>In washing</option><option>Ready for delivery</option><option>Delivered</option><option>Needs attention</option></select></div>
            <div className="two"><select name="priority"><option>Normal</option><option>High</option><option>Urgent</option></select><select name="paymentPreference"><option>Payment not confirmed</option><option>MTN MoMo</option><option>Telecel Cash</option><option>Card</option><option>Bank transfer</option><option>Invoice</option></select></div>
            <textarea name="message" placeholder="Action notes: customer, vendor, route, promised time, payment status, or quality issue..." required />
            <button className="button primary full" type="submit">Save Admin Action</button>
            {formStatus["admin-operation"] && <p className="status success">{formStatus["admin-operation"]}</p>}
          </form>
          <form className="panel opsForm routeLogForm" onSubmit={(event) => submitLead(event, "driver-route-log")}> 
            <h3>Driver route log</h3>
            <div className="two"><input name="name" placeholder="Driver / dispatcher" defaultValue={userName} required /><input name="email" type="email" placeholder="Dispatcher email" defaultValue="admin@bubblewash.local" required /></div>
            <div className="two"><input name="phone" placeholder="Driver phone" required /><input name="company" placeholder="Bubble Wash route team" defaultValue="Bubble Wash Route Team" required /></div>
            <div className="two"><input name="orderId" placeholder="Order ID" required /><select name="orderStatus"><option>Pickup scheduled</option><option>Driver en route</option><option>Picked up</option><option>Dropped at vendor</option><option>Collected from vendor</option><option>Delivered</option><option>Delayed</option></select></div>
            <div className="two"><input name="area" placeholder="Route area" /><input name="bagCount" placeholder="Bag count / kg" /></div>
            <textarea name="message" placeholder="ETA, location note, customer handoff, photo reference, or delay reason..." required />
            <button className="button secondary full" type="submit">Save Route Update</button>
            {formStatus["driver-route-log"] && <p className="status success">{formStatus["driver-route-log"]}</p>}
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
      <SharedOrderBoard role={role} />
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
      <SharedOrderBoard role={role} />
      <RecentActivity filter="vendor" />
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
      <SharedOrderBoard role={role} />
      <RecentActivity filter="support" />
    </PortalShell>
  );
}
