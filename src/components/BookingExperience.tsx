"use client";

import Link from "next/link";
import { ArrowRight, BadgeCheck } from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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

export function BookingExperience({ available = true, initialPlan = "", initialAddons = [] }: { available?: boolean; initialPlan?: PlanName | ""; initialAddons?: AddonKey[] }) {
  const requestKey = useRef("");
  const [survey, setSurvey] = useState<Partial<PlanSurvey>>({});
  const recommendation = useMemo(() => isCompletePlanSurvey(survey) ? recommendPlan(survey) : null, [survey]);
  const [planOverride, setPlanOverride] = useState<PlanName | "">(initialPlan);
  const selectedPlan = planOverride || recommendation?.name || "Twice weekly";
  const [selectedAddons, setSelectedAddons] = useState<AddonKey[]>(initialAddons);
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

    const next = { ...survey, [key]: value };
    setStatus(isCompletePlanSurvey(next) ? "Your recommendation is ready. Review your selected plan below." : "Complete the remaining questions for your recommendation.");
  }

  function toggleAddon(addon: AddonKey) {
    setSelectedAddons((current) => current.includes(addon) ? current.filter((item) => item !== addon) : [...current.filter((key) => !(addon === "premium" && key === "ironing") && !(addon === "ironing" && key === "premium")), addon]);
  }

  async function submitBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!recommendation) {
      setStatus("Answer the four questions to find your plan.");
      return;
    }
    const form = event.currentTarget;
    setPendingAction("booking");
    setStatus("Saving your pickup and service selection…");
    setConfirmation(null);
    try {
      const payload = Object.fromEntries(new FormData(form).entries());
      const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ payload, selectedPlan, selectedAddons }))))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
      try { const previous = JSON.parse(sessionStorage.getItem("bubblewash-booking-retry") || "null"); requestKey.current = previous?.fingerprint === fingerprint ? previous.key : crypto.randomUUID(); sessionStorage.setItem("bubblewash-booking-retry", JSON.stringify({ fingerprint, key: requestKey.current })); } catch { requestKey.current ||= crypto.randomUUID(); }
      Object.assign(payload, { idempotencyKey: requestKey.current, submissionType: "pickup-booking", plan: selectedPlan, addons: selectedAddons });
      const data = await postJSON<{ ok: boolean; message: string; id: string; deliveryCode?: string }>("/api/submit", payload);
      const paymentPreference = String(payload.paymentPreference ?? "Invoice me");
      setConfirmation({ id: data.id, paymentPreference, deliveryCode: data.deliveryCode ?? "", plan: selectedPlan });
      setStatus(`Pickup requested. Reference: ${data.id}`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Unable to save the booking."); }
    finally { setPendingAction(null); }
  }


  if (!available) return <section className="serviceSection pageShell"><div className="servicePanel"><p className="sectionLabel">Bookings paused</p><h2>New collections are temporarily unavailable.</h2><p>You can still track or manage an existing order. Household laundry has a separate early-access list.</p><div className="heroActions"><Link className="button primary" href="/early-access">Household early access</Link><Link className="button secondary" href="/manage">Manage an order</Link></div></div></section>;
  const selectedDetails = plans.find((p) => p.name === selectedPlan)!;
  return (
    <section className="serviceSection pageShell bookingPageSection" aria-labelledby="booking-form-heading">
      <p id="booking-form-heading" className="fieldHelp">We supply your laundry bag and weigh your load at intake. Start with four questions to find your collection plan.</p>
      <form className="bookingForm serviceForm" onSubmit={submitBooking}>
        <fieldset className="bookingFieldset planSurvey"><legend>Find the right plan</legend><p className="fieldHelp">Answer four quick questions and we’ll suggest a pickup plan for your business.</p><div className="formGrid two"><label>What kind of business do you run?<select name="businessType" value={survey.businessType ?? ""} onChange={(event) => updateSurvey("businessType", event.target.value as PlanSurvey["businessType"])} required><option value="" disabled>Select one</option>{businessTypes.map((item) => <option key={item}>{item}</option>)}</select></label><label>How quickly does one Bubble Wash bag fill?<select name="laundryRhythm" value={survey.laundryRhythm ?? ""} onChange={(event) => updateSurvey("laundryRhythm", event.target.value as PlanSurvey["laundryRhythm"])} required><option value="" disabled>Select one</option>{laundryRhythms.map((item) => <option key={item}>{item}</option>)}</select></label></div><div className="formGrid two"><label>How many pickup locations do you manage?<select name="locationCount" value={survey.locationCount ?? ""} onChange={(event) => updateSurvey("locationCount", event.target.value as PlanSurvey["locationCount"])} required><option value="" disabled>Select one</option>{locationCounts.map((item) => <option key={item}>{item}</option>)}</select></label><label>Which support level matters most?<select name="servicePriority" value={survey.servicePriority ?? ""} onChange={(event) => updateSurvey("servicePriority", event.target.value as PlanSurvey["servicePriority"])} required><option value="" disabled>Select one</option>{servicePriorities.map((item) => <option key={item}>{item}</option>)}</select></label></div>{recommendation ? <section className="planRecommendation" aria-live="polite"><div className="planRecommendationHeader"><div><p className="sectionLabel">Recommended for your business</p><h3>{selectedDetails.name}</h3><p>{selectedDetails.description}</p></div><strong>{formatMoney(selectedDetails.subscription)}<small>service fee / month</small></strong></div><ul>{(selectedPlan === recommendation.name ? recommendation.reasons : [`You selected ${selectedPlan}. Our recommendation remains ${recommendation.name}.`]).map((reason) => <li key={reason}><BadgeCheck aria-hidden="true" />{reason}</li>)}</ul><div className="planHighlights"><span>{selectedDetails.pickups}</span>{selectedDetails.features.slice(0, 3).map((feature) => <span key={feature}>{feature}</span>)}</div><label>Selected plan<select name="plan" value={selectedPlan} onChange={(event) => setPlanOverride(event.target.value as PlanName)}>{plans.map((item) => <option key={item.name}>{item.name}{item.name === recommendation.name ? " — recommended" : ""}</option>)}</select><small>You stay in control and can choose another plan.</small></label></section> : <p className="recommendationPrompt">Complete all four answers to see your recommendation.</p>}</fieldset>
        <fieldset className="bookingFieldset"><legend>Business contact</legend><div className="formGrid two"><label>Contact name<input name="name" autoComplete="name" required /></label><label>Business email<input name="email" type="email" autoComplete="email" required /></label></div><div className="formGrid two"><label>Phone or WhatsApp<input name="phone" type="tel" autoComplete="tel" inputMode="tel" required /></label><label>Business name<input name="company" autoComplete="organization" required /></label></div></fieldset>
        <fieldset className="bookingFieldset"><legend>Select your laundry pickup</legend><p className="fieldHelp">Enter the exact collection point. Include your building, street and locality so the rider can find you.</p><label>Exact pickup location<textarea name="pickupAddress" autoComplete="street-address" placeholder="Building, street, locality, or GhanaPost GPS address" rows={3} required /></label><div className="formGrid two"><label>Pickup date<input name="pickupDate" type="date" min={minPickupDate} max={maxPickupDate} required /></label><label>Pickup window<select name="pickupWindow" defaultValue="" required><option value="" disabled>Select a 2-hour window</option>{pickupWindows.map((window) => <option key={window}>{window}</option>)}</select><small>This is a request. We’ll confirm your pickup time with you.</small></label></div><label>Where should the rider meet you? <small>Optional</small><input name="landmark" placeholder="Reception, gate, floor, or nearby landmark" /></label><label>Collection instructions <small>Optional</small><textarea name="message" placeholder="Access notes, care instructions, or delivery restrictions" /></label></fieldset>
        <fieldset className="bookingFieldset"><legend>Care, updates and billing</legend><fieldset className="choiceFieldset nestedChoice"><legend>Optional services</legend><div className="choiceGrid">{addonEntries.map(([key, item]) => <label className="checkOption" key={key}><input type="checkbox" checked={selectedAddons.includes(key)} onChange={() => toggleAddon(key)} /><span><strong>{item.label}</strong><small>{"perKg" in item ? `${formatMoney(item.perKg)} / kg after intake` : "percent" in item ? `${Math.round(item.percent * 100)}% of processing` : formatMoney(item.fixed)}</small></span></label>)}</div></fieldset><div className="formGrid two"><label>Order updates<select name="alertPreference" defaultValue={automatedUpdatesEnabled ? "Email + WhatsApp alerts" : "Order tracking and phone follow-up"}>{automatedUpdatesEnabled ? <><option>Email + WhatsApp alerts</option><option>WhatsApp only</option><option>Email only</option></> : <option>Order tracking and phone follow-up</option>}<option>Call me</option></select></label><label>Payment method<select name="paymentPreference" defaultValue={onlinePaymentsEnabled ? "Card" : "Bank transfer"}>{onlinePaymentsEnabled ? <><option>Card</option><option>MTN MoMo</option><option>Telecel Cash</option></> : null}<option>Bank transfer</option><option>Invoice me</option></select></label></div></fieldset>
        <section className="quoteSummary"><h3>Your service selection</h3><p><strong>{selectedDetails.name} · {formatMoney(selectedDetails.subscription)} per month</strong></p><p>{selectedDetails.monthlyPickups} included collections per calendar month. Extra collections are quoted separately.</p><p>Processing starts at {formatMoney(selectedDetails.bands[0].rate)} / kg, with a GHS 450 minimum per collection. Selected extras and route fees apply. Your final bill uses the weight recorded when your laundry arrives.</p></section>
        <label className="termsCheck"><input type="checkbox" required /><span>I agree to the <Link href="/terms" target="_blank">service terms</Link> and <Link href="/privacy" target="_blank">privacy notice</Link>. I understand that processing is billed from verified intake and my pickup window is subject to confirmation.</span></label>
        <button className="button primary" type="submit" disabled={pendingAction === "booking" || Boolean(confirmation)}><ArrowRight aria-hidden="true" />{pendingAction === "booking" ? "Saving pickup…" : "Request pickup"}</button>
        <p className={statusTone(status)} role="status" aria-live="polite">{status}</p>
      </form>
      {confirmation ? <section className="bookingConfirmation" aria-labelledby="booking-confirmation-title"><p className="sectionLabel">Pickup requested</p><h3 id="booking-confirmation-title">Keep reference {confirmation.id}</h3><p>Your <strong>{confirmation.plan}</strong> plan and pickup window are recorded. Processing charges use the verified laundry intake.</p>{confirmation.deliveryCode ? <p className="deliveryCode"><span>Delivery handoff code</span><strong>{confirmation.deliveryCode}</strong><small>Keep this private. Give it to the rider only when the clean order is returned.</small></p> : null}<p><Link href="/manage">Manage your order</Link></p><p>Your itemized invoice and payment options will appear in <Link href="/manage">Manage my order</Link> after your laundry has been checked and weighed.</p>{paymentStatus ? <p className={statusTone(paymentStatus)} role="status">{paymentStatus}</p> : null}</section> : paymentStatus ? <p className={statusTone(paymentStatus)} role="status">{paymentStatus}</p> : null}
    </section>
  );
}
