"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";

type CustomerOrder = {
  orderId: string; customer: string; createdAt: string; updatedAt: string; status: string; nextStep: string;
  area: string; pickupAddress: string; service: string; pickupDate: string; pickupWindow: string;
  timeline: Array<{ createdAt: string; status: string; type: string }>;
};

export function CustomerOrderManager() {
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [status, setStatus] = useState("Use the same email or phone entered when the booking was made.");
  const [pending, setPending] = useState(false);

  async function access(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/customer/access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) });
    const body = await response.json();
    setPending(false);
    if (!response.ok) return setStatus(body.error ?? "Unable to verify this booking.");
    setOrder(body.order);
    setStatus("Booking verified.");
  }

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/customer/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) });
    const body = await response.json();
    setPending(false);
    setStatus(body.message ?? body.error ?? "Unable to save this request.");
    if (response.ok) event.currentTarget.reset();
  }

  async function close() {
    await fetch("/api/customer/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    setOrder(null);
    setStatus("Your order session is closed on this device.");
  }

  if (!order) return <form className="serviceForm manageAccessForm" onSubmit={access}><div className="formGrid two"><label>Booking reference<input name="orderId" placeholder="BW-…" autoComplete="off" required /></label><label>Booking email or phone<input name="contact" autoComplete="email" required /></label></div><button className="button primary" type="submit" disabled={pending}>{pending ? "Verifying…" : "Open my order"}</button><p className="status" role="status">{status}</p></form>;

  return <div className="customerManageGrid"><section className="servicePanel customerOrderSummary"><div className="sectionHeading"><div><p className="sectionLabel">{order.orderId}</p><h2>{order.customer}, here is your order.</h2></div><button className="textButton" type="button" onClick={close}>Close session</button></div><dl className="recordList"><div><dt>Status</dt><dd>{order.status}</dd></div><div><dt>Next step</dt><dd>{order.nextStep}</dd></div><div><dt>Service</dt><dd>{order.service}</dd></div><div><dt>Pickup</dt><dd>{[order.pickupDate, order.pickupWindow].filter(Boolean).join(" · ") || "Confirmation pending"}</dd></div><div><dt>Location</dt><dd>{order.pickupAddress || order.area}</dd></div></dl><h3>Order history</h3><div className="customerTimeline">{order.timeline.map((event, index) => <div key={`${event.createdAt}-${index}`}><time>{new Date(event.createdAt).toLocaleString()}</time><strong>{event.status}</strong></div>)}</div></section><form className="serviceForm customerRequestForm" onSubmit={submitRequest}><p className="sectionLabel">Request a change</p><h2>Send operations a clear instruction.</h2><label>Request<select name="action" defaultValue="reschedule"><option value="reschedule">Reschedule pickup</option><option value="cancel">Request cancellation</option><option value="care">Add a garment-care note</option></select></label><div className="formGrid two"><label>Requested date <small>For rescheduling</small><input name="requestedDate" type="date" min={new Date().toISOString().slice(0, 10)} /></label><label>Preferred window <small>Optional</small><input name="requestedWindow" placeholder="Morning, afternoon…" maxLength={80} /></label></div><label>Details<textarea name="note" maxLength={600} required placeholder="Tell operations exactly what should change." /></label><button className="button primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Send request"}</button><p className="status" role="status">{status}</p><small>Requests do not change or cancel an order until Bubble Wash confirms them.</small></form><p><Link href="/privacy">Privacy and data rights</Link></p></div>;
}
