"use client";

import Link from "next/link";
import { ArrowRight, BadgeCheck, LockKeyhole } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  businessTypes,
  isCompletePlanSurvey,
  laundryRhythms,
  locationCounts,
  recommendPlan,
  servicePriorities,
  type PlanSurvey,
} from "@/lib/plan-recommendation";
import { addons, plans, type AddonKey, type PlanName } from "@/lib/pricing";
import { formatMoney, postJSON, statusTone } from "@/lib/public-ui";

type BookingConfirmation = { id: string; paymentPreference: string; deliveryCode: string; plan: PlanName };
const addonEntries = Object.entries(addons) as Array<[AddonKey, (typeof addons)[AddonKey]]>;
const onlinePaymentsEnabled = process.env.NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED === "true";
const automatedUpdatesEnabled = process.env.NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED === "true";
const pickupWindows = ["8:00–10:00", "10:00–12:00", "12:00–14:00", "14:00–16:00", "16:00–18:00"];

export function BookingExperience() {
  const [survey, setSurvey] = useState<Partial<PlanSurvey>>({});
  const recommendation = useMemo(() => isCompletePlanSurvey(survey) ? recommendPlan(survey) : null, [survey]);
  const [planOverride, setPlanOverride] = useState<PlanName | "">("");
  const selectedPlan = planOverride || recommendation?.name || "Twice weekly";
  const [selectedAddons, setSelectedAddons] = useState<AddonKey[]>([]);
  const [status, setStatus] = useState("Answer four quick questions to get a plan recommendation.");
  const [paymentStatus, setPaymentStatus] = useState("");
  const [confirmation, setConfirmation] = useState<BookingConfirmation | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
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

  function updateSurvey<Key extends keyof PlanSurvey>(key: Key, value: PlanSurvey[Key]) {
    setSurvey((current) => ({ ...current, [key]: value }));
    setPlanOverride("");
    setStatus("Updating your plan recommendation…");
  }

  function toggleAddon(addon: AddonKey) {
    setSelectedAddons((current) => current.includes(addon) ? current.filter((item) => item !== addon) : [...current, addon]);
  }

  async function submitBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!recommendation) {
      setStatus("Complete the plan-fit questions before booking.");
      return;
    }
    const form = event.currentTarget;
    setPendingAction("booking");
    setStatus("Saving your pickup and service selection…");
    setConfirmation(null);
    try {
      const payload = Object.fromEntries(new FormData(form).entries());
      Object.assign(payload, { submissionType: "pickup-booking", plan: selectedPlan, addons: selectedAddons });
      const data = await postJSON<{ ok: boolean; message: string; id: string; deliveryCode?: string }>("/api/submit", payload);
      const paymentPreference = String(payload.paymentPreference ?? "Invoice me");
      setConfirmation({ id: data.id, paymentPreference, deliveryCode: data.deliveryCode ?? "", plan: selectedPlan });
      setStatus(`Pickup booked. Reference: ${data.id}`);
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
      <div className="sectionIntro"><p className="sectionLabel">Book a collection</p><h2 id="booking-form-heading">Set up the right service and pickup.</h2><p>Your supplied Bubble Wash bag sets the load capacity, so you do not need to estimate kilograms.</p></div>
      <form className="bookingForm serviceForm" onSubmit={submitBooking}>
        <fieldset className="bookingFieldset planSurvey"><legend>Find the right plan</legend><p className="fieldHelp">Four quick answers let us recommend a collection rhythm instead of making you guess.</p><div className="formGrid two"><label>What best describes your operation?<select name="businessType" value={survey.businessType ?? ""} onChange={(event) => updateSurvey("businessType", event.target.value as PlanSurvey["businessType"])} required><option value="" disabled>Select one</option>{businessTypes.map((item) => <option key={item}>{item}</option>)}</select></label><label>How quickly does one Bubble Wash bag fill?<select name="laundryRhythm" value={survey.laundryRhythm ?? ""} onChange={(event) => updateSurvey("laundryRhythm", event.target.value as PlanSurvey["laundryRhythm"])} required><option value="" disabled>Select one</option>{laundryRhythms.map((item) => <option key={item}>{item}</option>)}</select></label></div><div className="formGrid two"><label>How many pickup locations do you manage?<select name="locationCount" value={survey.locationCount ?? ""} onChange={(event) => updateSurvey("locationCount", event.target.value as PlanSurvey["locationCount"])} required><option value="" disabled>Select one</option>{locationCounts.map((item) => <option key={item}>{item}</option>)}</select></label><label>Which support level matters most?<select name="servicePriority" value={survey.servicePriority ?? ""} onChange={(event) => updateSurvey("servicePriority", event.target.value as PlanSurvey["servicePriority"])} required><option value="" disabled>Select one</option>{servicePriorities.map((item) => <option key={item}>{item}</option>)}</select></label></div>{recommendation ? <section className="planRecommendation" aria-live="polite"><div className="planRecommendationHeader"><div><p className="sectionLabel">Recommended for your operation</p><h3>{recommendation.plan.name}</h3><p>{recommendation.plan.description}</p></div><strong>{formatMoney(recommendation.plan.subscription)}<small>service fee / month</small></strong></div><ul>{recommendation.reasons.map((reason) => <li key={reason}><BadgeCheck aria-hidden="true" />{reason}</li>)}</ul><div className="planHighlights"><span>{recommendation.plan.pickups}</span>{recommendation.plan.features.slice(0, 3).map((feature) => <span key={feature}>{feature}</span>)}</div><label>Selected plan<select name="plan" value={selectedPlan} onChange={(event) => setPlanOverride(event.target.value as PlanName)}>{plans.map((item) => <option key={item.name}>{item.name}{item.name === recommendation.name ? " — recommended" : ""}</option>)}</select><small>You stay in control and can choose another plan.</small></label></section> : <p className="recommendationPrompt">Complete all four answers to see your recommendation.</p>}</fieldset>
        <fieldset className="bookingFieldset"><legend>Business contact</legend><div className="formGrid two"><label>Contact name<input name="name" autoComplete="name" required /></label><label>Business email<input name="email" type="email" autoComplete="email" required /></label></div><div className="formGrid two"><label>Phone or WhatsApp<input name="phone" type="tel" autoComplete="tel" inputMode="tel" required /></label><label>Business name<input name="company" autoComplete="organization" required /></label></div></fieldset>
        <fieldset className="bookingFieldset"><legend>Select your laundry pickup</legend><p className="fieldHelp">Enter the exact collection point. We classify its locality privately for route planning and customer-concentration reporting.</p><label>Exact pickup location<textarea name="pickupAddress" autoComplete="street-address" placeholder="Building, street, locality, or GhanaPost GPS address" rows={3} required /></label><div className="formGrid two"><label>Pickup date<input name="pickupDate" type="date" min={minPickupDate} max={maxPickupDate} required /></label><label>Pickup window<select name="pickupWindow" defaultValue="" required><option value="" disabled>Select a 2-hour window</option>{pickupWindows.map((window) => <option key={window}>{window}</option>)}</select><small>Your selected arrival window is saved with the booking.</small></label></div><label>Entrance or handoff details <small>Optional</small><input name="landmark" placeholder="Reception, gate, floor, or nearby landmark" /></label><label>Collection instructions <small>Optional</small><textarea name="message" placeholder="Access notes, care instructions, or delivery restrictions" /></label></fieldset>
        <fieldset className="bookingFieldset"><legend>Care, updates and billing</legend><fieldset className="choiceFieldset nestedChoice"><legend>Optional services</legend><div className="choiceGrid">{addonEntries.map(([key, item]) => <label className="checkOption" key={key}><input type="checkbox" checked={selectedAddons.includes(key)} onChange={() => toggleAddon(key)} /><span><strong>{item.label}</strong><small>{"perKg" in item ? `${formatMoney(item.perKg)} / kg after intake` : "percent" in item ? `${Math.round(item.percent * 100)}% of processing` : formatMoney(item.fixed)}</small></span></label>)}</div></fieldset><div className="formGrid two"><label>Order updates<select name="alertPreference" defaultValue={automatedUpdatesEnabled ? "Email + WhatsApp alerts" : "Order tracking and phone follow-up"}>{automatedUpdatesEnabled ? <><option>Email + WhatsApp alerts</option><option>WhatsApp only</option><option>Email only</option></> : <option>Order tracking and phone follow-up</option>}<option>Call me</option></select></label><label>Payment method<select name="paymentPreference" defaultValue={onlinePaymentsEnabled ? "Card" : "Bank transfer"}>{onlinePaymentsEnabled ? <><option>Card</option><option>MTN MoMo</option><option>Telecel Cash</option></> : null}<option>Bank transfer</option><option>Invoice me</option></select></label></div></fieldset>
        <label className="termsCheck"><input type="checkbox" required /><span>I agree to the <Link href="/terms" target="_blank">service terms</Link> and <Link href="/privacy" target="_blank">privacy notice</Link>. I understand that processing is billed from verified intake and my selected pickup window is recorded with this booking.</span></label>
        <button className="button primary" type="submit" disabled={pendingAction === "booking"}><ArrowRight aria-hidden="true" />{pendingAction === "booking" ? "Saving pickup…" : "Book pickup"}</button>
        <p className={statusTone(status)} role="status" aria-live="polite">{status}</p>
      </form>
      {confirmation ? <section className="bookingConfirmation" aria-labelledby="booking-confirmation-title"><p className="sectionLabel">Pickup booked</p><h3 id="booking-confirmation-title">Keep reference {confirmation.id}</h3><p>Your <strong>{confirmation.plan}</strong> plan and pickup window are recorded. Processing charges use the verified laundry intake.</p>{confirmation.deliveryCode ? <p className="deliveryCode"><span>Delivery handoff code</span><strong>{confirmation.deliveryCode}</strong><small>Keep this private. Give it to the rider only when the clean order is returned.</small></p> : null}<p><Link href="/manage">Open the private customer order desk</Link></p>{confirmation.paymentPreference === "Invoice me" || confirmation.paymentPreference === "Bank transfer" ? <p>Billing instructions will be sent after account review.</p> : <button className="button primary" type="button" onClick={startPayment} disabled={pendingAction === "payment"}><LockKeyhole aria-hidden="true" />{pendingAction === "payment" ? "Opening payment…" : "Continue to secure payment"}</button>}{paymentStatus ? <p className={statusTone(paymentStatus)} role="status">{paymentStatus}</p> : null}</section> : paymentStatus ? <p className={statusTone(paymentStatus)} role="status">{paymentStatus}</p> : null}
    </section>
  );
}
