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

type MenuPanel = "pricing" | "coverage" | "track" | "faq" | "staff";

const locations = ["Osu", "Labone", "Cantonments", "Airport", "East Legon", "Dzorwulu", "Spintex", "Madina", "Tema by confirmation"];
const popularAreas = ["Osu", "Labone", "East Legon", "Airport", "Cantonments"];

const coverageGroups = [
  { title: "Core route", fee: "No extra route fee", areas: ["Osu", "Labone", "Cantonments", "Airport", "East Legon"] },
  { title: "Near route", fee: "Route fee confirmed in quote", areas: ["Dzorwulu", "Spintex", "Madina"] },
  { title: "Confirm first", fee: "Pickup window checked before dispatch", areas: ["Tema"] },
];

const vendors = [
  ["CleanPro Laundry Services", "East Legon", "Certified", "Express", "72% on-time return", "linen"],
  ["SparkleWash Ghana", "Airport Residential", "Certified", "24/7", "night dispatch", "machines"],
  ["FreshLinens Co.", "Tema Community 25", "Express", "Bulk", "hotel linen", "fold"],
  ["Pristine Care Laundry", "Cantonments", "Certified", "Same day", "garment care", "steam"],
];

const faqs = [
  ["Can I book a one-time pickup?", "Yes. The booking form captures one-time pickups, subscriptions, and custom pickup notes."],
  ["Do payments work on the site yet?", "Yes. Paystack checkout is connected when provider credentials are configured on the deployment host."],
  ["Will I receive email or WhatsApp alerts?", "Yes. Booking, checkout, onboarding, and workflow updates attach to the same order timeline."],
  ["What areas are covered?", "Core Accra routes have no extra route fee. Near-route and outer-route pickups add delivery fees so pricing stays honest."],
  ["Can vendors manage availability?", "Yes. Vendors update capacity, route area, services, and job status from the protected staff workspace."],
  ["What does the admin section do?", "Admin work lives behind login for operations, vendor coordination, driver handoff, and support tickets."],
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
  const [bookingPlan, setBookingPlan] = useState<PlanName>("Growth");
  const [bookingZone, setBookingZone] = useState<ZoneKey>("core");
  const [bookingArea, setBookingArea] = useState("");
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
  const [requestedVendor, setRequestedVendor] = useState("");
  const [activeMenuPanel, setActiveMenuPanel] = useState<MenuPanel>("pricing");

  const addonEntries = useMemo(() => Object.entries(addons) as Array<[AddonKey, (typeof addons)[AddonKey]]>, []);
  const zoneEntries = useMemo(() => Object.entries(zones) as Array<[ZoneKey, (typeof zones)[ZoneKey]]>, []);
  const discountEntries = useMemo(() => Object.entries(discounts) as Array<[DiscountKey, (typeof discounts)[DiscountKey]]>, []);
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
        setActiveMenuPanel("track");
      })
      .catch((error) => {
        if (active) setPaymentStatus(error instanceof Error ? error.message : "Unable to verify payment.");
      });
    return () => {
      active = false;
    };
  }, []);

  function openMenuPanel(panel: MenuPanel) {
    setActiveMenuPanel(panel);
    setMobileOpen(false);
    requestAnimationFrame(() => scrollToSection("menu-desk"));
  }

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
    setCoverageStatus("Checking coverage and route details...");
    try {
      const response = await fetch(`/api/route-preview?zone=${encodeURIComponent(selectedZone)}&area=${encodeURIComponent(area || matched || "Core Accra route")}`);
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Route preview failed.");
      setRoutePreview(data.route);
      setZone(selectedZone);
      setBookingZone(selectedZone);
      setBookingArea(area || matched || "");
      setActiveMenuPanel("coverage");
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

  function choosePlan(planName: PlanName) {
    setQuotePlan(planName);
    setBookingPlan(planName);
    setActiveMenuPanel("pricing");
    setQuoteStatus(`${planName} selected and added to booking. Adjust kg, route, and add-ons to finish the estimate.`);
    scrollToSection("menu-desk");
  }

  function chooseVendor(name: string) {
    setRequestedVendor(name);
    setFormStatus((current) => ({ ...current, ["vendor-choice"]: `${name} selected. Complete the booking form below so dispatch can confirm capacity.` }));
    document.getElementById("booking")?.scrollIntoView({ behavior: "smooth" });
  }

  function clearRequestedVendor() {
    setRequestedVendor("");
    setFormStatus((current) => {
      const next = { ...current };
      delete next["vendor-choice"];
      return next;
    });
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

  const menuTabs: Array<[MenuPanel, string]> = [
    ["pricing", "Pricing"],
    ["coverage", "Coverage"],
    ["track", "Track / pay"],
    ["faq", "FAQ"],
    ["staff", "Staff"],
  ];
  const selectedPlan = plans.find((plan) => plan.name === quotePlan) ?? plans[1];
  const selectedStartingBand = selectedPlan.bands[0];
  const bookingContext = [
    `${bookingPlan} plan`,
    zones[bookingZone].label,
    bookingArea ? bookingArea : "area open",
    requestedVendor ? requestedVendor : "vendor auto-assigned",
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
          <a href="#menu-desk" onClick={(event) => { event.preventDefault(); openMenuPanel("pricing"); }}>Pricing</a>
          <a href="#menu-desk" onClick={(event) => { event.preventDefault(); openMenuPanel("coverage"); }}>Coverage</a>
          <a href="#menu-desk" onClick={(event) => { event.preventDefault(); openMenuPanel("track"); }}>Track Order</a>
          <a href="/staff" onClick={() => setMobileOpen(false)}>Staff Login</a>
          <a href="#booking" onClick={() => setMobileOpen(false)}>Book</a>
          <a className="navCta" href="https://wa.me/233550000000?text=Hi%20Bubble%20Wash%2C%20I%20want%20to%20schedule%20a%20laundry%20pickup" target="_blank" rel="noreferrer" onClick={() => setMobileOpen(false)}>WhatsApp</a>
        </nav>
      </header>

      <section id="top" className="hero section">
        <div className="heroCopy">
          <p className="eyebrow">Laundry pickup / Accra</p>
          <h1>Laundry pickup that stays visible from bag to doorstep.</h1>
          <p className="lead">Bubble Wash collects, sorts, routes, and returns laundry through vetted partners — with WhatsApp updates and one order reference the whole way.</p>
          <form className="coverageForm" onSubmit={checkCoverage}>
            <label className="coverageLabel" htmlFor="coverageArea">Check if we serve your area</label>
            <div className="coverageRow"><input id="coverageArea" name="coverageArea" value={coverageArea} onChange={(event) => setCoverageArea(event.target.value)} placeholder="e.g. Osu, Labone, East Legon" autoComplete="address-level2" /><button className="button primary" type="submit" disabled={pendingAction === "coverage"}>{pendingAction === "coverage" ? "Checking..." : "Check Coverage"}</button></div>
            <div className="coverageQuickChips" aria-label="Popular coverage areas">{popularAreas.map((area) => <button key={area} type="button" onClick={() => choosePopularArea(area)} disabled={pendingAction === "coverage"}>{area}</button>)}</div>
          </form>
          <p className={statusTone(coverageStatus)} role="status" aria-live="polite">{coverageStatus}</p>
          <div className="heroActions"><a className="button primary" href="#booking">Book a Pickup</a><a className="button secondary" href="#menu-desk" onClick={(event) => { event.preventDefault(); openMenuPanel("coverage"); }}>Check routes</a><a className="textLink" href="#menu-desk" onClick={(event) => { event.preventDefault(); openMenuPanel("pricing"); }}>Estimate price →</a></div>
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
        <div className="sectionHead narrow compactHead"><p className="eyebrow">How it works</p><h2>A cleaner routine in three handoffs.</h2><p>First check your route, then book pickup, then use the laundry desk when you need pricing, tracking, payment, or staff access.</p></div>
        <div className="humanFlowGrid">{customerFlow.map(([title, copy], index) => <article key={title}><span>{String(index + 1).padStart(2, "0")}</span><h3>{title}</h3><p>{copy}</p></article>)}</div>
      </section>

      <section id="menu-desk" className="section menuDeskSection soft" aria-labelledby="menu-desk-heading">
        <div className="sectionHead compactHead"><p className="eyebrow">Laundry desk</p><h2 id="menu-desk-heading">Open the detail you need, then get back to booking.</h2><p>Pricing, routes, tracking, payment, questions, and staff access still work — with a calmer layout and less homepage crowding.</p></div>
        <div className="menuPanelTabs" role="tablist" aria-label="Homepage detail modules">{menuTabs.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={activeMenuPanel === key} className={activeMenuPanel === key ? "active" : ""} onClick={() => setActiveMenuPanel(key)}>{label}</button>)}</div>

        {activeMenuPanel === "pricing" && <div className="menuPanelContent" role="tabpanel" aria-label="Pricing and quote"><div className="plansGrid slimPlans">{plans.map((plan) => {
            const startingBand = plan.bands[0];
            return (
              <article className={`${plan.badge ? "planCard featured" : "planCard"} ${quotePlan === plan.name ? "selectedPlanCard" : ""}`} key={plan.name} aria-current={quotePlan === plan.name ? "true" : undefined}>
                <div className="planFlagRow">
                  {plan.badge && <span className="badge">{plan.badge}</span>}
                  {quotePlan === plan.name && <span className="selectedPlanPill">Selected</span>}
                </div>
                <div className="planCardTop">
                  <h3>{plan.name}</h3>
                  <p>{plan.audience}</p>
                </div>
                <div className="price">{plan.name === "Enterprise" ? "From " : ""}{formatMoney(plan.subscription)}<small>/ month coordination fee</small></div>
                <div className="planMetrics" aria-label={`${plan.name} plan details`}>
                  <span><b>{plan.monthlyPickups}</b><small>pickups / month</small></span>
                  <span><b>{startingBand?.min ?? 1}kg+</b><small>per pickup</small></span>
                  <span><b>{startingBand ? formatMoney(startingBand.rate) : "Custom"}</b><small>/ kg from</small></span>
                </div>
                <ul className="planFeatureList">{plan.features.slice(0, 4).map((feature) => <li key={feature}>{feature}</li>)}</ul>
                <button className={quotePlan === plan.name ? "button secondary full" : "button primary full"} type="button" onClick={() => choosePlan(plan.name as PlanName)}>{quotePlan === plan.name ? "Selected in estimator" : plan.name === "Enterprise" ? "Prepare enterprise quote" : "Select plan"}</button>
              </article>
            );
          })}</div><div className="selectedPlanWorkbench" role="status" aria-live="polite"><div><span>Selected plan</span><strong>{selectedPlan.name}</strong><p>{selectedPlan.audience} · {selectedPlan.monthlyPickups} pickups/month · {selectedStartingBand ? `${formatMoney(selectedStartingBand.rate)} per kg from ${selectedStartingBand.min}kg` : "Custom pricing"}</p></div><button className="button secondary" type="button" onClick={() => calculate()} disabled={pendingAction === "quote"}>{pendingAction === "quote" ? "Calculating..." : "Update estimate"}</button></div><div className="quoteGrid serviceWorkbench embeddedWorkbench"><form className="panel largePanel" onSubmit={calculate}><h3>Estimate monthly cost</h3><div className="two"><label>Plan<select value={quotePlan} onChange={(e) => setQuotePlan(e.target.value as PlanName)}>{plans.map((plan) => <option key={plan.name}>{plan.name}</option>)}</select></label><label>Estimated kg per pickup<input type="number" min={1} max={10000} step={1} inputMode="numeric" value={kg} onChange={(e) => setKg(Number(e.target.value))} /></label></div><div className="two"><label>Pickup zone<select value={zone} onChange={(e) => setZone(e.target.value as ZoneKey)}>{zoneEntries.map(([key, item]) => <option key={key} value={key}>{item.label} · {formatMoney(item.fee)}</option>)}</select></label><label>Discount<select value={discount} onChange={(e) => setDiscount(e.target.value as DiscountKey)}>{discountEntries.map(([key, item]) => <option key={key} value={key}>{item.label} · {Math.round(item.percent * 100)}%</option>)}</select></label></div><div className="addonGrid">{addonEntries.map(([key, addon]) => <label key={key} className="check"><input type="checkbox" checked={selectedAddons.includes(key)} onChange={() => toggleAddon(key)} /> {addon.label}</label>)}</div><button className="button primary full" type="submit" disabled={pendingAction === "quote"}>{pendingAction === "quote" ? "Calculating..." : "Calculate estimate"}</button><p className={statusTone(quoteStatus)} role="status" aria-live="polite">{quoteStatus}</p></form><aside className="quoteResult"><h3>Estimated monthly total</h3>{quote ? <><strong>{formatMoney(quote.estimatedMonthlyTotal)}</strong><p>{quote.plan} · {quote.pickupRhythm}</p><div className="miniRows"><span>Per pickup: {formatMoney(quote.perPickupTotal)}</span><span>Route fee: {formatMoney(quote.zoneFee)}</span><span>Add-ons: {formatMoney(quote.addonsPerPickup)}</span><span>Discount: −{formatMoney(quote.discountAmount)}</span></div></> : <><strong>Run estimate</strong><p>Choose the plan, zone, discount, and add-ons first.</p></>}</aside></div></div>}

        {activeMenuPanel === "coverage" && <div className="menuPanelContent" role="tabpanel" aria-label="Coverage and vendors"><div className="coverageMenuGrid refinedCoverageGrid"><div className="panel coverageRoutesPanel"><div className="coveragePanelHead"><span className="badge">Coverage</span><h3>Route zones</h3><p>Grouped by how dispatch prices and confirms pickup — easier than a wall of pills.</p></div><div className="coverageRouteList">{coverageGroups.map((group) => <article className="coverageRouteGroup" key={group.title}><div><strong>{group.title}</strong><small>{group.fee}</small></div><ul>{group.areas.map((area) => <li key={area}>{area}</li>)}</ul></article>)}</div></div><aside className="coverageSummaryCard" aria-label="Selected route summary"><span className="badge">{routePreview.zoneLabel}</span><h3>{routePreview.pickup.label}</h3><p>{routePreview.zoneNote}</p><div className="routeFacts"><span><b>{routePreview.estimatedDistanceKm}km</b><small>estimated route</small></span><span><b>{routePreview.estimatedDriveMinutes}min</b><small>drive window</small></span><span><b>{formatMoney(zones[routePreview.zoneKey].fee)}</b><small>route fee</small></span></div><div className="mapActions"><a className="button primary" href={routePreview.directionsUrl} target="_blank" rel="noreferrer">Open Directions</a><a className="button secondary" href={routePreview.googleMapsUrl} target="_blank" rel="noreferrer">View Area</a></div></aside></div><div className="vendorShowcaseGrid compactVendorGrid">{vendors.map(([name, area, tagOne, tagTwo, metric, tone]) => <article className="vendorShowcaseCard" key={name}><div className={`vendorPhoto ${tone}`}><span>{metric}</span></div><div><h3>{name}</h3><p>{area}</p><div className="tagRow"><span>{tagOne}</span><span>{tagTwo}</span></div></div><button className="button primary full" type="button" onClick={() => chooseVendor(name)}>Request Service</button></article>)}</div>{formStatus["vendor-choice"] && <p className="status success">{formStatus["vendor-choice"]}</p>}</div>}

        {activeMenuPanel === "track" && <div className="menuPanelContent trackPaymentGrid" role="tabpanel" aria-label="Tracking and payment"><form className="panel trackingPanel" onSubmit={trackOrder}><h3>Track an order</h3><label>Tracking reference<input name="trackingId" placeholder="Reference e.g. BW-1760000000000" autoComplete="off" /></label><button className="button primary full" type="submit" disabled={pendingAction === "track"}>{pendingAction === "track" ? "Checking..." : "Check Status"}</button><p className={statusTone(trackingStatus)} role="status" aria-live="polite">{trackingStatus}</p>{trackingResult && <div className="trackingMiniResult"><strong>{trackingResult.id}</strong><span>{trackingResult.status}</span><small>{trackingResult.nextStep}</small></div>}</form><form className="panel paymentPanel" onSubmit={submitPayment}><h3>Paystack checkout</h3><p className="formHint">Card and mobile money checkout opens securely through Paystack.</p><label>Billing name<input name="name" placeholder="Billing name" autoComplete="name" required /></label><label>Billing email<input name="email" type="email" placeholder="Billing email" autoComplete="email" required /></label><div className="two"><label>Amount<input name="amount" placeholder="GHS 2250" inputMode="decimal" pattern="[0-9,. ]+" required /></label><label>Payment method<select name="paymentMethod"><option>MTN MoMo</option><option>Telecel Cash</option><option>Visa / Mastercard</option><option>Bank transfer</option></select></label></div><input type="hidden" name="phone" value="review-checkout" /><input type="hidden" name="company" value="Bubble Wash customer" /><button className="button secondary full" type="submit" disabled={pendingAction === "payment-checkout"}>{pendingAction === "payment-checkout" ? "Opening Paystack..." : "Pay Securely"}</button><p className={statusTone(paymentStatus)} role="status" aria-live="polite">{paymentStatus}</p></form></div>}

        {activeMenuPanel === "faq" && <div className="menuPanelContent" role="tabpanel" aria-label="Frequently asked questions"><div className="faqListCompact">{faqs.map(([question, answer], index) => <button className="faqItem" key={question} type="button" aria-expanded={activeFaq === index} onClick={() => setActiveFaq(activeFaq === index ? -1 : index)}><span>{question}</span><b>{activeFaq === index ? "−" : "+"}</b>{activeFaq === index && <p>{answer}</p>}</button>)}</div></div>}

        {activeMenuPanel === "staff" && <div className="menuPanelContent" role="tabpanel" aria-label="Staff access"><a className="staffEntryCard" href="/staff"><span>Staff access</span><h3>Open staff login</h3><p>Admin, vendor, driver, and support sign-in paths now live on one dedicated staff page.</p><b>Continue →</b></a></div>}
      </section>

      <section id="booking" className="section schedule soft compactBookingSection">
        <div className="sectionHead compactHead"><p className="eyebrow">Book pickup</p><h2>Send the details once. Dispatch uses the same order record.</h2></div>
        <div className="scheduleGrid twoCols bookingOnlyGrid"><form className="panel" onSubmit={(event) => submitLead(event, "pickup-booking")}><h3>Pickup request</h3><div className="two"><label>Contact name<input name="name" placeholder="Name" autoComplete="name" required /></label><label>Email<input name="email" type="email" placeholder="Email" autoComplete="email" required /></label></div><div className="two"><label>Phone / WhatsApp<input name="phone" placeholder="Phone / WhatsApp" autoComplete="tel" required /></label><label>Company or household<input name="company" placeholder="Company or household" autoComplete="organization" required /></label></div><div className="two"><label>Preferred plan<select name="preferredPlan" value={bookingPlan} onChange={(event) => setBookingPlan(event.target.value as PlanName)}>{plans.map((plan) => <option key={plan.name}>{plan.name}</option>)}</select></label><label>Pickup zone<select name="zone" value={bookingZone} onChange={(event) => setBookingZone(event.target.value as ZoneKey)}>{zoneEntries.map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label></div><div className="bookingContextSummary" aria-label="Current booking context">{bookingContext.map((item) => <span key={item}>{item}</span>)}</div>{requestedVendor && <div className="selectedVendor" role="status" aria-live="polite"><span>Requested vendor</span><strong>{requestedVendor}</strong><button type="button" onClick={clearRequestedVendor}>Clear</button></div>}<input type="hidden" name="requestedVendor" value={requestedVendor} /><div className="two"><label>Pickup area<input name="area" value={bookingArea} onChange={(event) => setBookingArea(event.target.value)} placeholder="Osu, Labone, East Legon..." autoComplete="address-level2" /></label><label>Preferred pickup date<input name="pickupDate" type="date" min={minPickupDate} /></label></div><div className="two"><label>Payment preference<select name="paymentPreference"><option>MTN MoMo</option><option>Telecel Cash</option><option>Card</option><option>Bank transfer</option><option>Invoice me</option></select></label><label>Alert preference<select name="alertPreference"><option>Email + WhatsApp alerts</option><option>WhatsApp only</option><option>Email only</option><option>Call me</option></select></label></div><label>Pickup notes<textarea name="message" placeholder="Textile type, special instructions, preferred time window..." /></label><button className="button primary full" type="submit" disabled={pendingAction === "pickup-booking"}>{pendingAction === "pickup-booking" ? "Saving pickup request..." : "Request Pickup"}</button>{formStatus["pickup-booking"] && <p className={statusTone(formStatus["pickup-booking"])} role="status" aria-live="polite">{formStatus["pickup-booking"]}</p>}</form><aside className="bookingSideCard panel"><h3>Want the extra details?</h3><p>Pricing, route coverage, order tracking, FAQs, and staff workspace links are now opened from the menu desk instead of living as long homepage sections.</p><button className="button secondary full" type="button" onClick={() => openMenuPanel("pricing")}>Open menu desk</button><a className="button primary full" href="https://wa.me/233550000000?text=Hi%20Bubble%20Wash%2C%20I%20want%20to%20schedule%20a%20laundry%20pickup" target="_blank" rel="noreferrer">WhatsApp Bubble Wash</a></aside></div>
      </section>

      <section className="paymentStrip" aria-labelledby="payment-heading"><p className="eyebrow">Payment references</p><h3 id="payment-heading">Accepted payment lanes</h3><div className="paymentLogoGrid">{paymentMethods.map(([label, className]) => <span className={`paymentLogo ${className}`} key={label} role="img" aria-label={label} title={label}><span className="srOnly">{label}</span></span>)}</div></section>

      <footer id="contact" className="footer"><div><div className="brand footerBrand"><Image className="brandMark" src="/bubble-wash-icon.jpg" alt="Bubble Wash logo" width={58} height={58} /><span>Bubble Wash</span></div><p>Laundry pickup and vendor fulfilment for Accra teams that need clean work without the back-and-forth.</p></div><div><h3>Use Bubble Wash</h3><a href="#booking">Book pickup</a><a href="#menu-desk" onClick={(event) => { event.preventDefault(); openMenuPanel("pricing"); }}>Estimate pricing</a><a href="#menu-desk" onClick={(event) => { event.preventDefault(); openMenuPanel("coverage"); }}>Coverage</a><a href="#menu-desk" onClick={(event) => { event.preventDefault(); openMenuPanel("track"); }}>Track order</a></div><div><h3>For operators</h3><a href="/staff">Staff login</a><a href="/login?next=/admin">Admin login</a><a href="/login?next=/vendors">Vendor login</a><a href="/login?next=/drivers">Driver login</a></div><div><h3>Get in touch</h3><p>Accra, Ghana</p><p>hello@bubblewashgh.com</p><p>WhatsApp: +233 55 000 0000</p></div></footer>
    </main>
  );
}
