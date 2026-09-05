"use client";

import Link from "next/link";
import { Calculator, CalendarPlus } from "lucide-react";
import { FormEvent, useMemo, useRef, useState } from "react";
import { addons, plans, zones, type AddonKey, type PlanName, type ZoneKey } from "@/lib/pricing";
import { formatMoney, postJSON, type Quote } from "@/lib/public-ui";

const addonEntries = Object.entries(addons) as Array<[AddonKey, (typeof addons)[AddonKey]]>;

export function PricingCalculator({ initialPlan = "Twice weekly", available = true }: { initialPlan?: PlanName; available?: boolean }) {
  const [plan, setPlan] = useState<PlanName>(initialPlan);
  const [zone, setZone] = useState<ZoneKey>("core");
  const [kg, setKg] = useState(60);
  const [selectedAddons, setSelectedAddons] = useState<AddonKey[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [status, setStatus] = useState("Choose a plan, expected weight, and any extra services.");
  const [pending, setPending] = useState(false);
  const [tone, setTone] = useState("");
  const revision = useRef(0);
  const zoneEntries = useMemo(() => Object.entries(zones) as Array<[ZoneKey, (typeof zones)[ZoneKey]]>, []);
  const selectedPlan = plans.find((item) => item.name === plan) ?? plans[1];

  function invalidate() {
    revision.current += 1;
    setTone("");
    setQuote(null);
    setStatus("Selection changed. Run a fresh estimate.");
  }

  function toggleAddon(addon: AddonKey) {
    setSelectedAddons((current) => current.includes(addon) ? current.filter((item) => item !== addon) : [...current.filter((key) => !(addon === "premium" && key === "ironing") && !(addon === "ironing" && key === "premium")), addon]);
    invalidate();
  }

  async function calculate(event: FormEvent) {
    event.preventDefault();
    const request = ++revision.current;
    setPending(true);
    setTone("info");
    setStatus("Calculating estimate…");
    try {
      const result = await postJSON<{ ok: boolean; quote: Quote }>("/api/quote", { plan, kg, addons: selectedAddons, zone, discount: "none" });
      if (request !== revision.current) return;
      setQuote(result.quote);
      setTone("success");
      setStatus("Estimate ready.");
    } catch (error) {
      if (request !== revision.current) return;
      setTone("error");
      setQuote(null);
      setStatus(error instanceof Error ? error.message : "Unable to calculate estimate.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="pricingLayout">
      <form className="serviceForm quoteForm" onSubmit={calculate}>
        <div className="formGrid two">
          <label>Collection plan<select value={plan} onChange={(event) => { setPlan(event.target.value as PlanName); invalidate(); }}>{plans.map((item) => <option key={item.name}>{item.name}</option>)}</select></label>
          <label>Expected weight per pickup (kg)<input type="number" min={1} max={10000} step={0.01} inputMode="decimal" value={kg} onChange={(event) => { setKg(Number(event.target.value)); invalidate(); }} /></label>
        </div>
        <label>Service area<select value={zone} onChange={(event) => { setZone(event.target.value as ZoneKey); invalidate(); }}>{zoneEntries.map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label>
        <fieldset className="choiceFieldset"><legend>Optional services</legend><div className="choiceGrid">{addonEntries.map(([key, item]) => <label className="checkOption" key={key}><input type="checkbox" checked={selectedAddons.includes(key)} onChange={() => toggleAddon(key)} /><span><strong>{item.label}</strong><small>{"perKg" in item ? `${formatMoney(item.perKg)} / kg` : "percent" in item ? `${Math.round(item.percent * 100)}% of processing` : formatMoney(item.fixed)}</small></span></label>)}</div></fieldset>
        <button className="button primary" type="submit" disabled={pending}><Calculator aria-hidden="true" />{pending ? "Calculating…" : "Calculate estimate"}</button>
        <p className={`status ${tone}`} role="status" aria-live="polite">{status}</p>
      </form>
      <aside className="quoteSummary" aria-live="polite">
        <p className="sectionLabel">Your estimate</p>
        <h3>{selectedPlan.name}</h3>
        {quote ? <><strong className="quoteTotal">{formatMoney(quote.estimatedMonthlyTotal)}</strong><span className="quotePeriod">estimated monthly total</span><dl className="miniFacts"><div><dt>Monthly service fee</dt><dd>{formatMoney(quote.subscription)}</dd></div><div><dt>Processing per pickup</dt><dd>{formatMoney(quote.processingPerPickup)}</dd></div><div><dt>Selected extras per pickup</dt><dd>{formatMoney(quote.addonsPerPickup)}</dd></div><div><dt>Route fee per pickup</dt><dd>{formatMoney(quote.zoneFee)}</dd></div><div><dt>Minimum adjustment per pickup</dt><dd>{formatMoney(quote.perPickupTotal - quote.processingPerPickup - quote.addonsPerPickup - quote.zoneFee)}</dd></div><div><dt>Total per pickup</dt><dd>{formatMoney(quote.perPickupTotal)}</dd></div><div><dt>Scheduled pickups</dt><dd>{quote.monthlyPickups} per month</dd></div></dl><small>Your final bill uses the weight recorded when your laundry arrives. The GHS 450 pickup minimum is included. Plans include the stated number of collections per calendar month; additional dates are quoted separately. Volume rates apply to the whole load.</small><Link className="button primary full" href={`/book?${new URLSearchParams({ plan, addons: selectedAddons.join(",") })}`}><CalendarPlus aria-hidden="true" />{available ? "Continue to booking" : "Check pickup availability"}</Link></> : <><dl className="miniFacts"><div><dt>Monthly service fee</dt><dd>{formatMoney(selectedPlan.subscription)}</dd></div><div><dt>Schedule</dt><dd>{selectedPlan.pickups}</dd></div><div><dt>Suitable for</dt><dd>{selectedPlan.audience}</dd></div></dl><small>Run the estimate to see the full monthly amount.</small></>}
      </aside>
    </div>
  );
}
