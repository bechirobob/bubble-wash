"use client";

import Image from "next/image";
import { FormEvent, useMemo, useState } from "react";
import { buildRoutePreview, type RoutePreview } from "@/lib/maps";
import { addons, discounts, plans, zones, type AddonKey, type DiscountKey, type PlanName, type ZoneKey } from "@/lib/pricing";

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
  eventCount?: number;
  updatedAt?: string;
  route?: RoutePreview;
};

const services = [
  ["Wash + fold", "Everyday laundry returned clean, packed, and tied to one order reference.", "01"],
  ["Ironing", "Uniforms, shirts, napkins, and guest-facing linen finished before delivery.", "02"],
  ["Commercial linen", "Hotels, clinics, restaurants, and teams can schedule repeat pickup cycles.", "03"],
  ["Express routing", "Urgent loads can be flagged for faster vendor assignment and dispatch follow-up.", "04"],
];

const locations = ["Osu", "Labone", "Cantonments", "Airport", "East Legon", "Dzorwulu", "Spintex", "Madina", "Tema by confirmation"];

const vendors = [
  ["CleanPro Laundry Services", "East Legon", "Certified", "Express", "72% on-time return", "linen"],
  ["SparkleWash Ghana", "Airport Residential", "Certified", "24/7", "night dispatch", "machines"],
  ["FreshLinens Co.", "Tema Community 25", "Express", "Bulk", "hotel linen", "fold"],
  ["Pristine Care Laundry", "Cantonments", "Certified", "Same day", "garment care", "steam"],
];

const testimonials = [
  ["Pickup windows are finally predictable. We stopped chasing three vendors every weekend.", "Ama Mensah", "Housekeeping Director"],
  ["The booking flow gives my team enough detail to plan linen movement before the driver arrives.", "Kwame Asante", "Restaurant Operations"],
  ["Vendor matching and support follow-up are what make this useful for hospitality work.", "Yaw Boateng", "Catering Manager"],
];

const faqs = [
  ["Can I book a one-time pickup?", "Yes. The service supports subscriptions, but the booking form can also capture one-time requests and custom pickup notes."],
  ["Do payments work on the site yet?", "The payment screen is ready as a checkout request flow. Real card or MoMo charging needs Paystack, Flutterwave, or mobile money credentials before we turn on live payments."],
  ["Will I receive email alerts?", "The site now captures alert preferences with every booking. Real email sending needs SMTP, Resend, SendGrid, or another email provider key."],
  ["What areas are covered?", "Core Accra routes have no extra route fee. Near-route and outer-route pickups add delivery fees so pricing stays honest."],
  ["Can vendors manage their availability?", "Yes. Vendors use the staff login to update daily capacity, route area, services, and job status without crowding the customer page."],
  ["What does the admin section do?", "Admin work now lives behind login on separate pages for operations, vendor coordination, and support tickets."],
];

const proof = [
  ["24h", "standard return target"],
  ["7", "days scheduling"],
  ["8", "Accra route zones"],
  ["1", "shared order timeline"],
];

const operationsPillars = [
  ["Book", "Schedule pickup, service type, area, alerts, and payment preference from one flow."],
  ["Route", "Dispatch sees route zone, bag count, pickup notes, vendor assignment, and ETA."],
  ["Track", "Customer, admin, vendor, and support read from the same Order ID timeline."],
  ["Resolve", "Support can connect delays, missing items, QR intake notes, and payment status."],
];

const trackingStages = ["Received", "Pickup scheduled", "Vendor assigned", "In washing", "Ready for delivery", "Delivered"];

const liveTrackingPlan = [
  ["MVP now", "Customers see status, vendor, route zone, and Google Maps directions from the saved order timeline."],
  ["Driver app next", "Drivers opt into browser Geolocation on HTTPS and send timed location pings while active on a delivery."],
  ["Production later", "Use Maps JavaScript API for live markers, Routes API for ETA/traffic, and server-side retention rules for privacy."],
];

const assuranceItems = [
  ["Clear intake", "Route, textile notes, alert preference, and payment lane are captured before dispatch."],
  ["Vendor accountability", "Acceptance, washing, finishing, and ready-for-driver updates attach to the timeline."],
  ["Commercial controls", "Bag counts, shortages, and invoice notes stay tied to the customer account."],
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

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-GH", { style: "currency", currency: "GHS", maximumFractionDigits: 0 }).format(value);
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
  const [discount, setDiscount] = useState<DiscountKey>("newPilot");
  const [kg, setKg] = useState(82);
  const [selectedAddons, setSelectedAddons] = useState<AddonKey[]>(["ironing"]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteStatus, setQuoteStatus] = useState("Choose your plan, route, and add-ons to see a realistic monthly estimate.");
  const [activeFaq, setActiveFaq] = useState(0);
  const [formStatus, setFormStatus] = useState<Record<string, string>>({});
  const [mobileOpen, setMobileOpen] = useState(false);
  const [coverageStatus, setCoverageStatus] = useState("Enter your area to check pickup coverage.");
  const [routePreview, setRoutePreview] = useState<RoutePreview>(() => buildRoutePreview("core", "Core Accra route"));
  const [trackingStatus, setTrackingStatus] = useState("Enter a booking/reference ID after submitting a request.");
  const [trackingResult, setTrackingResult] = useState<TrackingResult | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const addonEntries = useMemo(() => Object.entries(addons) as Array<[AddonKey, (typeof addons)[AddonKey]]>, []);
  const zoneEntries = useMemo(() => Object.entries(zones) as Array<[ZoneKey, (typeof zones)[ZoneKey]]>, []);
  const discountEntries = useMemo(() => Object.entries(discounts) as Array<[DiscountKey, (typeof discounts)[DiscountKey]]>, []);

  async function calculate(event?: FormEvent) {
    event?.preventDefault();
    setPendingAction("quote");
    setQuoteStatus("Calculating estimate...");
    try {
      const result = await postJSON<{ ok: boolean; quote: Quote }>("/api/quote", { plan: quotePlan, kg, addons: selectedAddons, zone, discount });
      setQuote(result.quote);
      setQuoteStatus("Estimate calculated. Use this as the starting point before checkout or booking.");
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
      form.reset();
    } catch (error) {
      setFormStatus((current) => ({ ...current, [type]: error instanceof Error ? error.message : "Unable to save request." }));
    } finally {
      setPendingAction(null);
    }
  }

  function toggleAddon(key: AddonKey) {
    setSelectedAddons((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
  }

  function routeZoneForArea(area: string): ZoneKey {
    const normalized = area.toLowerCase();
    if (["tema", "community", "outer"].some((item) => normalized.includes(item))) return "outer";
    if (["spintex", "madina", "dzorwulu", "ridge", "near"].some((item) => normalized.includes(item))) return "near";
    if (["custom", "kasoa", "adenta"].some((item) => normalized.includes(item))) return "custom";
    return "core";
  }

  async function checkCoverage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const area = String(new FormData(event.currentTarget).get("coverageArea") ?? "").trim();
    const matched = locations.find((location) => area.toLowerCase().includes(location.split(" ")[0].toLowerCase()));
    const selectedZone = routeZoneForArea(area || matched || "core");
    setCoverageStatus("Checking coverage and route map...");
    try {
      const response = await fetch(`/api/route-preview?zone=${encodeURIComponent(selectedZone)}&area=${encodeURIComponent(area || matched || "Core Accra route")}`);
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Route preview failed.");
      setRoutePreview(data.route);
      setCoverageStatus(matched ? `${matched} is covered. Route map and Google Maps directions are ready below.` : `${area || "That area"} may still be serviceable. Dispatch can confirm route pricing; use the map preview as a planning estimate.`);
    } catch (error) {
      setRoutePreview(buildRoutePreview(selectedZone, area || matched || "Core Accra route"));
      setCoverageStatus(error instanceof Error ? error.message : "Unable to check route preview.");
    }
  }

  function chooseVendor(name: string) {
    setFormStatus((current) => ({ ...current, ["vendor-choice"]: `${name} selected. Complete the booking form below so dispatch can confirm capacity.` }));
    document.getElementById("booking")?.scrollIntoView({ behavior: "smooth" });
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
      setTrackingStatus("Tracking record loaded from saved order requests.");
    } catch (error) {
      setTrackingResult(null);
      setTrackingStatus(error instanceof Error ? error.message : "Unable to load tracking details.");
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <main>
      <a className="skipLink" href="#booking">Skip to booking</a>
      <header className="nav">
        <a className="brand" href="#top" aria-label="Bubble Wash home">
          <Image className="brandMark" src="/bubble-wash-icon.jpg" alt="Bubble Wash logo" width={58} height={58} priority />
          <span>Bubble Wash</span>
        </a>
        <button
          className="menuButton"
          type="button"
          aria-controls="site-navigation"
          aria-expanded={mobileOpen}
          aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
          onKeyDown={(event) => {
            if (event.key === "Escape") setMobileOpen(false);
          }}
          onClick={() => setMobileOpen(!mobileOpen)}
        >
          <span>{mobileOpen ? "Close" : "Menu"}</span>
          <span className="menuIcon" aria-hidden="true">{mobileOpen ? "×" : "☰"}</span>
        </button>
        <nav id="site-navigation" className={mobileOpen ? "navLinks open" : "navLinks"} data-open={mobileOpen}>
          <a href="#services" onClick={() => setMobileOpen(false)}>Services</a>
          <a href="#plans" onClick={() => setMobileOpen(false)}>Plans</a>
          <a href="#booking" onClick={() => setMobileOpen(false)}>Book</a>
          <a href="#track" onClick={() => setMobileOpen(false)}>Track</a>
          <a href="#locations" onClick={() => setMobileOpen(false)}>Map</a>
          <a href="#vendors-public" onClick={() => setMobileOpen(false)}>Vendors</a>
          <a href="#onboarding" onClick={() => setMobileOpen(false)}>Create account</a>
          <a href="#faq" onClick={() => setMobileOpen(false)}>FAQ</a>
          <a href="/login" onClick={() => setMobileOpen(false)}>Staff Login</a>
          <a className="navCta" href="https://wa.me/233550000000?text=Hi%20Bubble%20Wash%2C%20I%20want%20to%20schedule%20a%20laundry%20pickup" target="_blank" rel="noreferrer" onClick={() => setMobileOpen(false)}>WhatsApp</a>
        </nav>
      </header>

      <section id="top" className="hero section">
        <div className="heroCopy">
          <p className="eyebrow">Accra laundry pickup · subscriptions · vendor fulfilment</p>
          <h1>Accra laundry pickup with real order visibility.</h1>
          <p className="lead">Bubble Wash coordinates pickup, vendor fulfilment, route updates, payments, and support for households and commercial teams that need clean laundry back on schedule.</p>
          <form className="coverageForm" onSubmit={checkCoverage}>
            <input name="coverageArea" placeholder="Enter your area or business location" aria-label="Coverage area" />
            <button className="button primary" type="submit">Check Coverage</button>
          </form>
          <p className="status" role="status" aria-live="polite">{coverageStatus}</p>
          <div className="heroActions">
            <a className="button primary" href="#booking">Book a Pickup</a>
            <a className="button secondary" href="#quote">Estimate Price</a>
          </div>
          <div className="humanNote"><b>Built for Accra operations:</b> traffic-aware routes, repeat pickups, vendor capacity, MoMo and invoice preferences, and status updates before customers have to chase.</div>
        </div>
        <div className="heroVisual heroSlider" aria-label="Bubble Wash live operations summary">
          <div className="slideOverlay" />
          <div className="visualCard orderCard"><span>Live order</span><strong>BW-2081</strong><small>Pickup scheduled · Vendor assigned · Customer notified</small></div>
          <div className="visualCard mainBasket"><span>Today’s route</span><strong>82kg</strong><small>Growth plan · Core Accra · ironing added · return window set</small></div>
          <div className="routeCard"><b>Route fee</b><span>{zones[zone].label}</span><strong>{formatMoney(zones[zone].fee)}</strong></div>
          <div className="ratingCard"><b>4.8★</b><span>service confidence</span></div>
        </div>
      </section>

      <section className="proofStrip" aria-label="service proof points">
        {proof.map(([number, label]) => <div key={label}><strong>{number}</strong><span>{label}</span></div>)}
      </section>

      <section id="plans" className="section soft">
        <div className="sectionHead">
          <p className="eyebrow">Plans that do not pretend every customer is the same</p>
          <h2>Pick a subscription rhythm, then adjust by weight, route, and add-ons.</h2>
          <p>Each plan connects to weight, pickup rhythm, route fees, finishing add-ons, and payment preference — the same inputs dispatch needs to fulfil the order.</p>
        </div>
        <div className="plansGrid">
          {plans.map((plan) => (
            <article className={plan.badge ? "planCard featured" : "planCard"} key={plan.name}>
              {plan.badge && <span className="badge">{plan.badge}</span>}
              <h3>{plan.name}</h3>
              <p>{plan.description}</p>
              <div className="price">{plan.name === "Enterprise" ? "From " : ""}{formatMoney(plan.subscription)}<small>/ month coordination fee</small></div>
              <p className="pickup">{plan.pickups}</p>
              <ul>{plan.features.map((feature) => <li key={feature}>✓ {feature}</li>)}</ul>
              <a className="button primary full" href="#booking">{plan.name === "Enterprise" ? "Request Quote" : "Start with this plan"}</a>
            </article>
          ))}
        </div>
      </section>

      <section className="section opsCommand">
        <div className="sectionHead compactHead">
          <p className="eyebrow">Operations engine</p>
          <h2>One customer promise, one order timeline behind it.</h2>
          <p>Booking, routing, vendor updates, and support stay connected so customers are not chasing four different people.</p>
        </div>
        <div className="commandGrid">{operationsPillars.map(([title, copy], index) => <article key={title}><span>{String(index + 1).padStart(2, "0")}</span><h3>{title}</h3><p>{copy}</p></article>)}</div>
      </section>

      <section id="services" className="section">
        <div className="sectionHead narrow compactHead">
          <p className="eyebrow">What Bubble Wash handles</p>
          <h2>Core laundry jobs, without the clutter.</h2>
        </div>
        <div className="serviceGrid compactServiceGrid">{services.map(([title, copy, number]) => <article className="serviceCard" key={title}><div className="serviceIcon">{number}</div><h3>{title}</h3><p>{copy}</p></article>)}</div>
      </section>

      <section id="vendors-public" className="section vendorShowcase">
        <div className="sectionHead">
          <p className="eyebrow">Trusted laundry partners</p>
          <h2>Vetted vendors with real capacity, route areas, and service tags.</h2>
          <p>Partner cards show service coverage and operational strengths. Choosing a vendor moves straight to booking so dispatch can confirm capacity against the route.</p>
        </div>
        <div className="vendorShowcaseGrid">
          {vendors.map(([name, area, tagOne, tagTwo, metric, tone]) => (
            <article className="vendorShowcaseCard" key={name}>
              <div className={`vendorPhoto ${tone}`}><span>{metric}</span></div>
              <div><h3>{name}</h3><p>{area}</p><div className="tagRow"><span>{tagOne}</span><span>{tagTwo}</span></div></div>
              <button className="button primary full" type="button" onClick={() => chooseVendor(name)}>Request Service</button>
            </article>
          ))}
        </div>
        {formStatus["vendor-choice"] && <p className="status success">{formStatus["vendor-choice"]}</p>}
      </section>

      <section id="locations" className="section locationSection">
        <div className="sectionHead">
          <p className="eyebrow">Route coverage + Google Maps</p>
          <h2>Start with clear Accra zones instead of promising the whole city overnight.</h2>
          <p>These areas feed the zone pricing in the calculator. Google Maps links open real search/directions without storing customer GPS coordinates.</p>
        </div>
        <div className="mapCoverageGrid">
          <div>
            <div className="locationGrid">{locations.map((item) => <span key={item}>{item}</span>)}</div>
            <div className="mapResearchCard">
              <h3>Google Maps integration approach</h3>
              <p>Research call: Maps URLs work without an API key for search/directions. Live embedded maps, styled markers, traffic ETAs, and Routes API need Google Cloud billing, restricted API keys, and privacy controls.</p>
            </div>
          </div>
          <aside className="routeMapCard" aria-label="Route map preview">
            <div className="routeMapCanvas">
              <span className="mapPin hubPin">Hub</span>
              <span className="routeLine" />
              <span className="mapPin pickupPin">Pickup</span>
            </div>
            <div className="routeMapBody">
              <span className="badge">{routePreview.zoneLabel}</span>
              <h3>{routePreview.pickup.label}</h3>
              <p>{routePreview.zoneNote}</p>
              <div className="miniRows light"><span>Estimated drive: {routePreview.estimatedDriveMinutes ? `${routePreview.estimatedDriveMinutes} min` : "Confirm first"}</span><span>Planning distance: {routePreview.estimatedDistanceKm ? `${routePreview.estimatedDistanceKm} km` : "Custom route"}</span></div>
              <div className="mapActions">
                <a className="button primary" href={routePreview.directionsUrl} target="_blank" rel="noreferrer">Open Directions</a>
                <a className="button secondary" href={routePreview.googleMapsUrl} target="_blank" rel="noreferrer">View Area</a>
              </div>
            </div>
          </aside>
        </div>
      </section>

      <section id="quote" className="section quoteSection">
        <div className="sectionHead">
          <p className="eyebrow">Live quote calculator</p>
          <h2>Get a quote that dispatch can actually work with.</h2>
        </div>
        <div className="quoteGrid">
          <form className="panel largePanel" onSubmit={calculate}>
            <div className="two"><label>Plan<select value={quotePlan} onChange={(e) => setQuotePlan(e.target.value as PlanName)}>{plans.map((plan) => <option key={plan.name}>{plan.name}</option>)}</select></label><label>Estimated kg per pickup<input type="number" min={1} value={kg} onChange={(e) => setKg(Number(e.target.value))} /></label></div>
            <div className="two"><label>Pickup zone<select value={zone} onChange={(e) => setZone(e.target.value as ZoneKey)}>{zoneEntries.map(([key, item]) => <option key={key} value={key}>{item.label} · {formatMoney(item.fee)}</option>)}</select></label><label>Discount<select value={discount} onChange={(e) => setDiscount(e.target.value as DiscountKey)}>{discountEntries.map(([key, item]) => <option key={key} value={key}>{item.label} · {Math.round(item.percent * 100)}%</option>)}</select></label></div>
            <div className="addonGrid">{addonEntries.map(([key, addon]) => <label key={key} className="check"><input type="checkbox" checked={selectedAddons.includes(key)} onChange={() => toggleAddon(key)} /> {addon.label}</label>)}</div>
            <button className="button primary full" type="submit" disabled={pendingAction === "quote"}>{pendingAction === "quote" ? "Calculating..." : "Calculate estimate"}</button>
            <p className="status" role="status" aria-live="polite">{quoteStatus}</p>
          </form>
          <aside className="quoteResult">
            <h3>Estimated monthly total</h3>
            {quote ? <><strong>{formatMoney(quote.estimatedMonthlyTotal)}</strong><p>{quote.plan} · {quote.pickupRhythm}</p><div className="miniRows"><span>Per pickup: {formatMoney(quote.perPickupTotal)}</span><span>Route fee: {formatMoney(quote.zoneFee)}</span><span>Add-ons: {formatMoney(quote.addonsPerPickup)}</span><span>Discount: −{formatMoney(quote.discountAmount)}</span></div></> : <><strong>Run estimate</strong><p>Choose the plan, zone, discount, and add-ons first.</p></>}
          </aside>
        </div>
      </section>

      <section className="section assuranceSection">
        <div className="sectionHead compactHead">
          <p className="eyebrow">Service assurance</p>
          <h2>Trust signals built into the workflow.</h2>
          <p>Less promise-stacking, more practical controls for pickup, vendor handoff, and billing clarity.</p>
        </div>
        <div className="assuranceGrid">{assuranceItems.map(([title, copy]) => <article key={title}><h3>{title}</h3><p>{copy}</p></article>)}</div>
      </section>

      <section id="track" className="section trackingSection soft">
        <div className="sectionHead">
          <p className="eyebrow">Order tracking</p>
          <h2>Customers can track a real order reference without calling support.</h2>
          <p>Tracking reads the shared order timeline and returns a clean customer view: status, vendor, area, payment lane, event count, and next step.</p>
        </div>
        <div className="trackingGrid">
          <form className="panel trackingPanel" onSubmit={trackOrder}>
            <h3>Track a Bubble Wash request</h3>
            <input name="trackingId" placeholder="Reference e.g. BW-1760000000000" aria-label="Tracking reference" />
            <button className="button primary full" type="submit" disabled={pendingAction === "track"}>{pendingAction === "track" ? "Checking..." : "Check Status"}</button>
            <p className="status" role="status" aria-live="polite">{trackingStatus}</p>
          </form>
          <aside className="trackingResult">
            {trackingResult ? <>
              <span>{trackingResult.type}</span>
              <h3>{trackingResult.id}</h3>
              <strong>{trackingResult.status}</strong>
              <p>{trackingResult.customer}</p>
              <div className="miniRows"><span>Vendor: {trackingResult.vendor || "Pending assignment"}</span><span>Area: {trackingResult.area}</span><span>Payment: {trackingResult.payment}</span><span>Events: {trackingResult.eventCount ?? 1}</span><span>Updated: {new Date(trackingResult.updatedAt || trackingResult.createdAt).toLocaleString()}</span></div>
              <p>{trackingResult.nextStep}</p>
              {trackingResult.route && <div className="trackingMapActions"><a className="button primary" href={trackingResult.route.directionsUrl} target="_blank" rel="noreferrer">Open Google Maps Route</a><a className="button secondary" href={trackingResult.route.googleMapsUrl} target="_blank" rel="noreferrer">View Pickup Area</a></div>}
            </> : <>
              <span>Tracking stages</span>
              <div className="stageList">{trackingStages.map((stage, index) => <div key={stage}><b>{index + 1}</b><span>{stage}</span></div>)}</div>
            </>}
          </aside>
        </div>
        <div className="liveTrackingGrid">
          {liveTrackingPlan.map(([title, copy]) => <article key={title}><h3>{title}</h3><p>{copy}</p></article>)}
        </div>
      </section>



      <section id="booking" className="section schedule soft">
        <div className="sectionHead">
          <p className="eyebrow">Booking + alerts + payment preference</p>
          <h2>Customers can request pickup, choose payment preference, and opt into alerts.</h2>
          <p>Use this to request a pickup, record the service details dispatch needs, and receive a Bubble Wash reference ID for tracking.</p>
        </div>
        <div className="scheduleGrid twoCols">
          <form className="panel" onSubmit={(event) => submitLead(event, "pickup-booking")}>
            <h3>Book laundry pickup</h3>
            <p className="formHint">Dispatch needs these details to confirm route, vendor capacity, and customer alerts.</p>
            <div className="two"><label>Contact name<input name="name" placeholder="Name" autoComplete="name" required /></label><label>Email<input name="email" type="email" placeholder="Email" autoComplete="email" required /></label></div>
            <div className="two"><label>Phone / WhatsApp<input name="phone" placeholder="Phone / WhatsApp" autoComplete="tel" required /></label><label>Company or household<input name="company" placeholder="Company or household" autoComplete="organization" required /></label></div>
            <div className="two"><label>Preferred plan<select name="preferredPlan">{plans.map((plan) => <option key={plan.name}>{plan.name}</option>)}</select></label><label>Pickup zone<select name="zone">{zoneEntries.map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label></div>
            <div className="two"><label>Pickup area<input name="area" placeholder="Osu, Labone, East Legon..." autoComplete="address-level2" /></label><label>Preferred pickup date<input name="pickupDate" type="date" /></label></div>
            <div className="two"><label>Payment preference<select name="paymentPreference"><option>MTN MoMo</option><option>Telecel Cash</option><option>Card</option><option>Bank transfer</option><option>Invoice me</option></select></label><label>Alert preference<select name="alertPreference"><option>Email + WhatsApp alerts</option><option>WhatsApp only</option><option>Email only</option><option>Call me</option></select></label></div>
            <label>Pickup notes<textarea name="message" placeholder="Textile type, special instructions, preferred time window..." /></label>
            <button className="button primary full" type="submit" disabled={pendingAction === "pickup-booking"}>{pendingAction === "pickup-booking" ? "Saving pickup request..." : "Request Pickup"}</button>
            {formStatus["pickup-booking"] && <p className="status success" role="status" aria-live="polite">{formStatus["pickup-booking"]}</p>}
          </form>

          <form className="panel paymentPanel" onSubmit={(event) => submitLead(event, "checkout-request")}>
            <h3>Payment checkout request</h3>
            <p className="formHint">This records a checkout request only. Live charging still needs payment-provider credentials.</p>
            <label>Billing name<input name="name" placeholder="Billing name" autoComplete="name" required /></label>
            <label>Billing email<input name="email" type="email" placeholder="Billing email" autoComplete="email" required /></label>
            <label>Phone / MoMo number<input name="phone" placeholder="Phone / MoMo number" autoComplete="tel" required /></label>
            <label>Business / account name<input name="company" placeholder="Business / account name" autoComplete="organization" required /></label>
            <div className="two"><label>Amount<input name="amount" placeholder="GHS 2250" inputMode="decimal" /></label><label>Payment method<select name="paymentMethod"><option>MTN MoMo</option><option>Telecel Cash</option><option>Visa / Mastercard</option><option>Bank transfer</option></select></label></div>
            <label>Invoice notes<textarea name="message" placeholder="Payment reference, invoice notes, or account instructions..." /></label>
            <button className="button secondary full" type="submit" disabled={pendingAction === "checkout-request"}>{pendingAction === "checkout-request" ? "Saving checkout request..." : "Create Checkout Request"}</button>
            {formStatus["checkout-request"] && <p className="status success" role="status" aria-live="polite">{formStatus["checkout-request"]}</p>}
          </form>
        </div>
      </section>

      <section id="onboarding" className="section onboardingSection">
        <div className="sectionHead">
          <p className="eyebrow">Client onboarding</p>
          <h2>Create a hospitality account with branches, billing contacts, and plan choice.</h2>
          <p>For hotels, restaurants, clinics, and serviced apartments that need repeat pickup schedules, invoice trails, and location-level notes.</p>
        </div>
        <form className="panel onboardingPanel" onSubmit={(event) => submitLead(event, "client-onboarding")}> 
          <div className="two"><label>Authorized contact<input name="name" placeholder="Authorized contact" autoComplete="name" required /></label><label>Work email<input name="email" type="email" placeholder="Work email" autoComplete="email" required /></label></div>
          <div className="two"><label>Phone / WhatsApp<input name="phone" placeholder="Phone / WhatsApp" autoComplete="tel" required /></label><label>Business name<input name="company" placeholder="Business name" autoComplete="organization" required /></label></div>
          <label>Branches / locations<textarea name="locations" placeholder="Airport View Hotel, Osu Suites, East Legon Residence..." required /></label>
          <div className="two"><label>Legal business name<input name="legalBusinessName" placeholder="Legal business name" /></label><label>Registration number<input name="registrationNumber" placeholder="Registration number" /></label></div>
          <div className="two"><label>Tax ID<input name="taxId" placeholder="Tax ID" /></label><label>Authorized signer<input name="authorizedSigner" placeholder="Authorized signer" /></label></div>
          <div className="two"><label>Team access<select name="multiAdmin"><option>Invite team leads</option><option>Single admin only</option></select></label><label>Billing cycle<select name="billingCycle"><option>Monthly</option><option>Yearly</option></select></label></div>
          <div className="two"><label>Preferred plan<select name="preferredPlan">{plans.map((plan) => <option key={plan.name}>{plan.name}</option>)}</select></label><label>Account goal<select name="accountGoal"><option>Start ordering this week</option><option>Request guided demo</option><option>Need vendor coverage check</option></select></label></div>
          <label>KYC / rollout notes<textarea name="message" placeholder="Signer email, proof-of-address reference, government ID reference, or rollout notes..." /></label>
          <button className="button primary full" type="submit" disabled={pendingAction === "client-onboarding"}>{pendingAction === "client-onboarding" ? "Saving account request..." : "Create Bubble Wash Account Request"}</button>
          {formStatus["client-onboarding"] && <p className="status success" role="status" aria-live="polite">{formStatus["client-onboarding"]}</p>}
        </form>
      </section>

      <section className="section testimonialsSection">
        <div className="sectionHead"><p className="eyebrow">Customer confidence</p><h2>Built for teams that care about predictable returns.</h2><p className="scrollHint">Customer notes move automatically on desktop and become a swipe row on mobile.</p></div>
        <div className="testimonialTrack" aria-label="Customer testimonials">{testimonials.concat(testimonials).map(([quoteText, name, role], index) => <article className="testimonialCard" key={`${name}-${index}`}><p>“{quoteText}”</p><strong>{name}</strong><span>{role}</span></article>)}</div>
      </section>

      <section id="staff" className="section staffTeaser">
        <div className="sectionHead">
          <p className="eyebrow">Staff workspace</p>
          <h2>Admin, vendor, and support work now lives after login.</h2>
          <p>Customers get a focused booking experience. Operators get separate pages for intake, vendor capacity, job updates, and support tickets once they sign in.</p>
        </div>
        <div className="staffCards">
          <a className="staffCard" href="/login?next=/admin"><span>01</span><h3>Admin dashboard</h3><p>Order intake, dispatch, payments, priority, and quality actions.</p></a>
          <a className="staffCard" href="/login?next=/vendors"><span>02</span><h3>Vendor dashboard</h3><p>Capacity reporting, vendor registration, and job status updates.</p></a>
          <a className="staffCard" href="/login?next=/support"><span>03</span><h3>Support desk</h3><p>Customer, vendor, and payment issues handled away from the landing page.</p></a>
        </div>
      </section>

      <section id="faq" className="section faqTestimonials">
        <div><p className="eyebrow">Questions people actually ask</p><h2>Clear answers before pickup.</h2>{faqs.map(([question, answer], index) => <button className="faqItem" key={question} type="button" aria-expanded={activeFaq === index} onClick={() => setActiveFaq(activeFaq === index ? -1 : index)}><span>{question}</span><b>{activeFaq === index ? "−" : "+"}</b>{activeFaq === index && <p>{answer}</p>}</button>)}</div>
        <div className="contactCard"><Image src="/bubble-wash-icon.jpg" alt="Bubble Wash logo" width={180} height={180} /><h2>Need a faster answer?</h2><p>Use the WhatsApp button for quick customer support, vendor questions, or account setup.</p><a className="button primary full" href="https://wa.me/233550000000?text=Hi%20Bubble%20Wash%2C%20I%20need%20help" target="_blank" rel="noreferrer">Chat on WhatsApp</a></div>
      </section>

      <section className="paymentStrip" aria-labelledby="payment-heading"><p className="eyebrow">Payment references</p><h3 id="payment-heading">Accepted payment lanes</h3><div className="paymentLogoGrid">{paymentMethods.map(([label, className]) => <span className={`paymentLogo ${className}`} key={label} role="img" aria-label={label} title={label}><span className="srOnly">{label}</span></span>)}</div></section>

      <footer id="contact" className="footer">
        <div><div className="brand footerBrand"><Image className="brandMark" src="/bubble-wash-icon.jpg" alt="Bubble Wash logo" width={58} height={58} /><span>Bubble Wash</span></div><p>Laundry pickup and vendor fulfilment for Accra teams that need clean work without the back-and-forth.</p></div>
        <div><h3>Use Bubble Wash</h3><a href="#booking">Book pickup</a><a href="#quote">Estimate pricing</a><a href="/login?next=/admin">Admin login</a><a href="/login?next=/support">Support login</a></div>
        <div><h3>For operators</h3><a href="/login?next=/vendors">Vendor login</a><a href="#plans">Subscriptions</a><a href="#services">Services</a></div>
        <div><h3>Get in touch</h3><p>Accra, Ghana</p><p>hello@bubblewashgh.com</p><p>WhatsApp: +233 55 000 0000</p></div>
      </footer>
    </main>
  );
}
