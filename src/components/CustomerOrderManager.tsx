"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

type CustomerOrder = {
  orderId: string; customer: string; createdAt: string; updatedAt: string; status: string; nextStep: string;
  area: string; pickupAddress: string; plan: string; service: string; pickupDate: string; pickupWindow: string;
  invoice?: { invoiceId: string; lines: Array<{ label: string; amountMinor: number }>; balanceMinor: number; status: string };
  timeline: Array<{ createdAt: string; status: string; type: string }>;
};

export function CustomerOrderManager() {
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [status, setStatus] = useState("Use the same email or phone entered when the booking was made.");
  const [pending, setPending] = useState(false);

  const [references, setReferences] = useState<Array<{ orderId: string; createdAt: string }>>([]);
  const [deliveryCode, setDeliveryCode] = useState("");
  useEffect(() => {
    let active = true;
    const recoveryToken = new URLSearchParams(window.location.hash.slice(1)).get("recovery");
    if (recoveryToken) window.history.replaceState(null, "", window.location.pathname);
    const recoveryOptions = recoveryToken ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: recoveryToken }) } : {};
    fetch(recoveryToken ? "/api/customer/recover" : "/api/customer/order", { ...recoveryOptions, cache: "no-store" }).then(async (response) => {
      if (active) { const data = await response.json(); if (active && response.ok) { setOrder(data.order); setReferences(data.references || []); } else if (active && recoveryToken) setStatus(data.error || "Recovery link could not be verified."); }
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  async function perform(url: string, payload: Record<string, unknown>, done: (body: Record<string, unknown>) => void) {
    setPending(true);
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
      const body = await response.json();
      if (!response.ok) { if (response.status === 401) setOrder(null); throw new Error(body.error || "Unable to complete this request."); }
      done(body);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Connection interrupted. Please try again."); }
    finally { setPending(false); }
  }
  async function access(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await perform("/api/customer/access", Object.fromEntries(new FormData(event.currentTarget)), (body) => { setOrder(body.order as CustomerOrder); setStatus("Booking verified."); });
  }
  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    await perform("/api/customer/request", Object.fromEntries(new FormData(form)), (body) => { setStatus(String(body.message)); form.reset(); });
  }
  async function close() {
    await perform("/api/customer/logout", {}, () => { setOrder(null); setDeliveryCode(""); setStatus("Your order session is closed on this device."); });
  }
  async function payInvoice() {
    if (!order) return;
    await perform("/api/payments/initialize", { orderId: order.orderId }, (body) => { window.location.assign((body.payment as { authorizationUrl: string }).authorizationUrl); });
  }
  async function recoverCode() {
    await perform("/api/customer/delivery-code", {}, (body) => { setDeliveryCode(String(body.deliveryCode)); setStatus("New handoff code created. Your previous code no longer works."); });
  }

  async function recoverReference(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); await perform("/api/customer/recover", Object.fromEntries(new FormData(event.currentTarget)), (body) => setStatus(String(body.message)));
  }
  const recoveryForm = <details className="invoicePanel"><summary>Recover a lost reference or handoff code</summary><form onSubmit={recoverReference}><label>Booking email<input name="email" type="email" autoComplete="email" required /></label><button className="button secondary" disabled={pending}>Send recovery link</button></form><p>A single-use link verifies access to your booking email.</p></details>;
  if (!order) return <><form className="serviceForm manageAccessForm" onSubmit={access}><div className="formGrid two"><label>Booking reference<input name="orderId" placeholder="BW-…" autoComplete="off" required /></label><label>Booking email or phone<input name="contact" autoComplete="email" required /></label></div><button className="button primary" type="submit" disabled={pending}>{pending ? "Verifying…" : "Open my order"}</button><p className="status" role="status">{status}</p></form>{recoveryForm}</>;

  return <div className="customerManageGrid"><section className="servicePanel customerOrderSummary"><div className="sectionHeading"><div><p className="sectionLabel">{order.orderId}</p><h2>{order.customer}, here is your order.</h2></div><button className="textButton" type="button" onClick={close}>Close session</button></div><dl className="recordList"><div><dt>Status</dt><dd>{order.status}</dd></div><div><dt>Next step</dt><dd>{order.nextStep}</dd></div><div><dt>Plan</dt><dd>{order.plan || "Not recorded"}</dd></div><div><dt>Service</dt><dd>{order.service}</dd></div><div><dt>Pickup</dt><dd>{[order.pickupDate, order.pickupWindow].filter(Boolean).join(" · ") || "Confirmation pending"}</dd></div><div><dt>Location</dt><dd>{order.pickupAddress || order.area}</dd></div></dl>{order.invoice ? <section><h3>Invoice {order.invoice.invoiceId}</h3><dl className="recordList">{order.invoice.lines.map((line, index) => <div key={index}><dt>{line.label}</dt><dd>GHS {(line.amountMinor / 100).toFixed(2)}</dd></div>)}<div><dt>Balance · {order.invoice.status}</dt><dd>GHS {(order.invoice.balanceMinor / 100).toFixed(2)}</dd></div></dl>{order.invoice.balanceMinor > 0 && process.env.NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED === "true" ? <button className="button primary" type="button" disabled={pending} onClick={payInvoice}>Pay outstanding balance</button> : null}</section> : <p>Your itemized invoice will appear after verified intake.</p>}<button className="button secondary" type="button" disabled={pending} onClick={recoverCode}>Replace lost handoff code</button>{deliveryCode ? <p className="deliveryCode"><strong>{deliveryCode}</strong><small>Give this code to the rider only after receiving your clean laundry.</small></p> : null}{recoveryForm}{references.length > 1 ? <section><h3>Your booking references</h3>{references.map((ref) => <p key={ref.orderId}>{ref.orderId} · {new Date(ref.createdAt).toLocaleDateString()}</p>)}</section> : null}<h3>Order history</h3><div className="customerTimeline">{order.timeline.map((event, index) => <div key={`${event.createdAt}-${index}`}><time>{new Date(event.createdAt).toLocaleString()}</time><strong>{event.status}</strong></div>)}</div></section><form className="serviceForm customerRequestForm" onSubmit={submitRequest}><p className="sectionLabel">Request a change</p><h2>How can we help?</h2><label>Request<select name="action" defaultValue="reschedule"><option value="reschedule">Reschedule pickup</option><option value="cancel">Request cancellation</option><option value="quality">Report a quality issue</option><option value="damage">Report loss or damage</option><option value="refund">Request a refund</option><option value="care">Add a garment-care note</option></select></label><div className="formGrid two"><label>New pickup date <small>For rescheduling</small><input name="requestedDate" type="date" min={new Date().toISOString().slice(0, 10)} /></label><label>New pickup window <small>For rescheduling</small><select name="requestedWindow" defaultValue=""><option value="">Select a pickup window</option><option>8:00–10:00</option><option>10:00–12:00</option><option>12:00–14:00</option><option>14:00–16:00</option><option>16:00–18:00</option></select></label></div><label>Details<textarea name="note" maxLength={600} required placeholder="Tell operations exactly what should change." /></label><button className="button primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Send request"}</button><p className="status" role="status">{status}</p><small>Requests do not change or cancel an order until Bubble Wash confirms them.</small></form><p><Link href="/privacy">Privacy and data rights</Link></p></div>;
}
