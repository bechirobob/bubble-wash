"use client";

import Image from "next/image";
import { FormEvent, useEffect, useMemo, useState } from "react";
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
  driver?: string;
  routeWindow?: string;
  locationNote?: string;
  eventCount?: number;
  updatedAt?: string;
  route?: RoutePreview;
};

type PaymentCheckout = {
  reference: string;
  authorizationUrl: string;
  accessCode: string;
  amountGhs: number;
};

const services = [
  ["Wash + fold", "01"],
  ["Ironing", "02"],
  ["Commercial linen", "03"],
  ["Express routing", "04"],
];

const locations = ["Osu", "Labone", "Cantonments", "Airport", "East Legon", "Dzorwulu", "Spintex", "Madina", "Tema by confirmation"];

const popularAreas = ["Osu", "Labone", "East Legon", "Airport", "Cantonments"];

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
  ["Do payments work on the site yet?", "Yes. Paystack checkout is connected for Ghana-ready card and mobile money payments. Test mode can stay on until final launch."],
  ["Will I receive email or WhatsApp alerts?", "Yes. Booking, checkout, onboarding, and workflow updates attach to the same order timeline."],
  ["What areas are covered?", "Core Accra routes have no extra route fee. Near-route and outer-route pickups add delivery fees so pricing stays honest."],
  ["Can vendors manage their availability?", "Yes. Vendors use the staff login to update daily capacity, route area, services, and job status without crowding the customer page."],
  ["What does the admin section do?", "Admin work now lives behind login on separate pages for operations, vendor coordination, and support tickets."],
];

const proof = [
  ["24h", "standard turnaround target"],
  ["7", "days of pickup scheduling"],
  ["8", "Accra route zones"],
  ["1", "order timeline from pickup to delivery"],
];

const operationsPillars = ["Book", "Pay", "Route", "Notify"];

const trackingStages = ["Received", "Pickup scheduled", "Vendor assigned", "In washing", "Ready for delivery", "Delivered"];

const liveTrackingPlan = ["Order updates", "Driver ETAs", "Map links"];

const assuranceItems = ["Clear intake", "Vendor accountability", "Commercial controls"];

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

function statusTone(message?: string) {
  if (!message) return "status";
  if (/unable|failed|missing|invalid|too many|error|required|not configured|enter .*first/i.test(message)) return "status error";
  if (/ready|covered|received|Reference:|selected|loaded|verified|opening/i.test(message)) return "status success";
  return "status";
}

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
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
  const [discount, setDiscount] = useState<DiscountKey>("none");
  const [kg, setKg] = useState(82);
  const [selectedAddons, setSelectedAddons] = useState<AddonKey[]>(["ironing"]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteStatus, setQuoteStatus] = useState("Choose your plan, route, and add-ons to see a realistic monthly estimate.");
  const [activeFaq, setActiveFaq] = useState(0);
  const [formStatus, setFormStatus] = useState<Record<string, string>>({});
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobileNav, setIsMobileNav] = useState(false);
  const [coverageArea, setCoverageArea] = useState("");
  const [coverageStatus, setCoverageStatus] = useState("Enter your area to check pickup coverage.");
  const [routePreview, setRoutePreview] = useState<RoutePreview>(() => buildRoutePreview("core", "Core Accra route"));
  const [trackingStatus, setTrackingStatus] = useState("Enter a booking/reference ID after submitting a request.");
  const [trackingResult, setTrackingResult] = useState<TrackingResult | null>(null);
  const [paymentStatus, setPaymentStatus] = useState("Pay by card or mobile money through Paystack after entering billing details.");
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const addonEntries = useMemo(() => Object.entries(addons) as Array<[AddonKey, (typeof addons)[AddonKey]]>, []);
  const zoneEntries = useMemo(() => Object.entries(zones) as Array<[ZoneKey, (typeof zones)[ZoneKey]]>, []);
  const discountEntries = useMemo(() => Object.entries(discounts) as Array<[DiscountKey, (typeof discounts)[DiscountKey]]>, []);

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

  useEffect(() => {
    const reference = new URLSearchParams(window.location.search).get("payment_reference");
    if (!reference) return;
    let active = true;
    setPaymentStatus("Verifying Paystack payment status...");
    fetch(`/api/payments/verify?reference=${encodeURIComponent(reference)}`)
      .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
      .then(({ ok, data }) => {
        if (!active) return;
        if (!ok || !data.ok) throw new Error(data.error ?? "Payment verification failed.");
        setPaymentStatus(`Payment ${data.payment.status || "verified"}. Reference: ${data.payment.reference || reference}`);
      })
      .catch((error) => {
        if (active) setPaymentStatus(error instanceof Error ? error.message : "Unable to verify payment.");
      });
    return () => {
      active = false;
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
      form.reset();
    } catch (error) {
      setFormStatus((current) => ({ ...current, [type]: error instanceof Error ? error.message : "Unable to save request." }));
    } finally {
      setPendingAction(null);
    }
  }

  async function submitPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    setPendingAction("payment-checkout");
    setPaymentStatus("Opening Paystack checkout...");
    try {
      const data = await postJSON<{ ok: boolean; message: string; id: string; payment: PaymentCheckout }>("/api/payments/initialize", payload);
      setPaymentStatus(`Paystack opening. Reference: ${data.payment.reference}`);
      window.location.href = data.payment.authorizationUrl;
    } catch (error) {
      setPaymentStatus(error instanceof Error ? error.message : "Unable to create Paystack checkout.");
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

  async function runCoverageCheck(areaInput: string) {
    const area = areaInput.trim();
    const matched = locations.find((location) => area.toLowerCase().includes(location.split(" ")[0].toLowerCase()));
    const selectedZone = routeZoneForArea(area || matched || "core");
    setPendingAction("coverage");
    setCoverageStatus("Checking coverage and route map...");
    try {
      const response = await fetch(`/api/route-preview?zone=${encodeURIComponent(selectedZone)}&area=${encodeURIComponent(area || matched || "Core Accra route")}`);
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Route preview failed.");
      setRoutePreview(data.route);
      setCoverageStatus(matched ? `${matched} covered. Route ready.` : `${area || "Area"} queued for route confirmation.`);
    } catch (error) {
      setRoutePreview(buildRoutePreview(selectedZone, area || matched || "Core Accra route"));
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

  function choosePlan(planName: PlanName) {
    setQuotePlan(planName);
    setQuoteStatus(`${planName} selected. Adjust kg, route, and add-ons to finish the estimate.`);
    scrollToSection("quote");
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
      setTrackingStatus("Tracking loaded.");
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
      <div className="bubbleAtmosphere" aria-hidden="true">
        <span className="foamOrb orbOne" />
        <span className="foamOrb orbTwo" />
        <span className="foamOrb orbThree" />
        <span className="foamOrb orbFour" />
        <span className="foamOrb orbFive" />
        <span className="foamOrb orbSix" />
        <span className="foamTrail trailOne" />
        <span className="foamTrail trailTwo" />
      </div>
      <a className="backToTop" href="#top" aria-label="Back to top"><span aria-hidden="true">↑</span><b>Top</b></a>
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
        <nav id="site-navigation" className={mobileOpen ? "navLinks open" : "navLinks"} data-open={mobileOpen} aria-hidden={isMobileNav && !mobileOpen ? true : undefined}>
          <a href="#services" onClick={() => setMobileOpen(false)}>Services</a>
          <a href="#plans" onClick={() => setMobileOpen(false)}>Pricing</a>
          <a href="#locations" onClick={() => setMobileOpen(false)}>Coverage</a>
          <a href="#track" onClick={() => setMobileOpen(false)}>Track Order</a>
          <a href="#faq" onClick={() => setMobileOpen(false)}>FAQ</a>
          <a href="#booking" onClick={() => setMobileOpen(false)}>Book</a>
          <a className="navCta" href="https://wa.me/233550000000?text=Hi%20Bubble%20Wash%2C%20I%20want%20to%20schedule%20a%20laundry%20pickup" target="_blank" rel="noreferrer" onClick={() => setMobileOpen(false)}>WhatsApp</a>
        </nav>
      </header>

      <section id="top" className="hero section">
        <div className="heroCopy">
          <p className="eyebrow">Laundry pickup in Accra</p>
          <h1>Book laundry pickup with clear tracking from pickup to delivery.</h1>
          <p className="lead">Bubble Wash collects, routes to vetted laundry partners, and keeps households and businesses updated by WhatsApp, email, and one order reference.</p>
          <form className="coverageForm" onSubmit={checkCoverage}>
            <label className="coverageLabel" htmlFor="coverageArea">Check if we serve your area</label>
            <div className="coverageRow">
              <input id="coverageArea" name="coverageArea" value={coverageArea} onChange={(event) => setCoverageArea(event.target.value)} placeholder="e.g. Osu, Labone, East Legon" autoComplete="address-level2" />
              <button className="button primary" type="submit" disabled={pendingAction === "coverage"}>{pendingAction === "coverage" ? "Checking..." : "Check Coverage"}</button>
            </div>
            <div className="coverageQuickChips" aria-label="Popular coverage areas">
              {popularAreas.map((area) => <button key={area} type="button" onClick={() => choosePopularArea(area)} disabled={pendingAction === "coverage"}>{area}</button>)}
            </div>
          </form>
          <p className={statusTone(coverageStatus)} role="status" aria-live="polite">{coverageStatus}</p>
          <div className="heroActions">
            <a className="button primary" href="#booking">Book a Pickup</a>
            <a className="button secondary" href="#locations">Check Coverage</a>
            <a className="textLink" href="#quote">Estimate price →</a>
          </div>
          <div className="humanNote"><b>Simple promise:</b> schedule pickup, pay by MoMo/card/invoice, and see updates before you have to chase anyone.</div>
        </div>
        <div className="heroVisual heroSlider" aria-label="Bubble Wash live operations summary">
          <div className="slideOverlay" />
          <div className="washerPortal" aria-hidden="true">
            <Image src="/bubble-wash-icon.jpg" alt="" width={180} height={180} priority />
            <span className="washerRing ringOne" />
            <span className="washerRing ringTwo" />
            <span className="washerBubble b1" />
            <span className="washerBubble b2" />
            <span className="washerBubble b3" />
            <span className="washerBubble b4" />
          </div>
          <div className="foamTicket" aria-hidden="true"><span>soap trail</span><b>Osu → Labone</b></div>
          <div className="visualCard orderCard"><span>Your order</span><strong>BW-2081</strong><small>Pickup scheduled · Washing started · Delivery window set</small></div>
          <div className="visualCard mainBasket"><span>Today’s pickup</span><strong>82kg</strong><small>Growth plan · Core Accra · ironing added · WhatsApp updates on</small></div>
          <div className="routeCard"><b>Route fee</b><span>{zones[zone].label}</span><strong>{formatMoney(zones[zone].fee)}</strong></div>
          <div className="ratingCard"><b>4.8★</b><span>customer confidence</span></div>
        </div>
      </section>

      <section className="proofStrip" aria-label="service proof points">
        {proof.map(([number, label]) => <div key={label}><strong>{number}</strong><span>{label}</span></div>)}
      </section>

      <div className="foamDivider" aria-hidden="true"><span /><span /><span /></div>

      <section id="plans" className="section soft">
        <div className="sectionHead">
          <p className="eyebrow">Plans that do not pretend every customer is the same</p>
          <h2>Pick a subscription rhythm, then adjust by weight, route, and add-ons.</h2>
        </div>
        <div className="plansGrid">
          {plans.map((plan) => (
            <article className={plan.badge ? "planCard featured" : "planCard"} key={plan.name}>
              {plan.badge && <span className="badge">{plan.badge}</span>}
              <h3>{plan.name}</h3>
              <div className="price">{plan.name === "Enterprise" ? "From " : ""}{formatMoney(plan.subscription)}<small>/ month coordination fee</small></div>
              <p className="pickup">{plan.pickups}</p>
              <ul>{plan.features.map((feature) => <li key={feature}>✓ {feature}</li>)}</ul>
              <button className="button primary full" type="button" onClick={() => choosePlan(plan.name as PlanName)}>{plan.name === "Enterprise" ? "Prepare enterprise quote" : "Estimate this plan"}</button>
            </article>
          ))}
        </div>
      </section>

      <section className="section opsCommand">
        <div className="sectionHead compactHead">
          <p className="eyebrow">Operations engine</p>
          <h2>One customer promise, one order timeline behind it.</h2>
        </div>
        <div className="commandGrid">{operationsPillars.map((title, index) => <article key={title}><span>{String(index + 1).padStart(2, "0")}</span><h3>{title}</h3></article>)}</div>
      </section>

      <section id="services" className="section">
        <div className="sectionHead narrow compactHead">
          <p className="eyebrow">What Bubble Wash handles</p>
          <h2>Core laundry jobs, without the clutter.</h2>
        </div>
        <div className="serviceGrid compactServiceGrid">{services.map(([title, number]) => <article className="serviceCard" key={title}><div className="serviceIcon">{number}</div><h3>{title}</h3></article>)}</div>
      </section>

      <section id="vendors-public" className="section vendorShowcase">
        <div className="sectionHead">
          <p className="eyebrow">Trusted laundry partners</p>
          <h2>Vetted vendors with real capacity, route areas, and service tags.</h2>
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
        </div>
        <div className="mapCoverageGrid">
          <div>
            <div className="locationGrid">{locations.map((item) => <span key={item}>{item}</span>)}</div>
            <div className="mapResearchCard">
              <h3>Map routing</h3>
              <p>Directions open in Google Maps.</p>
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
            <p className={statusTone(quoteStatus)} role="status" aria-live="polite">{quoteStatus}</p>
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
        </div>
        <div className="assuranceGrid">{assuranceItems.map((title) => <article key={title}><h3>{title}</h3></article>)}</div>
      </section>

      <section id="track" className="section trackingSection soft">
        <div className="sectionHead">
          <p className="eyebrow">Order tracking</p>
          <h2>Customers can track a real order reference without calling support.</h2>
        </div>
        <div className="trackingGrid">
          <form className="panel trackingPanel" onSubmit={trackOrder}>
            <h3>Track a Bubble Wash request</h3>
            <label>Tracking reference<input name="trackingId" placeholder="Reference e.g. BW-1760000000000" autoComplete="off" /></label>
            <button className="button primary full" type="submit" disabled={pendingAction === "track"}>{pendingAction === "track" ? "Checking..." : "Check Status"}</button>
            <p className={statusTone(trackingStatus)} role="status" aria-live="polite">{trackingStatus}</p>
          </form>
          <aside className="trackingResult">
            {trackingResult ? <>
              <span>{trackingResult.type}</span>
              <h3>{trackingResult.id}</h3>
              <strong>{trackingResult.status}</strong>
              <p>{trackingResult.customer}</p>
              <div className="miniRows"><span>Vendor: {trackingResult.vendor || "Pending assignment"}</span><span>Driver: {trackingResult.driver || "Pending dispatch"}</span><span>Route window: {trackingResult.routeWindow || "ETA pending"}</span><span>Driver note: {trackingResult.locationNote || "No checkpoint yet"}</span><span>Area: {trackingResult.area}</span><span>Payment: {trackingResult.payment}</span><span>Events: {trackingResult.eventCount ?? 1}</span><span>Updated: {new Date(trackingResult.updatedAt || trackingResult.createdAt).toLocaleString()}</span></div>
              <p>{trackingResult.nextStep}</p>
              {trackingResult.route && <div className="trackingMapActions"><a className="button primary" href={trackingResult.route.directionsUrl} target="_blank" rel="noreferrer">Open Google Maps Route</a><a className="button secondary" href={trackingResult.route.googleMapsUrl} target="_blank" rel="noreferrer">View Pickup Area</a></div>}
            </> : <>
              <span>Tracking stages</span>
              <div className="stageList">{trackingStages.map((stage, index) => <div key={stage}><b>{index + 1}</b><span>{stage}</span></div>)}</div>
            </>}
          </aside>
        </div>
        <div className="liveTrackingGrid">
          {liveTrackingPlan.map((title) => <article key={title}><h3>{title}</h3></article>)}
        </div>
      </section>



      <section id="booking" className="section schedule soft">
        <div className="sectionHead">
          <p className="eyebrow">Booking + alerts + payment preference</p>
          <h2>Customers can request pickup, choose payment preference, and opt into alerts.</h2>
        </div>
        <div className="scheduleGrid twoCols">
          <form className="panel" onSubmit={(event) => submitLead(event, "pickup-booking")}>
            <h3>Book laundry pickup</h3>
            <div className="two"><label>Contact name<input name="name" placeholder="Name" autoComplete="name" required /></label><label>Email<input name="email" type="email" placeholder="Email" autoComplete="email" required /></label></div>
            <div className="two"><label>Phone / WhatsApp<input name="phone" placeholder="Phone / WhatsApp" autoComplete="tel" required /></label><label>Company or household<input name="company" placeholder="Company or household" autoComplete="organization" required /></label></div>
            <div className="two"><label>Preferred plan<select name="preferredPlan">{plans.map((plan) => <option key={plan.name}>{plan.name}</option>)}</select></label><label>Pickup zone<select name="zone">{zoneEntries.map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label></div>
            <div className="two"><label>Pickup area<input name="area" placeholder="Osu, Labone, East Legon..." autoComplete="address-level2" /></label><label>Preferred pickup date<input name="pickupDate" type="date" /></label></div>
            <div className="two"><label>Payment preference<select name="paymentPreference"><option>MTN MoMo</option><option>Telecel Cash</option><option>Card</option><option>Bank transfer</option><option>Invoice me</option></select></label><label>Alert preference<select name="alertPreference"><option>Email + WhatsApp alerts</option><option>WhatsApp only</option><option>Email only</option><option>Call me</option></select></label></div>
            <label>Pickup notes<textarea name="message" placeholder="Textile type, special instructions, preferred time window..." /></label>
            <button className="button primary full" type="submit" disabled={pendingAction === "pickup-booking"}>{pendingAction === "pickup-booking" ? "Saving pickup request..." : "Request Pickup"}</button>
            {formStatus["pickup-booking"] && <p className={statusTone(formStatus["pickup-booking"])} role="status" aria-live="polite">{formStatus["pickup-booking"]}</p>}
          </form>

          <form className="panel paymentPanel" onSubmit={submitPayment}>
            <h3>Secure Paystack checkout</h3>
            <p className="formHint">Card and mobile money checkout opens securely through Paystack after billing details are confirmed.</p>
            <label>Billing name<input name="name" placeholder="Billing name" autoComplete="name" required /></label>
            <label>Billing email<input name="email" type="email" placeholder="Billing email" autoComplete="email" required /></label>
            <label>Phone / MoMo number<input name="phone" placeholder="Phone / MoMo number" autoComplete="tel" required /></label>
            <label>Business / account name<input name="company" placeholder="Business / account name" autoComplete="organization" required /></label>
            <div className="two"><label>Amount<input name="amount" placeholder="GHS 2250" inputMode="decimal" required /></label><label>Payment method<select name="paymentMethod"><option>MTN MoMo</option><option>Telecel Cash</option><option>Visa / Mastercard</option><option>Bank transfer</option></select></label></div>
            <label>Invoice notes<textarea name="message" placeholder="Payment reference, invoice notes, or account instructions..." /></label>
            <button className="button secondary full" type="submit" disabled={pendingAction === "payment-checkout"}>{pendingAction === "payment-checkout" ? "Opening Paystack..." : "Pay Securely with Paystack"}</button>
            <p className={statusTone(paymentStatus)} role="status" aria-live="polite">{paymentStatus}</p>
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
          <div className="two"><label>Preferred plan<select name="preferredPlan">{plans.map((plan) => <option key={plan.name}>{plan.name}</option>)}</select></label><label>Account goal<select name="accountGoal"><option>Start ordering this week</option><option>Open account this week</option><option>Need vendor coverage check</option></select></label></div>
          <label>KYC / rollout notes<textarea name="message" placeholder="Signer email, proof-of-address reference, government ID reference, or rollout notes..." /></label>
          <button className="button primary full" type="submit" disabled={pendingAction === "client-onboarding"}>{pendingAction === "client-onboarding" ? "Saving account request..." : "Create Bubble Wash Account Request"}</button>
          {formStatus["client-onboarding"] && <p className={statusTone(formStatus["client-onboarding"])} role="status" aria-live="polite">{formStatus["client-onboarding"]}</p>}
        </form>
      </section>

      <section className="section testimonialsSection">
        <div className="sectionHead"><p className="eyebrow">Customer confidence</p><h2>Built for teams that care about predictable returns.</h2></div>
        <div className="testimonialTrack" aria-label="Customer testimonials">{testimonials.concat(testimonials).map(([quoteText, name, role], index) => <article className="testimonialCard" key={`${name}-${index}`}><p>“{quoteText}”</p><strong>{name}</strong><span>{role}</span></article>)}</div>
      </section>

      <section id="staff" className="section staffTeaser">
        <div className="sectionHead">
          <p className="eyebrow">Staff workspace</p>
          <h2>Admin, vendor, driver, and support work now lives after login.</h2>
        </div>
        <div className="staffCards">
          <a className="staffCard" href="/login?next=/admin"><span>01</span><h3>Admin dashboard</h3></a>
          <a className="staffCard" href="/login?next=/vendors"><span>02</span><h3>Vendor dashboard</h3></a>
          <a className="staffCard" href="/login?next=/drivers"><span>03</span><h3>Driver route board</h3></a>
          <a className="staffCard" href="/login?next=/support"><span>04</span><h3>Support desk</h3></a>
        </div>
      </section>

      <section id="faq" className="section faqTestimonials">
        <div><p className="eyebrow">Questions people actually ask</p><h2>Clear answers before pickup.</h2>{faqs.map(([question, answer], index) => <button className="faqItem" key={question} type="button" aria-expanded={activeFaq === index} onClick={() => setActiveFaq(activeFaq === index ? -1 : index)}><span>{question}</span><b>{activeFaq === index ? "−" : "+"}</b>{activeFaq === index && <p>{answer}</p>}</button>)}</div>
        <div className="contactCard"><Image src="/bubble-wash-icon.jpg" alt="Bubble Wash logo" width={180} height={180} /><h2>Need a faster answer?</h2><a className="button primary full" href="https://wa.me/233550000000?text=Hi%20Bubble%20Wash%2C%20I%20need%20help" target="_blank" rel="noreferrer">Chat on WhatsApp</a></div>
      </section>

      <section className="paymentStrip" aria-labelledby="payment-heading"><p className="eyebrow">Payment references</p><h3 id="payment-heading">Accepted payment lanes</h3><div className="paymentLogoGrid">{paymentMethods.map(([label, className]) => <span className={`paymentLogo ${className}`} key={label} role="img" aria-label={label} title={label}><span className="srOnly">{label}</span></span>)}</div></section>

      <footer id="contact" className="footer">
        <div><div className="brand footerBrand"><Image className="brandMark" src="/bubble-wash-icon.jpg" alt="Bubble Wash logo" width={58} height={58} /><span>Bubble Wash</span></div><p>Laundry pickup and vendor fulfilment for Accra teams that need clean work without the back-and-forth.</p></div>
        <div><h3>Use Bubble Wash</h3><a href="#booking">Book pickup</a><a href="#quote">Estimate pricing</a><a href="/login?next=/admin">Admin login</a><a href="/login?next=/drivers">Driver login</a><a href="/login?next=/support">Support login</a></div>
        <div><h3>For operators</h3><a href="/login?next=/vendors">Vendor login</a><a href="/login?next=/drivers">Driver login</a><a href="#plans">Subscriptions</a><a href="#services">Services</a></div>
        <div><h3>Get in touch</h3><p>Accra, Ghana</p><p>hello@bubblewashgh.com</p><p>WhatsApp: +233 55 000 0000</p></div>
      </footer>
    </main>
  );
}
