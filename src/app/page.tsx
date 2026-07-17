"use client";

import Image from "next/image";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { buildRoutePreview, type RoutePreview } from "@/lib/maps";
import { addons, plans, zones, type AddonKey, type PlanName, type ZoneKey } from "@/lib/pricing";

type Quote = {
  plan: string;
  pickupRhythm: string;
  kg: number;
  zone: string;
  zoneFee: number;
  discount: string;
  discountAmount: number;
  ratePerKg: number;
  subscription: number;
  monthlyPickups: number;
  processingPerPickup: number;
  addonsPerPickup: number;
  addonLines: Array<{ key: string; label: string; amount: number }>;
  perPickupTotal: number;
  grossMonthlyTotal: number;
  estimatedMonthlyTotal: number;
  minimumApplied: boolean;
};

type TrackingResult = {
  id: string;
  createdAt: string;
  updatedAt?: string;
  status: string;
  nextStep: string;
  area: string;
  routeWindow?: string;
  eventCount?: number;
  route?: RoutePreview;
};

type BookingConfirmation = {
  id: string;
  amountGhs: number;
  paymentPreference: string;
};

const locations = ["Osu", "Labone", "Cantonments", "Airport", "East Legon", "Dzorwulu", "Spintex", "Madina", "Tema by confirmation"];
const popularAreas = ["Osu", "Labone", "East Legon", "Airport", "Cantonments"];
const addonEntries = Object.entries(addons) as Array<[AddonKey, (typeof addons)[AddonKey]]>;

const serviceFacts = [
  ["24h", "standard turnaround target"],
  ["4", "commercial service plans"],
  ["GHS", "clear estimates before booking"],
  ["1", "reference from pickup to delivery"],
];

const serviceSteps = [
  ["We collect", "Choose the business location, pickup date, and preferred time."],
  ["We clean", "A vetted laundry partner processes the order and records each handoff."],
  ["We deliver", "Follow the same reference until the clean order is returned."],
];

const whatsappNumber = process.env.NEXT_PUBLIC_BUBBLEWASH_WHATSAPP?.replace(/\D/g, "") ?? "";
const contactEmail = process.env.NEXT_PUBLIC_BUBBLEWASH_CONTACT_EMAIL?.trim() ?? "";
const whatsappUrl = whatsappNumber
  ? `https://wa.me/${whatsappNumber}?text=${encodeURIComponent("Hi Bubble Wash, I want to discuss a commercial laundry pickup.")}`
  : "";

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-GH", { style: "currency", currency: "GHS", maximumFractionDigits: 0 }).format(value);
}

function formatDate(value?: string) {
  if (!value) return "Not updated yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" });
}

function statusTone(message?: string) {
  if (!message) return "status";
  if (/unable|failed|missing|invalid|too many|error|required|not configured|enter .*first|did not match/i.test(message)) return "status error";
  if (/ready|covered|received|reference|selected|loaded|verified|paid|saved/i.test(message)) return "status success";
  return "status";
}

async function postJSON<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

export default function Home() {
  const [plan, setPlan] = useState<PlanName>("Twice weekly");
  const [zone, setZone] = useState<ZoneKey>("core");
  const [kg, setKg] = useState(60);
  const [selectedAddons, setSelectedAddons] = useState<AddonKey[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteStatus, setQuoteStatus] = useState("Choose a plan, expected weight, and any extra services.");
  const [bookingArea, setBookingArea] = useState("");
  const [coverageArea, setCoverageArea] = useState("");
  const [coverageStatus, setCoverageStatus] = useState("Enter the collection area to check service coverage.");
  const [routePreview, setRoutePreview] = useState<RoutePreview>(() => buildRoutePreview("core", "Core Accra route"));
  const [trackingStatus, setTrackingStatus] = useState("Enter the reference issued after booking.");
  const [trackingResult, setTrackingResult] = useState<TrackingResult | null>(null);
  const [bookingStatus, setBookingStatus] = useState("");
  const [bookingConfirmation, setBookingConfirmation] = useState<BookingConfirmation | null>(null);
  const [paymentStatus, setPaymentStatus] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const zoneEntries = useMemo(() => Object.entries(zones) as Array<[ZoneKey, (typeof zones)[ZoneKey]]>, []);
  const minPickupDate = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const maxPickupDate = useMemo(() => {
    const date = new Date();
    date.setDate(date.getDate() + 30);
    return date.toISOString().slice(0, 10);
  }, []);
  const selectedPlan = plans.find((item) => item.name === plan) ?? plans[1];

  useEffect(() => {
    const reference = new URLSearchParams(window.location.search).get("payment_reference");
    if (!reference) return;
    fetch(`/api/payments/verify?reference=${encodeURIComponent(reference)}`, { cache: "no-store" })
      .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
      .then(({ ok, data }) => {
        if (!ok || !data.ok) throw new Error(data.error ?? "Unable to verify payment.");
        setPaymentStatus(data.payment.paid ? `Payment verified: ${formatMoney(data.payment.amountGhs)}.` : `Payment status: ${data.payment.status}.`);
      })
      .catch((error) => setPaymentStatus(error instanceof Error ? error.message : "Unable to verify payment."))
      .finally(() => {
        window.history.replaceState({}, "", `${window.location.pathname}#booking`);
      });
  }, []);

  function routeZoneForArea(area: string): ZoneKey {
    const normalized = area.toLowerCase();
    if (["tema", "community", "outer"].some((item) => normalized.includes(item))) return "outer";
    if (["spintex", "madina", "dzorwulu", "ridge", "near"].some((item) => normalized.includes(item))) return "near";
    if (["custom", "kasoa", "adenta"].some((item) => normalized.includes(item))) return "custom";
    return "core";
  }

  function invalidateQuote() {
    setQuote(null);
    setQuoteStatus("Price changed. Run a fresh estimate before booking.");
  }

  function toggleAddon(addon: AddonKey) {
    setSelectedAddons((current) => current.includes(addon) ? current.filter((item) => item !== addon) : [...current, addon]);
    invalidateQuote();
  }

  async function requestQuote() {
    const result = await postJSON<{ ok: boolean; quote: Quote }>("/api/quote", { plan, kg, addons: selectedAddons, zone, discount: "none" });
    setQuote(result.quote);
    setQuoteStatus("Estimate ready.");
    return result.quote;
  }

  async function calculate(event?: FormEvent) {
    event?.preventDefault();
    setPendingAction("quote");
    setQuoteStatus("Calculating estimate…");
    try {
      await requestQuote();
    } catch (error) {
      setQuote(null);
      setQuoteStatus(error instanceof Error ? error.message : "Unable to calculate estimate.");
    } finally {
      setPendingAction(null);
    }
  }

  async function runCoverageCheck(areaInput: string) {
    const area = areaInput.trim();
    if (!area) {
      setCoverageStatus("Enter a collection area first.");
      return;
    }
    const matched = locations.find((location) => area.toLowerCase().includes(location.split(" ")[0].toLowerCase()));
    const selectedZone = routeZoneForArea(area);
    setPendingAction("coverage");
    setCoverageStatus("Checking the service area…");
    try {
      const response = await fetch(`/api/route-preview?zone=${encodeURIComponent(selectedZone)}&area=${encodeURIComponent(area)}`);
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Coverage check failed.");
      setRoutePreview(data.route);
      setZone(selectedZone);
      setBookingArea(area);
      invalidateQuote();
      setCoverageStatus(matched ? `${matched} is covered. The service area has been added to your booking.` : `${area} needs route confirmation. Operations will confirm it before dispatch.`);
    } catch (error) {
      setRoutePreview(buildRoutePreview(selectedZone, area));
      setZone(selectedZone);
      setBookingArea(area);
      invalidateQuote();
      setCoverageStatus(error instanceof Error ? error.message : "Unable to check coverage.");
    } finally {
      setPendingAction(null);
    }
  }

  async function submitBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setPendingAction("booking");
    setBookingStatus("Checking the estimate and saving your booking…");
    setBookingConfirmation(null);
    try {
      const currentQuote = quote ?? await requestQuote();
      const payload = Object.fromEntries(new FormData(form).entries());
      Object.assign(payload, { submissionType: "pickup-booking", preferredPlan: plan, zone, kg: String(kg), addons: selectedAddons });
      const data = await postJSON<{ ok: boolean; message: string; id: string }>("/api/submit", payload);
      const paymentPreference = String(payload.paymentPreference ?? "Invoice me");
      setBookingConfirmation({ id: data.id, amountGhs: currentQuote.estimatedMonthlyTotal, paymentPreference });
      setTrackingStatus(`Booking received. Use ${data.id} to check progress.`);
      setBookingStatus(`Booking received. Reference: ${data.id}`);
    } catch (error) {
      setBookingStatus(error instanceof Error ? error.message : "Unable to save the booking.");
    } finally {
      setPendingAction(null);
    }
  }

  async function startPayment() {
    if (!bookingConfirmation) return;
    setPendingAction("payment");
    setPaymentStatus("Opening secure payment…");
    try {
      const data = await postJSON<{ ok: boolean; payment: { authorizationUrl: string } }>("/api/payments/initialize", {
        orderId: bookingConfirmation.id,
        paymentMethod: bookingConfirmation.paymentPreference,
      });
      window.location.assign(data.payment.authorizationUrl);
    } catch (error) {
      setPaymentStatus(error instanceof Error ? error.message : "Unable to open secure payment.");
      setPendingAction(null);
    }
  }

  async function trackOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reference = String(new FormData(event.currentTarget).get("trackingId") ?? "").trim();
    if (!reference) {
      setTrackingResult(null);
      setTrackingStatus("Enter a Bubble Wash reference first.");
      return;
    }
    setPendingAction("track");
    setTrackingStatus("Checking the order…");
    try {
      const response = await fetch(`/api/track?id=${encodeURIComponent(reference)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Tracking lookup failed.");
      setTrackingResult(data.tracking);
      setTrackingStatus("Order found.");
    } catch (error) {
      setTrackingResult(null);
      setTrackingStatus(error instanceof Error ? error.message : "Unable to load tracking details.");
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <main className="siteShell">
      <a className="skipLink" href="#booking">Skip to booking</a>
      <header className="siteHeader" id="top">
        <a className="brand" href="#top" aria-label="Bubble Wash home" onClick={() => setMobileOpen(false)}>
          <span className="brandCrop"><Image className="brandMark" src="/bubble-wash-icon.jpg" alt="" width={58} height={58} priority /></span>
          <span>Bubble Wash</span>
        </a>
        <button className="menuButton" type="button" aria-controls="site-navigation" aria-expanded={mobileOpen} onClick={() => setMobileOpen(!mobileOpen)}>{mobileOpen ? "Close" : "Menu"}</button>
        <nav id="site-navigation" className={mobileOpen ? "navLinks open" : "navLinks"}>
          <a href="#how-it-works" onClick={() => setMobileOpen(false)}>How it works</a>
          <a href="#pricing" onClick={() => setMobileOpen(false)}>Pricing</a>
          <a href="#tracking" onClick={() => setMobileOpen(false)}>Track</a>
          <a href="#booking" onClick={() => setMobileOpen(false)}>Book pickup</a>
          {whatsappUrl ? <a className="navCta" href={whatsappUrl} target="_blank" rel="noopener noreferrer">WhatsApp</a> : null}
        </nav>
      </header>

      <section className="homeHero pageShell" aria-labelledby="home-title">
        <div className="homeHeroCopy">
          <p className="sectionLabel">Commercial laundry · Accra</p>
          <h1 id="home-title">Reliable laundry collection for busy businesses.</h1>
          <p className="lead">Scheduled pickup, professional cleaning, and one order reference from collection to return.</p>
          <div className="heroActions"><a className="button primary" href="#booking">Book a pickup</a><a className="button secondary" href="#pricing">See pricing</a></div>
          <form className="coverageForm serviceForm" onSubmit={(event) => { event.preventDefault(); void runCoverageCheck(coverageArea); }}>
            <label htmlFor="coverageArea">Check your collection area</label>
            <div className="inlineFormRow"><input id="coverageArea" value={coverageArea} onChange={(event) => setCoverageArea(event.target.value)} placeholder="Osu, Labone, East Legon…" autoComplete="address-level2" /><button className="button primary" type="submit" disabled={pendingAction === "coverage"}>{pendingAction === "coverage" ? "Checking…" : "Check area"}</button></div>
            <div className="quickTextLinks" aria-label="Common collection areas">{popularAreas.map((area) => <button key={area} type="button" onClick={() => { setCoverageArea(area); void runCoverageCheck(area); }}>{area}</button>)}</div>
          </form>
          <p className={statusTone(coverageStatus)} role="status" aria-live="polite">{coverageStatus}</p>
        </div>
        <aside className="servicePanel" aria-labelledby="service-summary-title">
          <p className="sectionLabel">Service summary</p>
          <h2 id="service-summary-title">What to expect</h2>
          <dl className="recordList">
            <div><dt>Collection area</dt><dd>{routePreview.zoneLabel}</dd></div>
            <div><dt>Updates</dt><dd>WhatsApp and email</dd></div>
            <div><dt>Turnaround</dt><dd>24-hour standard target, confirmed per order</dd></div>
            <div><dt>Tracking</dt><dd>One reference from pickup to delivery</dd></div>
          </dl>
        </aside>
      </section>

      <section className="serviceFacts pageShell" aria-label="Service facts">{serviceFacts.map(([number, label]) => <div key={label}><strong>{number}</strong><span>{label}</span></div>)}</section>

      <section id="how-it-works" className="serviceSection pageShell" aria-labelledby="how-heading">
        <div className="sectionIntro"><p className="sectionLabel">How it works</p><h2 id="how-heading">Collection, cleaning, and return.</h2><p>Every order stays on one record, so your team does not have to repeat information at each stage.</p></div>
        <ol className="workflowList">{serviceSteps.map(([title, copy], index) => <li key={title}><span>{index + 1}</span><div><h3>{title}</h3><p>{copy}</p></div></li>)}</ol>
      </section>

      <section id="pricing" className="serviceSection pageShell" aria-labelledby="pricing-heading">
        <div className="sectionIntro"><p className="sectionLabel">Commercial pricing</p><h2 id="pricing-heading">Estimate the monthly service.</h2><p>The estimate includes the selected pickup plan, expected weight, route fee, and only the extras you choose.</p></div>
        <div className="pricingLayout">
          <form className="serviceForm quoteForm" onSubmit={calculate}>
            <div className="formGrid two">
              <label>Collection plan<select value={plan} onChange={(event) => { setPlan(event.target.value as PlanName); invalidateQuote(); }}>{plans.map((item) => <option key={item.name}>{item.name}</option>)}</select></label>
              <label>Expected weight per pickup (kg)<input type="number" min={1} max={10000} step={1} inputMode="numeric" value={kg} onChange={(event) => { setKg(Number(event.target.value)); invalidateQuote(); }} /></label>
            </div>
            <label>Service area<select value={zone} onChange={(event) => { setZone(event.target.value as ZoneKey); invalidateQuote(); }}>{zoneEntries.map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label>
            <fieldset className="choiceFieldset"><legend>Optional services</legend><div className="choiceGrid">{addonEntries.map(([key, item]) => <label className="checkOption" key={key}><input type="checkbox" checked={selectedAddons.includes(key)} onChange={() => toggleAddon(key)} /><span><strong>{item.label}</strong><small>{"perKg" in item ? `${formatMoney(item.perKg)} / kg` : "percent" in item ? `${Math.round(item.percent * 100)}% of processing` : formatMoney(item.fixed)}</small></span></label>)}</div></fieldset>
            <button className="button primary" type="submit" disabled={pendingAction === "quote"}>{pendingAction === "quote" ? "Calculating…" : "Calculate estimate"}</button>
            <p className={statusTone(quoteStatus)} role="status" aria-live="polite">{quoteStatus}</p>
          </form>
          <aside className="quoteSummary" aria-live="polite">
            <p className="sectionLabel">Your estimate</p>
            <h3>{selectedPlan.name}</h3>
            <p>{selectedPlan.description}</p>
            {quote ? <><strong className="quoteTotal">{formatMoney(quote.estimatedMonthlyTotal)}</strong><span className="quotePeriod">estimated monthly total</span><dl className="miniFacts"><div><dt>Monthly service fee</dt><dd>{formatMoney(quote.subscription)}</dd></div><div><dt>Processing per pickup</dt><dd>{formatMoney(quote.processingPerPickup)}</dd></div><div><dt>Selected extras per pickup</dt><dd>{formatMoney(quote.addonsPerPickup)}</dd></div><div><dt>Route fee per pickup</dt><dd>{formatMoney(quote.zoneFee)}</dd></div><div><dt>Scheduled pickups</dt><dd>{quote.monthlyPickups} per month</dd></div></dl><small>Final billing uses the verified laundry weight recorded at intake.</small></> : <><dl className="miniFacts"><div><dt>Monthly service fee</dt><dd>{formatMoney(selectedPlan.subscription)}</dd></div><div><dt>Schedule</dt><dd>{selectedPlan.pickups}</dd></div><div><dt>Suitable for</dt><dd>{selectedPlan.audience}</dd></div></dl><small>Run the estimate to see the full monthly amount.</small></>}
          </aside>
        </div>
      </section>

      <section id="booking" className="serviceSection pageShell" aria-labelledby="booking-heading">
        <div className="sectionIntro"><p className="sectionLabel">Book a pickup</p><h2 id="booking-heading">Tell us where and when to collect.</h2><p>Your estimate selections are carried into the booking. Operations confirms the route and collection window before dispatch.</p></div>
        <form className="bookingForm serviceForm" onSubmit={submitBooking}>
          <fieldset className="bookingFieldset"><legend>Business contact</legend><div className="formGrid two"><label>Contact name<input name="name" autoComplete="name" required /></label><label>Business email<input name="email" type="email" autoComplete="email" required /></label></div><div className="formGrid two"><label>Phone or WhatsApp<input name="phone" autoComplete="tel" required /></label><label>Business name<input name="company" autoComplete="organization" required /></label></div></fieldset>
          <fieldset className="bookingFieldset"><legend>Collection</legend><div className="formGrid two"><label>Collection area<input name="area" value={bookingArea} onChange={(event) => setBookingArea(event.target.value)} autoComplete="address-level2" required /></label><label>Preferred date<input name="pickupDate" type="date" min={minPickupDate} max={maxPickupDate} required /></label></div><div className="formGrid two"><label>Collection window<select name="pickupWindow" defaultValue="Any available window"><option>Any available window</option><option>Morning pickup</option><option>Afternoon pickup</option><option>Evening pickup</option></select></label><label>Updates<select name="alertPreference" defaultValue="Email + WhatsApp alerts"><option>Email + WhatsApp alerts</option><option>WhatsApp only</option><option>Email only</option><option>Call me</option></select></label></div></fieldset>
          <fieldset className="bookingFieldset"><legend>Billing</legend><div className="formGrid two"><label>Preferred payment<select name="paymentPreference" defaultValue="Card"><option>Card</option><option>MTN MoMo</option><option>Telecel Cash</option><option>Bank transfer</option><option>Invoice me</option></select></label><label>Estimated weight<input value={`${kg} kg per pickup`} readOnly aria-label="Estimated weight from pricing" /></label></div><p className="bookingContextSummary">{plan} · {zones[zone].label} · {selectedAddons.length ? selectedAddons.map((key) => addons[key].label).join(", ") : "No extras selected"}</p></fieldset>
          <label>Collection instructions<textarea name="message" placeholder="Entrance, reception, loading access, care notes, or delivery restrictions" /></label>
          <label className="termsCheck"><input type="checkbox" required /><span>I confirm that the estimate may change after the laundry is weighed at intake and that the collection window requires operations confirmation.</span></label>
          <button className="button primary" type="submit" disabled={pendingAction === "booking"}>{pendingAction === "booking" ? "Saving booking…" : "Submit booking"}</button>
          {bookingStatus ? <p className={statusTone(bookingStatus)} role="status" aria-live="polite">{bookingStatus}</p> : null}
        </form>
        {bookingConfirmation ? <section className="bookingConfirmation" aria-labelledby="booking-confirmation-title"><p className="sectionLabel">Booking received</p><h3 id="booking-confirmation-title">Keep reference {bookingConfirmation.id}</h3><p>Estimated monthly amount: <strong>{formatMoney(bookingConfirmation.amountGhs)}</strong>. Operations will confirm the route and collection window.</p>{bookingConfirmation.paymentPreference === "Invoice me" || bookingConfirmation.paymentPreference === "Bank transfer" ? <p>Billing instructions will be sent after account review.</p> : <button className="button primary" type="button" onClick={startPayment} disabled={pendingAction === "payment"}>{pendingAction === "payment" ? "Opening payment…" : "Continue to secure payment"}</button>}{paymentStatus ? <p className={statusTone(paymentStatus)} role="status">{paymentStatus}</p> : null}</section> : paymentStatus ? <p className={statusTone(paymentStatus)} role="status">{paymentStatus}</p> : null}
      </section>

      <section id="tracking" className="serviceSection pageShell" aria-labelledby="tracking-heading">
        <div className="sectionIntro"><p className="sectionLabel">Track an order</p><h2 id="tracking-heading">Check the latest confirmed update.</h2></div>
        <div className="trackingLayout"><form className="serviceForm" onSubmit={trackOrder}><label>Order reference<input name="trackingId" placeholder="BW-…" autoComplete="off" /></label><button className="button secondary" type="submit" disabled={pendingAction === "track"}>{pendingAction === "track" ? "Checking…" : "Check order"}</button><p className={statusTone(trackingStatus)} role="status" aria-live="polite">{trackingStatus}</p></form>{trackingResult ? <article className="trackingResult"><strong className="trackingStatus">{trackingResult.status}</strong><p>{trackingResult.nextStep}</p><dl className="miniFacts"><div><dt>Reference</dt><dd>{trackingResult.id}</dd></div><div><dt>Collection area</dt><dd>{trackingResult.area}</dd></div><div><dt>Time window</dt><dd>{trackingResult.routeWindow || "Confirmation pending"}</dd></div><div><dt>Last updated</dt><dd>{formatDate(trackingResult.updatedAt || trackingResult.createdAt)}</dd></div></dl></article> : null}</div>
      </section>

      <section className="serviceSection pageShell" aria-labelledby="service-notes-heading"><div className="sectionIntro"><p className="sectionLabel">Service notes</p><h2 id="service-notes-heading">Before the first collection.</h2></div><div className="policyGrid"><article><h3>Final weight</h3><p>Online prices are estimates. The confirmed bill uses the weight recorded when the order reaches the laundry partner.</p></article><article><h3>Collection window</h3><p>A requested time is not final until operations confirms the route and available driver.</p></article><article><h3>Care and item issues</h3><p>Special-care items should be declared before collection. Report a missing or damaged item within 24 hours of delivery.</p></article><article><h3>Cancellations</h3><p>Contact operations before driver dispatch. A route charge may apply after the driver has started the collection.</p></article></div></section>

      <section className="paymentStrip pageShell" aria-labelledby="payment-heading"><p className="sectionLabel">Payments</p><h3 id="payment-heading">Card and Mobile Money through Paystack</h3><p>Invoice and bank-transfer billing are available after account approval.</p></section>

      <footer id="contact" className="footer pageShell"><div><div className="brand footerBrand"><span className="brandCrop"><Image className="brandMark" src="/bubble-wash-icon.jpg" alt="" width={58} height={58} /></span><span>Bubble Wash</span></div><p>Commercial laundry collection and delivery for businesses in Accra.</p></div><div><h3>Service</h3><a href="#how-it-works">How it works</a><a href="#pricing">Pricing</a><a href="#booking">Book a pickup</a><a href="#tracking">Track an order</a></div><div><h3>Support</h3>{whatsappUrl ? <a href={whatsappUrl} target="_blank" rel="noopener noreferrer">WhatsApp</a> : null}{contactEmail ? <a href={`mailto:${contactEmail}`}>{contactEmail}</a> : null}<a href="/staff">Staff access</a></div><div><h3>Service area</h3><p>Accra, Ghana</p><p>Routes outside the core area are confirmed before dispatch.</p></div></footer>
    </main>
  );
}
