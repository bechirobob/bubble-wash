"use client";

import Link from "next/link";
import { ArrowRight, Calculator, LockKeyhole } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { addons, plans, zones, type AddonKey, type PlanName, type ZoneKey } from "@/lib/pricing";
import { formatMoney, postJSON, statusTone, type Quote } from "@/lib/public-ui";

type BookingConfirmation = { id: string; amountGhs: number; paymentPreference: string; deliveryCode: string };
const addonEntries = Object.entries(addons) as Array<[AddonKey, (typeof addons)[AddonKey]]>;
const onlinePaymentsEnabled = process.env.NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED === "true";
const automatedUpdatesEnabled = process.env.NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED === "true";

export function BookingExperience() {
  const [plan, setPlan] = useState<PlanName>("Twice weekly");
  const [zone, setZone] = useState<ZoneKey>("core");
  const [kg, setKg] = useState(60);
  const [selectedAddons, setSelectedAddons] = useState<AddonKey[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [status, setStatus] = useState("Complete the service details, then submit the booking.");
  const [paymentStatus, setPaymentStatus] = useState("");
  const [confirmation, setConfirmation] = useState<BookingConfirmation | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const zoneEntries = useMemo(() => Object.entries(zones) as Array<[ZoneKey, (typeof zones)[ZoneKey]]>, []);
  const minPickupDate = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const maxPickupDate = useMemo(() => { const date = new Date(); date.setDate(date.getDate() + 30); return date.toISOString().slice(0, 10); }, []);

  useEffect(() => {
    if (!onlinePaymentsEnabled) return;
    const reference = new URLSearchParams(window.location.search).get("payment_reference");
    if (!reference) return;
    fetch(`/api/payments/verify?reference=${encodeURIComponent(reference)}`, { cache: "no-store" })
      .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.ok) throw new Error(data.error ?? "Unable to verify payment.");
        setPaymentStatus(data.payment.paid ? `Payment verified: ${formatMoney(data.payment.amountGhs)}.` : `Payment status: ${data.payment.status}.`);
      })
      .catch((error) => setPaymentStatus(error instanceof Error ? error.message : "Unable to verify payment."))
      .finally(() => window.history.replaceState({}, "", window.location.pathname));
  }, []);

  function invalidateQuote() {
    setQuote(null);
    setStatus("Service selection changed. Your booking will use a fresh estimate.");
  }

  function toggleAddon(addon: AddonKey) {
    setSelectedAddons((current) => current.includes(addon) ? current.filter((item) => item !== addon) : [...current, addon]);
    invalidateQuote();
  }

  async function requestQuote() {
    const result = await postJSON<{ ok: boolean; quote: Quote }>("/api/quote", { plan, kg, addons: selectedAddons, zone, discount: "none" });
    setQuote(result.quote);
    return result.quote;
  }

  async function previewQuote() {
    setPendingAction("quote");
    setStatus("Calculating estimate…");
    try { await requestQuote(); setStatus("Estimate ready."); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Unable to calculate estimate."); }
    finally { setPendingAction(null); }
  }

  async function submitBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setPendingAction("booking");
    setStatus("Checking the estimate and saving your booking…");
    setConfirmation(null);
    try {
      const currentQuote = quote ?? await requestQuote();
      const payload = Object.fromEntries(new FormData(form).entries());
      Object.assign(payload, { submissionType: "pickup-booking", preferredPlan: plan, zone, kg: String(kg), addons: selectedAddons });
      const data = await postJSON<{ ok: boolean; message: string; id: string; deliveryCode?: string }>("/api/submit", payload);
      const paymentPreference = String(payload.paymentPreference ?? "Invoice me");
      setConfirmation({ id: data.id, amountGhs: currentQuote.estimatedMonthlyTotal, paymentPreference, deliveryCode: data.deliveryCode ?? "" });
      setStatus(`Booking received. Reference: ${data.id}`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Unable to save the booking."); }
    finally { setPendingAction(null); }
  }

  async function startPayment() {
    if (!confirmation) return;
    setPendingAction("payment");
    setPaymentStatus("Opening secure payment…");
    try {
      const data = await postJSON<{ ok: boolean; payment: { authorizationUrl: string } }>("/api/payments/initialize", { orderId: confirmation.id, paymentMethod: confirmation.paymentPreference });
      window.location.assign(data.payment.authorizationUrl);
    } catch (error) { setPaymentStatus(error instanceof Error ? error.message : "Unable to open secure payment."); setPendingAction(null); }
  }

  return (
    <section className="serviceSection pageShell bookingPageSection" aria-labelledby="booking-form-heading">
      <div className="sectionIntro"><p className="sectionLabel">Booking details</p><h2 id="booking-form-heading">Choose the service and collection.</h2><p>Operations confirms the route and collection window before dispatch.</p></div>
      <form className="bookingForm serviceForm" onSubmit={submitBooking}>
        <fieldset className="bookingFieldset"><legend>Service</legend><div className="formGrid two"><label>Collection plan<select value={plan} onChange={(event) => { setPlan(event.target.value as PlanName); invalidateQuote(); }}>{plans.map((item) => <option key={item.name}>{item.name}</option>)}</select></label><label>Expected weight per pickup (kg)<input type="number" min={1} max={10000} step={1} inputMode="numeric" value={kg} onChange={(event) => { setKg(Number(event.target.value)); invalidateQuote(); }} /></label></div><label>Service area<select value={zone} onChange={(event) => { setZone(event.target.value as ZoneKey); invalidateQuote(); }}>{zoneEntries.map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label><fieldset className="choiceFieldset nestedChoice"><legend>Optional services</legend><div className="choiceGrid">{addonEntries.map(([key, item]) => <label className="checkOption" key={key}><input type="checkbox" checked={selectedAddons.includes(key)} onChange={() => toggleAddon(key)} /><span><strong>{item.label}</strong><small>{"perKg" in item ? `${formatMoney(item.perKg)} / kg` : "percent" in item ? `${Math.round(item.percent * 100)}% of processing` : formatMoney(item.fixed)}</small></span></label>)}</div></fieldset><button className="button secondary" type="button" onClick={previewQuote} disabled={pendingAction === "quote"}><Calculator aria-hidden="true" />{pendingAction === "quote" ? "Calculating…" : "Preview estimate"}</button>{quote ? <p className="bookingContextSummary">Estimated monthly total: {formatMoney(quote.estimatedMonthlyTotal)}</p> : null}</fieldset>
        <fieldset className="bookingFieldset"><legend>Business contact</legend><div className="formGrid two"><label>Contact name<input name="name" autoComplete="name" required /></label><label>Business email<input name="email" type="email" autoComplete="email" required /></label></div><div className="formGrid two"><label>Phone or WhatsApp<input name="phone" autoComplete="tel" required /></label><label>Business name<input name="company" autoComplete="organization" required /></label></div></fieldset>
        <fieldset className="bookingFieldset"><legend>Collection</legend><div className="formGrid two"><label>Collection area<input name="area" autoComplete="address-level2" required /></label><label>Preferred date<input name="pickupDate" type="date" min={minPickupDate} max={maxPickupDate} required /></label></div><div className="formGrid two"><label>Street address or building<input name="pickupAddress" autoComplete="street-address" placeholder="Street, building, or digital address" required /></label><label>Landmark or entrance<input name="landmark" placeholder="Reception, gate, floor, or nearby landmark" /></label></div><div className="formGrid two"><label>Collection window<select name="pickupWindow" defaultValue="Any available window"><option>Any available window</option><option>Morning pickup</option><option>Afternoon pickup</option><option>Evening pickup</option></select></label><label>Updates<select name="alertPreference" defaultValue={automatedUpdatesEnabled ? "Email + WhatsApp alerts" : "Order tracking and phone follow-up"}>{automatedUpdatesEnabled ? <><option>Email + WhatsApp alerts</option><option>WhatsApp only</option><option>Email only</option></> : <option>Order tracking and phone follow-up</option>}<option>Call me</option></select></label></div></fieldset>
        <fieldset className="bookingFieldset"><legend>Billing</legend><label>Preferred payment<select name="paymentPreference" defaultValue={onlinePaymentsEnabled ? "Card" : "Bank transfer"}>{onlinePaymentsEnabled ? <><option>Card</option><option>MTN MoMo</option><option>Telecel Cash</option></> : null}<option>Bank transfer</option><option>Invoice me</option></select></label></fieldset>
        <label>Collection instructions<textarea name="message" placeholder="Entrance, reception, loading access, care notes, or delivery restrictions" /></label>
        <label className="termsCheck"><input type="checkbox" required /><span>I agree to the <Link href="/terms" target="_blank">service terms</Link> and <Link href="/privacy" target="_blank">privacy notice</Link>. I understand that intake weight may change the estimate and the collection window requires confirmation.</span></label>
        <button className="button primary" type="submit" disabled={pendingAction === "booking"}><ArrowRight aria-hidden="true" />{pendingAction === "booking" ? "Saving booking…" : "Submit booking"}</button>
        <p className={statusTone(status)} role="status" aria-live="polite">{status}</p>
      </form>
      {confirmation ? <section className="bookingConfirmation" aria-labelledby="booking-confirmation-title"><p className="sectionLabel">Booking received</p><h3 id="booking-confirmation-title">Keep reference {confirmation.id}</h3><p>Estimated monthly amount: <strong>{formatMoney(confirmation.amountGhs)}</strong>. Operations will confirm the route and collection window.</p>{confirmation.deliveryCode ? <p className="deliveryCode"><span>Delivery handoff code</span><strong>{confirmation.deliveryCode}</strong><small>Keep this private. Give it to the rider only when the clean order is returned.</small></p> : null}<p><Link href="/manage">Open the private customer order desk</Link></p>{confirmation.paymentPreference === "Invoice me" || confirmation.paymentPreference === "Bank transfer" ? <p>Billing instructions will be sent after account review.</p> : <button className="button primary" type="button" onClick={startPayment} disabled={pendingAction === "payment"}><LockKeyhole aria-hidden="true" />{pendingAction === "payment" ? "Opening payment…" : "Continue to secure payment"}</button>}{paymentStatus ? <p className={statusTone(paymentStatus)} role="status">{paymentStatus}</p> : null}</section> : paymentStatus ? <p className={statusTone(paymentStatus)} role="status">{paymentStatus}</p> : null}
    </section>
  );
}
