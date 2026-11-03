"use client";

import { bookingLabel } from "@/lib/booking-label";
import Link from "next/link";
import { BoundedList } from "./BoundedList";
import { FormEvent, useEffect, useRef, useState } from "react";

type CustomerOrder = {
  orderId: string; bookingReference?: string | null; customer: string; createdAt: string; updatedAt: string; status: string; nextStep: string;
  area: string; pickupAddress: string; plan: string; service: string; pickupDate: string; pickupWindow: string;
  invoice?: { invoiceId: string; lines: Array<{ label: string; amountMinor: number }>; balanceMinor: number; status: string };
  timeline: Array<{ createdAt: string; status: string; type: string }>;
};

export function CustomerOrderManager() {
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [status, setStatus] = useState("Checking saved order access…");
  const [pending, setPending] = useState(false);
  const [checkingAccess, setCheckingAccess] = useState(true);
  const [recoveryStatus, setRecoveryStatus] = useState("");
  const initialAccess = useRef<Promise<{ ok: boolean; status: number; recovery: boolean; data: { order?: CustomerOrder; references?: Array<{ orderId: string; createdAt: string }>; error?: string } }> | null>(null);
  const [requestAction, setRequestAction] = useState("reschedule");
  const requestAttempt = useRef<{ payload: string; key: string } | null>(null);
  const requestInFlight = useRef(false);

  const [references, setReferences] = useState<Array<{ orderId: string; bookingReference?: string | null; createdAt: string }>>([]);
  const [deliveryCode, setDeliveryCode] = useState("");
  useEffect(() => {
    let active = true;
    // Share this one-shot request across effect cleanup/re-setup. Never replay
    // a recovery token: the server may consume it even if its response is lost.
    if (!initialAccess.current) {
      const recoveryToken = new URLSearchParams(window.location.hash.slice(1)).get("recovery");
      if (recoveryToken) window.history.replaceState(window.history.state, "", window.location.pathname);
      const recoveryOptions = recoveryToken ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: recoveryToken }) } : {};
      initialAccess.current = fetch(recoveryToken ? "/api/customer/recover" : "/api/customer/order", { ...recoveryOptions, cache: "no-store", signal: AbortSignal.timeout(15000) })
        .then(async response => ({ ok: response.ok, status: response.status, recovery: Boolean(recoveryToken), data: await response.json() }));
    }
    initialAccess.current.then(({ ok, status: responseStatus, recovery, data }) => {
      if (!active) return;
      if (ok && data.order) {
        setOrder(data.order); setReferences(data.references || []); setStatus(recovery ? "Booking verified." : "");
      } else if (recovery) {
        setStatus(data.error || "Recovery link could not be verified. Request a new link below.");
      } else {
        setStatus(responseStatus === 401 ? "Use the same email or phone entered when the booking was made." : "Saved order access could not be checked. Open your order below or request a recovery link.");
      }
    }).catch(() => {
      if (active) setStatus("We couldn’t verify order access. Open your order with its private code or request a new recovery link below.");
    }).finally(() => { if (active) setCheckingAccess(false); });
    return () => { active = false; };
  }, []);
  async function perform(url: string, payload: Record<string, unknown>, done: (body: Record<string, unknown>) => void, feedback = setStatus) {
    setPending(true);
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
      const body = await response.json();
      if (!response.ok) { if (response.status === 401) setOrder(null); throw new Error(body.error || "Unable to complete this request."); }
      done(body);
    } catch (error) { feedback(error instanceof Error ? error.message : "Connection interrupted. Please try again."); }
    finally { setPending(false); }
  }
  async function access(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await perform("/api/customer/access", Object.fromEntries(new FormData(event.currentTarget)), (body) => { setOrder(body.order as CustomerOrder); setStatus("Booking verified."); });
  }
  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestInFlight.current) return;
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form));
    const serialized = JSON.stringify(payload);
    if (requestAttempt.current?.payload !== serialized) requestAttempt.current = { payload: serialized, key: crypto.randomUUID() };
    requestInFlight.current = true;
    try {
      await perform("/api/customer/request", { ...payload, idempotencyKey: requestAttempt.current.key }, (body) => {
        requestAttempt.current = null;
        setStatus(String(body.message)); form.reset(); setRequestAction("reschedule");
      });
    } finally { requestInFlight.current = false; }
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
    event.preventDefault(); setRecoveryStatus("Requesting a recovery link…"); await perform("/api/customer/recover", Object.fromEntries(new FormData(event.currentTarget)), (body) => setRecoveryStatus(String(body.message)), setRecoveryStatus);
  }
  const recoveryForm = <details className="invoicePanel"><summary>Recover a lost reference or handoff code</summary><form onSubmit={recoverReference}><label>Booking email<input name="email" type="email" autoComplete="email" required /></label><button className="button secondary" disabled={pending || checkingAccess}>Send recovery link</button>{recoveryStatus ? <p className="status" role="status">{recoveryStatus}</p> : null}</form><p>A single-use link verifies access to your booking email.</p></details>;
  if (!order) return <><form className="serviceForm manageAccessForm" onSubmit={access}><div className="formGrid two"><label>Private tracking code<input name="orderId" placeholder="Paste private code" autoComplete="off" required /></label><label>Booking email or phone<input name="contact" autoComplete="email" required /></label></div><button className="button primary" type="submit" disabled={pending || checkingAccess}>{pending || checkingAccess ? "Verifying…" : "Open my order"}</button><p className="status" role="status">{status}</p></form>{recoveryForm}</>;

  return <div className="customerManageGrid"><section className="servicePanel customerOrderSummary"><div className="sectionHeading"><div><p className="sectionLabel">{bookingLabel(order)}</p><h2>{order.customer}, here is your order.</h2></div><button className="textButton" type="button" onClick={close}>Sign out of this order</button></div><dl className="recordList"><div><dt>Status</dt><dd>{order.status}</dd></div><div><dt>Next step</dt><dd>{order.nextStep}</dd></div><div><dt>Plan</dt><dd>{order.plan || "Not recorded"}</dd></div><div><dt>Service</dt><dd>{order.service}</dd></div><div><dt>Pickup</dt><dd>{[order.pickupDate, order.pickupWindow].filter(Boolean).join(" · ") || "Confirmation pending"}</dd></div><div><dt>Location</dt><dd>{order.pickupAddress || order.area}</dd></div></dl>{order.invoice ? <section><h3>Invoice · {bookingLabel(order)}</h3><BoundedList label="Invoice items" as="dl" className="recordList">{order.invoice.lines.map((line, index) => <div key={index}><dt>{line.label}</dt><dd>GHS {(line.amountMinor / 100).toFixed(2)}</dd></div>)}</BoundedList><dl className="recordList"><div><dt>Balance · {order.invoice.status}</dt><dd>GHS {(order.invoice.balanceMinor / 100).toFixed(2)}</dd></div></dl>{order.invoice.balanceMinor > 0 && process.env.NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED === "true" ? <button className="button primary" type="button" disabled={pending} onClick={payInvoice}>Pay outstanding balance</button> : null}</section> : <p>Your itemized invoice will appear after we check and weigh your laundry.</p>}<button className="button secondary" type="button" disabled={pending} onClick={recoverCode}>Replace lost handoff code</button>{deliveryCode ? <p className="deliveryCode"><strong>{deliveryCode}</strong><small>Give this code to the rider only after receiving your clean laundry.</small></p> : null}{recoveryForm}{references.length > 1 ? <section><h3>Your booking references</h3><BoundedList label="Booking references" noun="bookings">{references.map((ref) => <p key={ref.orderId}>{bookingLabel(ref)} · {new Date(ref.createdAt).toLocaleDateString()}</p>)}</BoundedList></section> : null}<h3>Order history</h3><BoundedList label="Order history" noun="updates" className="customerTimeline">{order.timeline.map((event, index) => <div key={`${event.createdAt}-${index}`}><time>{new Date(event.createdAt).toLocaleString()}</time><strong>{event.status}</strong></div>)}</BoundedList></section><form className="serviceForm customerRequestForm" onSubmit={submitRequest}><p className="sectionLabel">Request a change</p><h2>How can we help?</h2><label>Request<select name="action" value={requestAction} onChange={(event) => setRequestAction(event.target.value)}><option value="reschedule">Reschedule pickup</option><option value="cancel">Request cancellation</option><option value="quality">Report a quality issue</option><option value="damage">Report loss or damage</option><option value="refund">Request a refund</option><option value="care">Add a garment-care note</option></select></label><div hidden={requestAction !== "reschedule"}><div className="formGrid two"><label>New pickup date<input name="requestedDate" disabled={requestAction !== "reschedule"} type="date" min={new Date().toISOString().slice(0, 10)} /></label><label>New pickup window<select name="requestedWindow" disabled={requestAction !== "reschedule"} defaultValue=""><option value="">Select a pickup window</option><option>8:00–10:00</option><option>10:00–12:00</option><option>12:00–14:00</option><option>14:00–16:00</option><option>16:00–18:00</option></select></label></div></div><label>Details<textarea name="note" maxLength={600} required placeholder="Tell our team what you would like to change." /></label><button className="button primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Send request"}</button><p className="status" role="status">{status}</p><small>Requests do not change or cancel an order until Bubble Wash confirms them.</small></form><p><Link href="/privacy">Privacy and data rights</Link></p></div>;
}
