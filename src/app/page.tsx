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
    <main>
      <a className="skipLink" href="#booking">Skip to booking</a>
      <div className="bubbleAtmosphere" aria-hidden="true"><span className="foamOrb orbOne" /><span className="foamOrb orbTwo" /><span className="foamOrb orbThree" /><span className="foamOrb orbFour" /><span className="foamOrb orbFive" /><span className="foamOrb orbSix" /><span className="foamTrail trailOne" /><span className="foamTrail trailTwo" /></div>
      <a className="backToTop" href="#top" aria-label="Back to top"><span aria-hidden="true">↑</span><b>Top</b></a>
      <header className="nav">
        <a className="brand" href="#top" aria-label="Bubble Wash home" onClick={() => setMobileOpen(false)}><Image className="brandMark" src="/bubble-wash-icon.jpg" alt="Bubble Wash logo" width={58} height={58} priority /><span>Bubble Wash</span></a>
        <button className="menuButton" type="button" aria-controls="site-navigation" aria-expanded={mobileOpen} aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"} onClick={() => setMobileOpen(!mobileOpen)}><span>{mobileOpen ? "Close" : "Menu"}</span><span className="menuIcon" aria-hidden="true">{mobileOpen ? "×" : "☰"}</span></button>
        <nav id="site-navigation" className={mobileOpen ? "navLinks open" : "navLinks"} data-open={mobileOpen} aria-hidden={isMobileNav && !mobileOpen ? true : undefined}>
          <a href="#services" onClick={() => setMobileOpen(false)}>Services</a>
          <a href="#quick-actions" onClick={() => setMobileOpen(false)}>Pricing</a>
          <a href="#quick-actions" onClick={() => setMobileOpen(false)}>Coverage</a>
          <a href="#quick-actions" onClick={() => setMobileOpen(false)}>Track Order</a>
          <a href="/staff" onClick={() => setMobileOpen(false)}>Staff Login</a>
          <a href="#booking" onClick={() => setMobileOpen(false)}>Book</a>
          <a className="navCta" href="https://wa.me/233550000000?text=Hi%20Bubble%20Wash%2C%20I%20want%20to%20schedule%20a%20laundry%20pickup" target="_blank" rel="noopener noreferrer" onClick={() => setMobileOpen(false)}>WhatsApp</a>
        </nav>
      </header>

      <section id="top" className="hero section">
        <div className="heroCopy">
          <p className="eyebrow">Laundry pickup / Accra</p>
          <h1>Laundry pickup and delivery in Accra.</h1>
          <p className="lead">Book a pickup, track your order, and get updates from collection to delivery.</p>
          <form className="coverageForm" method="post" onSubmit={checkCoverage}>
            <label className="coverageLabel" htmlFor="coverageArea">Check if we serve your area</label>
            <div className="coverageRow"><input id="coverageArea" name="coverageArea" value={coverageArea} onChange={(event) => setCoverageArea(event.target.value)} placeholder="e.g. Osu, Labone, East Legon" autoComplete="address-level2" /><button className="button primary" type="submit" disabled={pendingAction === "coverage"}>{pendingAction === "coverage" ? "Checking..." : "Check Coverage"}</button></div>
            <div className="coverageQuickChips" aria-label="Popular coverage areas">{popularAreas.map((area) => <button key={area} type="button" onClick={() => choosePopularArea(area)} disabled={pendingAction === "coverage"}>{area}</button>)}</div>
          </form>
          <p className={statusTone(coverageStatus)} role="status" aria-live="polite">{coverageStatus}</p>
          <div className="heroActions"><a className="button primary" href="#booking">Book a Pickup</a><a className="button secondary" href="#quick-actions">Check routes</a><a className="textLink" href="#quick-actions">Estimate price →</a></div>
          <div className="humanNote"><b>Clean handoff:</b> pickup, care notes, payment, and delivery updates stay on the same order trail.</div>
        </div>
        <div className="heroVisual heroSlider" aria-label="Bubble Wash live operations summary">
          <div className="slideOverlay" />
          <div className="washerPortal" aria-hidden="true"><Image src="/bubble-wash-icon.jpg" alt="" width={160} height={160} priority /><span className="washerRing ringOne" /><span className="washerRing ringTwo" /><span className="washerBubble b1" /><span className="washerBubble b2" /><span className="washerBubble b3" /><span className="washerBubble b4" /><span className="washerBubble b5" /><span className="washerBubble b6" /></div>
          <div className="visualCard orderCard"><span>Order trail</span><strong>BW-2081</strong><small>Pickup scheduled · Vendor washing · Delivery window set</small></div>
          <div className="visualCard timelineCard"><span>Live timeline</span><strong>Scheduled → Washing → Ready → Delivered</strong><small>One reference follows the customer, vendor, driver, and support desk.</small></div>
          <div className="visualCard mainBasket"><span>Today’s pickup</span><strong>82kg</strong><small>{zones[zone].label} · {formatMoney(zones[zone].fee)} route fee · Growth plan</small></div>
          <div className="foamTicket" aria-hidden="true"><span>soap trail</span><b>Osu → Labone</b></div><div className="careTag" aria-hidden="true"><span>care note</span><b>Sort · Wash · Fold</b><small>Partner checked</small></div>
        </div>
      </section>

      <section className="proofStrip tightProof" aria-label="service proof points">{proof.map(([number, label]) => <div key={label}><strong>{number}</strong><span>{label}</span></div>)}</section>

      <section id="services" className="section humanFlowSection compactHumanFlowSection">
        <div className="sectionHead narrow compactHead"><p className="eyebrow">How it works</p><h2>A cleaner routine in three handoffs.</h2><p>Check your pickup lane, book once, then follow the same order reference through washing, payment, and delivery.</p></div>
        <div className="humanFlowGrid">{customerFlow.map(([title, copy], index) => <article key={title}><span>{String(index + 1).padStart(2, "0")}</span><h3>{title}</h3><p>{copy}</p></article>)}</div>
      </section>

      <section id="quick-actions" className="section publicPickupDesk" aria-labelledby="quick-actions-heading">
        <div className="sectionHead compactHead"><p className="eyebrow">Pickup desk</p><h2 id="quick-actions-heading">Price, route, and track without opening a dashboard.</h2><p>Three practical checks before the request form. No long sales page, no fake controls.</p></div>
        <div className="pickupDeskGrid">
          <article className="pickupDeskPanel pickupDeskPrimary">
            <span className="deskLabel">Selected plan</span>
            <h3>{selectedPlan.name}</h3>
            <p>{selectedPlan.audience}</p>
            <div className="deskPrice"><strong>{selectedPlan.name === "Enterprise" ? "From " : ""}{formatMoney(selectedPlan.subscription)}</strong><span>/ month coordination fee</span></div>
            <div className="deskFacts">
              <span><b>{selectedPlan.monthlyPickups}</b><small>pickups / month</small></span>
              <span><b>{selectedStartingBand ? `${selectedStartingBand.min}kg+` : "custom"}</b><small>per pickup</small></span>
              <span><b>{selectedStartingBand ? formatMoney(selectedStartingBand.rate) : "Custom"}</b><small>/ kg from</small></span>
            </div>
            <form className="deskMiniForm" method="post" onSubmit={calculate}>
              <label>Plan<select value={quotePlan} onChange={(event) => setQuotePlan(event.target.value as PlanName)}>{plans.map((plan) => <option key={plan.name}>{plan.name}</option>)}</select></label>
              <label>Estimated kg<input type="number" min={1} max={10000} step={1} inputMode="numeric" value={kg} onChange={(event) => setKg(Number(event.target.value))} /></label>
              <button className="button primary full" type="submit" disabled={pendingAction === "quote"}>{pendingAction === "quote" ? "Calculating..." : "Run estimate"}</button>
              <p className={statusTone(quoteStatus)} role="status" aria-live="polite">{quote ? `${formatMoney(quote.estimatedMonthlyTotal)} estimated monthly total` : quoteStatus}</p>
            </form>
          </article>
          <article className="pickupDeskPanel">
            <span className="deskLabel">Coverage</span>
            <h3>{routePreview.zoneLabel}</h3>
            <p>{routePreview.zoneNote}</p>
            <div className="coverageRouteList compactRouteList">{coverageGroups.map((group) => <div key={group.title}><strong>{group.title}</strong><small>{group.fee}</small><p>{group.areas.join(" · ")}</p></div>)}</div>
            <button className="button secondary full" type="button" onClick={() => document.getElementById("booking")?.scrollIntoView({ behavior: "smooth" })}>Use selected lane</button>
          </article>
          <article className="pickupDeskPanel">
            <span className="deskLabel">Track or pay</span>
            <h3>Follow one reference.</h3>
            <form className="deskMiniForm" method="post" onSubmit={trackOrder}>
              <label>Order reference<input name="trackingId" placeholder="BW-2081 or saved reference" autoComplete="off" /></label>
              <button className="button secondary full" type="submit" disabled={pendingAction === "track"}>{pendingAction === "track" ? "Checking..." : "Check order"}</button>
              <p className={statusTone(trackingStatus)} role="status" aria-live="polite">{trackingResult ? `${trackingResult.status} · ${trackingResult.nextStep}` : trackingStatus}</p>
            </form>
            <a className="button primary full" href="#booking">Book pickup</a>
          </article>
        </div>
      </section>

      <section id="booking" className="section schedule soft compactBookingSection">
        <div className="sectionHead compactHead"><p className="eyebrow">Book pickup</p><h2>Send the details once. Dispatch uses the same order record.</h2></div>
        <div className="scheduleGrid twoCols bookingOnlyGrid"><form className="panel" method="post" onSubmit={(event) => submitLead(event, "pickup-booking")}><h3>Pickup request</h3><div className="two"><label>Contact name<input name="name" placeholder="Name" autoComplete="name" required /></label><label>Email<input name="email" type="email" placeholder="Email" autoComplete="email" required /></label></div><div className="two"><label>Phone / WhatsApp<input name="phone" placeholder="Phone / WhatsApp" autoComplete="tel" required /></label><label>Company or household<input name="company" placeholder="Company or household" autoComplete="organization" required /></label></div><div className="two"><label>Preferred plan<select name="preferredPlan" value={bookingPlan} onChange={(event) => setBookingPlan(event.target.value as PlanName)}>{plans.map((plan) => <option key={plan.name}>{plan.name}</option>)}</select></label><label>Pickup zone<select name="zone" value={bookingZone} onChange={(event) => setBookingZone(event.target.value as ZoneKey)}>{zoneEntries.map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label></div><div className="bookingContextSummary" aria-label="Current booking context">{bookingContext.map((item) => <span key={item}>{item}</span>)}</div><input type="hidden" name="requestedVendor" value="" /><div className="two"><label>Pickup area<input name="area" value={bookingArea} onChange={(event) => setBookingArea(event.target.value)} placeholder="Osu, Labone, East Legon..." autoComplete="address-level2" required /></label><label>Preferred pickup date<input name="pickupDate" type="date" min={minPickupDate} required /></label></div><div className="two"><label>Estimated laundry weight<input name="kg" type="number" min={1} max={10000} step={1} inputMode="numeric" placeholder="e.g. 24" required /></label><label>Pickup window<select name="pickupWindow" defaultValue="Any available window"><option>Any available window</option><option>Morning pickup</option><option>Afternoon pickup</option><option>Evening pickup</option></select></label></div><div className="two"><label>Payment preference<select name="paymentPreference"><option>MTN MoMo</option><option>Telecel Cash</option><option>Card</option><option>Bank transfer</option><option>Invoice me</option></select></label><label>Alert preference<select name="alertPreference"><option>Email + WhatsApp alerts</option><option>WhatsApp only</option><option>Email only</option><option>Call me</option></select></label></div><label>Pickup notes<textarea name="message" maxLength={1200} placeholder="Textile type, special instructions, stain/damage notes, access details..." /></label><button className="button primary full" type="submit" disabled={pendingAction === "pickup-booking"}>{pendingAction === "pickup-booking" ? "Saving pickup request..." : "Request Pickup"}</button>{formStatus["pickup-booking"] && <p className={statusTone(formStatus["pickup-booking"])} role="status" aria-live="polite">{formStatus["pickup-booking"]}</p>}</form><aside className="bookingSideCard panel"><h3>Need help before booking?</h3><p>Use the pickup desk above to estimate price, confirm coverage, or check an order reference. WhatsApp stays available for details that need a person.</p><a className="button secondary full" href="#quick-actions">Back to pickup desk</a><a className="button primary full" href="https://wa.me/233550000000?text=Hi%20Bubble%20Wash%2C%20I%20want%20to%20schedule%20a%20laundry%20pickup" target="_blank" rel="noopener noreferrer">WhatsApp Bubble Wash</a></aside></div>
      </section>

      <section className="paymentStrip" aria-labelledby="payment-heading"><p className="eyebrow">Payment references</p><h3 id="payment-heading">Accepted payment lanes</h3><div className="paymentLogoGrid">{paymentMethods.map(([label, className]) => <span className={`paymentLogo ${className}`} key={label} role="img" aria-label={label} title={label}><span className="srOnly">{label}</span></span>)}</div></section>

      <footer id="contact" className="footer"><div><div className="brand footerBrand"><Image className="brandMark" src="/bubble-wash-icon.jpg" alt="Bubble Wash logo" width={58} height={58} /><span>Bubble Wash</span></div><p>Laundry pickup and vendor fulfilment for Accra teams that need clean work without the back-and-forth.</p></div><div><h3>Use Bubble Wash</h3><a href="#booking">Book pickup</a><a href="#quick-actions">Estimate pricing</a><a href="#quick-actions">Coverage</a><a href="#quick-actions">Track order</a></div><div><h3>For operators</h3><a href="/staff">Staff login</a><a href="/login?next=/admin">Admin login</a><a href="/login?next=/vendors">Vendor login</a><a href="/login?next=/drivers">Driver login</a></div><div><h3>Get in touch</h3><p>Accra, Ghana</p><p>hello@bubblewashgh.com</p><p>WhatsApp: +233 55 000 0000</p></div></footer>
    </main>
  );
}
