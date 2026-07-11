"use client";

import Image from "next/image";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { buildRoutePreview, type RoutePreview } from "@/lib/maps";
import { plans, zones, type PlanName, type ZoneKey } from "@/lib/pricing";

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
  perPickupTotal: number;
  grossMonthlyTotal: number;
  estimatedMonthlyTotal: number;
  minimumApplied: boolean;
};

type TrackingResult = {
  id: string;
  createdAt: string;
  type: string;
  customer: string;
  status: string;
  nextStep: string;
  area: string;
  payment: string;
  vendor?: string;
  driver?: string;
  routeWindow?: string;
  locationNote?: string;
  eventCount?: number;
  updatedAt?: string;
  route?: RoutePreview;
};

const locations = ["Osu", "Labone", "Cantonments", "Airport", "East Legon", "Dzorwulu", "Spintex", "Madina", "Tema by confirmation"];
const popularAreas = ["Osu", "Labone", "East Legon", "Airport", "Cantonments"];

const coverageGroups = [
  { title: "Core route", fee: "No extra route fee", areas: ["Osu", "Labone", "Cantonments", "Airport", "East Legon"] },
  { title: "Near route", fee: "Route fee confirmed in quote", areas: ["Dzorwulu", "Spintex", "Madina"] },
  { title: "Confirm first", fee: "Pickup window checked before dispatch", areas: ["Tema"] },
];

const proof = [
  ["24h", "standard turnaround target"],
  ["7", "days of pickup scheduling"],
  ["8", "Accra route zones"],
  ["1", "order timeline from pickup to delivery"],
];

const paymentMethods = [
  ["Visa", "visa"],
  ["Mastercard", "mastercard"],
  ["MTN Mobile Money", "momo"],
  ["Telecel Cash", "telecel"],
  ["AirtelTigo Money", "airteltigo"],
  ["Bank transfer", "bank"],
  ["Invoice billing", "invoice"],
];

const customerFlow = [
  ["Text us or book online", "Choose your area, pickup date, and payment preference without a phone chase."],
  ["We route the job", "Bubble Wash assigns the order to a vetted vendor and driver with one shared reference."],
  ["You see the handoff", "Tracking, route links, and alerts keep the pickup-to-delivery trail visible."],
];

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-GH", { style: "currency", currency: "GHS", maximumFractionDigits: 0 }).format(value);
}

function statusTone(message?: string) {
  if (!message) return "status";
  if (/unable|failed|missing|invalid|too many|error|required|not configured|enter .*first/i.test(message)) return "status error";
  if (/ready|covered|received|Reference:|selected|loaded|verified|opening/i.test(message)) return "status success";
  return "status";
}

async function postJSON<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

export default function Home() {
  const [quotePlan, setQuotePlan] = useState<PlanName>("Growth");
  const [zone, setZone] = useState<ZoneKey>("core");
  const discount = "none";
  const [kg, setKg] = useState(82);
  const [bookingPlan, setBookingPlan] = useState<PlanName>("Growth");
  const [bookingZone, setBookingZone] = useState<ZoneKey>("core");
  const [bookingArea, setBookingArea] = useState("");
  const selectedAddons = ["ironing"];
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteStatus, setQuoteStatus] = useState("Choose your plan and estimated weight to see a realistic monthly estimate.");
  const [formStatus, setFormStatus] = useState<Record<string, string>>({});
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobileNav, setIsMobileNav] = useState(false);
  const [coverageArea, setCoverageArea] = useState("");
  const [coverageStatus, setCoverageStatus] = useState("Enter your area to check pickup coverage.");
  const [routePreview, setRoutePreview] = useState<RoutePreview>(() => buildRoutePreview("core", "Core Accra route"));
  const [trackingStatus, setTrackingStatus] = useState("Enter a booking/reference ID after submitting a request.");
  const [trackingResult, setTrackingResult] = useState<TrackingResult | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const zoneEntries = useMemo(() => Object.entries(zones) as Array<[ZoneKey, (typeof zones)[ZoneKey]]>, []);
  const minPickupDate = useMemo(() => new Date().toISOString().slice(0, 10), []);

  useEffect(() => {
    const mobileQuery = window.matchMedia("(max-width: 780px)");
    setIsMobileNav(mobileQuery.matches);

    function updateMobileNav(event: MediaQueryListEvent) {
      setIsMobileNav(event.matches);
      if (!event.matches) setMobileOpen(false);
    }

    function closeMenu(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileOpen(false);
    }

    mobileQuery.addEventListener("change", updateMobileNav);
    window.addEventListener("keydown", closeMenu);
    return () => {
      mobileQuery.removeEventListener("change", updateMobileNav);
      window.removeEventListener("keydown", closeMenu);
    };
  }, []);

  async function calculate(event?: FormEvent) {
    event?.preventDefault();
    setPendingAction("quote");
    setQuoteStatus("Calculating estimate...");
    try {
      const result = await postJSON<{ ok: boolean; quote: Quote }>("/api/quote", { plan: quotePlan, kg, addons: selectedAddons, zone, discount });
      setQuote(result.quote);
      setQuoteStatus("Estimate ready.");
    } catch (error) {
      setQuoteStatus(error instanceof Error ? error.message : "Unable to calculate estimate.");
    } finally {
      setPendingAction(null);
    }
  }

  async function submitLead(event: FormEvent<HTMLFormElement>, type: string) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.submissionType = type;
    setPendingAction(type);
    setFormStatus((current) => ({ ...current, [type]: "Saving request..." }));
    try {
      const data = await postJSON<{ ok: boolean; message: string; id: string }>("/api/submit", payload);
      setFormStatus((current) => ({ ...current, [type]: `${data.message} Reference: ${data.id}` }));
      if (type === "pickup-booking") {
        setTrackingStatus(`Booking saved. Use reference ${data.id} to track the order timeline.`);
      }
      form.reset();
    } catch (error) {
      setFormStatus((current) => ({ ...current, [type]: error instanceof Error ? error.message : "Unable to save request." }));
    } finally {
      setPendingAction(null);
    }
  }

  function routeZoneForArea(area: string): ZoneKey {
    const normalized = area.toLowerCase();
    if (["tema", "community", "outer"].some((item) => normalized.includes(item))) return "outer";
    if (["spintex", "madina", "dzorwulu", "ridge", "near"].some((item) => normalized.includes(item))) return "near";
    if (["custom", "kasoa", "adenta"].some((item) => normalized.includes(item))) return "custom";
    return "core";
  }

  async function runCoverageCheck(areaInput: string) {
    const area = areaInput.trim();
    const matched = locations.find((location) => area.toLowerCase().includes(location.split(" ")[0].toLowerCase()));
    const selectedZone = routeZoneForArea(area || matched || "core");
    setPendingAction("coverage");
    setCoverageStatus("Checking coverage and route details...");
    try {
      const response = await fetch(`/api/route-preview?zone=${encodeURIComponent(selectedZone)}&area=${encodeURIComponent(area || matched || "Core Accra route")}`);
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Route preview failed.");
      setRoutePreview(data.route);
      setZone(selectedZone);
      setBookingZone(selectedZone);
      setBookingArea(area || matched || "");
      setCoverageStatus(matched ? `${matched} covered. Route ready and added to booking.` : `${area || "Area"} queued for route confirmation and added to booking.`);
    } catch (error) {
      setRoutePreview(buildRoutePreview(selectedZone, area || matched || "Core Accra route"));
      setZone(selectedZone);
      setBookingZone(selectedZone);
      setBookingArea(area || matched || "");
      setCoverageStatus(error instanceof Error ? error.message : "Unable to check route preview.");
    } finally {
      setPendingAction(null);
    }
  }

  async function checkCoverage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runCoverageCheck(String(new FormData(event.currentTarget).get("coverageArea") ?? coverageArea));
  }

  async function choosePopularArea(area: string) {
    setCoverageArea(area);
    await runCoverageCheck(area);
  }

  async function trackOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reference = String(new FormData(event.currentTarget).get("trackingId") ?? "").trim();
    if (!reference) {
      setTrackingResult(null);
      setTrackingStatus("Enter a Bubble Wash reference ID first.");
      return;
    }
    try {
      setPendingAction("track");
      setTrackingStatus("Checking saved order timeline...");
      const response = await fetch(`/api/track?id=${encodeURIComponent(reference)}`);
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Tracking lookup failed.");
      setTrackingResult(data.tracking);
      setTrackingStatus("Tracking loaded.");
    } catch (error) {
      setTrackingResult(null);
      setTrackingStatus(error instanceof Error ? error.message : "Unable to load tracking details.");
    } finally {
      setPendingAction(null);
    }
  }

  const selectedPlan = plans.find((plan) => plan.name === quotePlan) ?? plans[1];
  const selectedStartingBand = selectedPlan.bands[0];
  const bookingContext = [
    `${bookingPlan} plan`,
    zones[bookingZone].label,
    bookingArea ? bookingArea : "area open",
    "vendor auto-assigned",
  ];

  return (
    <main className="siteShell">
      <a className="skipLink" href="#booking">Skip to booking</a>

      <header className="siteHeader" id="top">
        <a className="brand" href="#top" aria-label="Bubble Wash home" onClick={() => setMobileOpen(false)}>
          <Image className="brandMark" src="/bubble-wash-icon.jpg" alt="Bubble Wash logo" width={58} height={58} priority />
          <span>Bubble Wash</span>
        </a>
        <button className="menuButton" type="button" aria-controls="site-navigation" aria-expanded={mobileOpen} aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"} onClick={() => setMobileOpen(!mobileOpen)}>
          <span>{mobileOpen ? "Close" : "Menu"}</span>
        </button>
        <nav id="site-navigation" className={mobileOpen ? "navLinks open" : "navLinks"} data-open={mobileOpen} aria-hidden={isMobileNav && !mobileOpen ? true : undefined}>
          <a href="#services" onClick={() => setMobileOpen(false)}>How it works</a>
          <a href="#quick-actions" onClick={() => setMobileOpen(false)}>Price and track</a>
          <a href="#booking" onClick={() => setMobileOpen(false)}>Book pickup</a>
          <a href="/staff" onClick={() => setMobileOpen(false)}>Staff</a>
          <a className="navCta" href="https://wa.me/233550000000?text=Hi%20Bubble%20Wash%2C%20I%20want%20to%20schedule%20a%20laundry%20pickup" target="_blank" rel="noopener noreferrer" onClick={() => setMobileOpen(false)}>WhatsApp</a>
        </nav>
      </header>

      <section className="homeHero pageShell" aria-labelledby="home-title">
        <div className="homeHeroCopy">
          <p className="sectionLabel">Laundry pickup / Accra</p>
          <h1 id="home-title">Laundry pickup and delivery in Accra.</h1>
          <p className="lead">Book a pickup, track your order, and get updates from collection to delivery.</p>
          <div className="heroActions">
            <a className="button primary" href="#booking">Book pickup</a>
            <a className="button secondary" href="#quick-actions">Track or price</a>
          </div>
          <form className="coverageForm serviceForm" method="post" onSubmit={checkCoverage}>
            <label htmlFor="coverageArea">Check pickup coverage</label>
            <div className="inlineFormRow"><input id="coverageArea" name="coverageArea" value={coverageArea} onChange={(event) => setCoverageArea(event.target.value)} placeholder="e.g. Osu, Labone, East Legon" autoComplete="address-level2" /><button className="button primary" type="submit" disabled={pendingAction === "coverage"}>{pendingAction === "coverage" ? "Checking..." : "Check"}</button></div>
            <div className="quickTextLinks" aria-label="Popular coverage areas">{popularAreas.map((area) => <button key={area} type="button" onClick={() => choosePopularArea(area)} disabled={pendingAction === "coverage"}>{area}</button>)}</div>
          </form>
          <p className={statusTone(coverageStatus)} role="status" aria-live="polite">{coverageStatus}</p>
        </div>
        <aside className="servicePanel" aria-labelledby="service-desk-title">
          <p className="sectionLabel">Today</p>
          <h2 id="service-desk-title">Today’s service desk</h2>
          <dl className="recordList">
            <div><dt>Pickup areas</dt><dd>Osu, Labone, East Legon, Airport</dd></div>
            <div><dt>Updates</dt><dd>WhatsApp and email</dd></div>
            <div><dt>Order reference</dt><dd>One code from pickup to delivery</dd></div>
            <div><dt>Current lane</dt><dd>{zones[zone].label} · {formatMoney(zones[zone].fee)} route fee</dd></div>
          </dl>
        </aside>
      </section>

      <section className="serviceFacts pageShell" aria-label="service proof points">{proof.map(([number, label]) => <div key={label}><strong>{number}</strong><span>{label}</span></div>)}</section>

      <section id="services" className="serviceSection pageShell" aria-labelledby="services-heading">
        <div className="sectionIntro"><p className="sectionLabel">How it works</p><h2 id="services-heading">A cleaner routine in three handoffs.</h2><p>Check your pickup lane, book once, then follow the same order reference through washing, payment, and delivery.</p></div>
        <ol className="workflowList">{customerFlow.map(([title, copy], index) => <li key={title}><span>{String(index + 1).padStart(2, "0")}</span><div><h3>{title}</h3><p>{copy}</p></div></li>)}</ol>
      </section>

      <section id="quick-actions" className="serviceSection pageShell" aria-labelledby="quick-actions-heading">
        <div className="sectionIntro"><p className="sectionLabel">Price, route, track</p><h2 id="quick-actions-heading">Useful checks before booking.</h2><p>Estimate a plan, confirm a pickup lane, or check an existing order reference.</p></div>
        <div className="serviceRecordGrid">
          <article className="serviceRecordBlock">
            <p className="sectionLabel">Estimate</p>
            <h3>{selectedPlan.name}</h3>
            <p>{selectedPlan.audience}</p>
            <dl className="miniFacts"><div><dt>Coordination fee</dt><dd>{selectedPlan.name === "Enterprise" ? "From " : ""}{formatMoney(selectedPlan.subscription)} / month</dd></div><div><dt>Pickups</dt><dd>{selectedPlan.monthlyPickups} / month</dd></div><div><dt>Rate starts</dt><dd>{selectedStartingBand ? `${formatMoney(selectedStartingBand.rate)} / kg from ${selectedStartingBand.min}kg` : "Custom"}</dd></div></dl>
            <form className="serviceForm" method="post" onSubmit={calculate}>
              <label>Plan<select value={quotePlan} onChange={(event) => setQuotePlan(event.target.value as PlanName)}>{plans.map((plan) => <option key={plan.name}>{plan.name}</option>)}</select></label>
              <label>Estimated kg<input type="number" min={1} max={10000} step={1} inputMode="numeric" value={kg} onChange={(event) => setKg(Number(event.target.value))} /></label>
              <button className="button primary" type="submit" disabled={pendingAction === "quote"}>{pendingAction === "quote" ? "Calculating..." : "Run estimate"}</button>
              <p className={statusTone(quoteStatus)} role="status" aria-live="polite">{quote ? `${formatMoney(quote.estimatedMonthlyTotal)} estimated monthly total` : quoteStatus}</p>
            </form>
          </article>
          <article className="serviceRecordBlock">
            <p className="sectionLabel">Coverage</p>
            <h3>{routePreview.zoneLabel}</h3>
            <p>{routePreview.zoneNote}</p>
            <div className="coverageRouteList">{coverageGroups.map((group) => <div key={group.title}><strong>{group.title}</strong><small>{group.fee}</small><p>{group.areas.join(" · ")}</p></div>)}</div>
            <button className="button secondary" type="button" onClick={() => document.getElementById("booking")?.scrollIntoView({ behavior: "smooth" })}>Use selected lane</button>
          </article>
          <article className="serviceRecordBlock">
            <p className="sectionLabel">Track</p>
            <h3>Follow one reference.</h3>
            <form className="serviceForm" method="post" onSubmit={trackOrder}>
              <label>Order reference<input name="trackingId" placeholder="BW-2081 or saved reference" autoComplete="off" /></label>
              <button className="button secondary" type="submit" disabled={pendingAction === "track"}>{pendingAction === "track" ? "Checking..." : "Check order"}</button>
              <p className={statusTone(trackingStatus)} role="status" aria-live="polite">{trackingResult ? `${trackingResult.status} · ${trackingResult.nextStep}` : trackingStatus}</p>
            </form>
            <a className="inlineAction" href="#booking">Book a new pickup</a>
          </article>
        </div>
      </section>

      <section id="booking" className="serviceSection pageShell" aria-labelledby="booking-heading">
        <div className="sectionIntro"><p className="sectionLabel">Book pickup</p><h2 id="booking-heading">Send the details once.</h2><p>Dispatch uses the same order record for pickup, vendor handoff, payment, and delivery.</p></div>
        <form className="bookingForm serviceForm" method="post" onSubmit={(event) => submitLead(event, "pickup-booking")}>
          <div className="formGrid two"><label>Contact name<input name="name" placeholder="Name" autoComplete="name" required /></label><label>Email<input name="email" type="email" placeholder="Email" autoComplete="email" required /></label></div>
          <div className="formGrid two"><label>Phone / WhatsApp<input name="phone" placeholder="Phone / WhatsApp" autoComplete="tel" required /></label><label>Company or household<input name="company" placeholder="Company or household" autoComplete="organization" required /></label></div>
          <div className="formGrid two"><label>Preferred plan<select name="preferredPlan" value={bookingPlan} onChange={(event) => setBookingPlan(event.target.value as PlanName)}>{plans.map((plan) => <option key={plan.name}>{plan.name}</option>)}</select></label><label>Pickup zone<select name="zone" value={bookingZone} onChange={(event) => setBookingZone(event.target.value as ZoneKey)}>{zoneEntries.map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label></div>
          <p className="bookingContextSummary">{bookingContext.join(" · ")}</p>
          <input type="hidden" name="requestedVendor" value="" />
          <div className="formGrid two"><label>Pickup area<input name="area" value={bookingArea} onChange={(event) => setBookingArea(event.target.value)} placeholder="Osu, Labone, East Legon..." autoComplete="address-level2" required /></label><label>Preferred pickup date<input name="pickupDate" type="date" min={minPickupDate} required /></label></div>
          <div className="formGrid two"><label>Estimated laundry weight<input name="kg" type="number" min={1} max={10000} step={1} inputMode="numeric" placeholder="e.g. 24" required /></label><label>Pickup window<select name="pickupWindow" defaultValue="Any available window"><option>Any available window</option><option>Morning</option><option>Afternoon</option><option>Evening</option></select></label></div>
          <textarea name="message" placeholder="Care notes, pickup instructions, stain notes, gate code, delivery constraints..." required />
          <button className="button primary" type="submit" disabled={pendingAction === "pickup-booking"}>{pendingAction === "pickup-booking" ? "Saving..." : "Submit pickup request"}</button>
          {formStatus["pickup-booking"] && <p className={statusTone(formStatus["pickup-booking"])} role="status" aria-live="polite">{formStatus["pickup-booking"]}</p>}
        </form>
      </section>

      <section className="paymentStrip pageShell" aria-labelledby="payment-heading"><p className="sectionLabel">Payment references</p><h3 id="payment-heading">Accepted payment lanes</h3><p>{paymentMethods.map(([label]) => label).join(" · ")}</p></section>

      <footer id="contact" className="footer pageShell"><div><div className="brand footerBrand"><Image className="brandMark" src="/bubble-wash-icon.jpg" alt="Bubble Wash logo" width={58} height={58} /><span>Bubble Wash</span></div><p>Laundry pickup and vendor fulfilment for Accra teams that need clean work without the back-and-forth.</p></div><div><h3>Use Bubble Wash</h3><a href="#booking">Book pickup</a><a href="#quick-actions">Estimate pricing</a><a href="#quick-actions">Coverage</a><a href="#quick-actions">Track order</a></div><div><h3>For operators</h3><a href="/staff">Staff login</a><a href="/login?next=/admin">Admin login</a><a href="/login?next=/vendors">Vendor login</a><a href="/login?next=/drivers">Driver login</a></div><div><h3>Get in touch</h3><p>Accra, Ghana</p><p>hello@bubblewashgh.com</p><p>WhatsApp: +233 55 000 0000</p></div></footer>
    </main>
  );
}
