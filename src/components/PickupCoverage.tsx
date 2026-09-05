"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { zones, type ZoneKey } from "@/lib/pricing";
import { formatMoney } from "@/lib/public-ui";

const areas: { name: string; zone: ZoneKey }[] = [
  ...["Osu", "Labone", "Cantonments", "Airport", "East Legon"].map(name => ({ name, zone: "core" as const })),
  ...["Spintex", "Madina", "Dzorwulu", "Ridge"].map(name => ({ name, zone: "near" as const })),
  { name: "Tema", zone: "outer" }, { name: "Another area", zone: "custom" },
];

export function PickupCoverage({ available }: { available: boolean }) {
  const [area, setArea] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState(false);
  async function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selected = areas.find(item => item.name === area);
    if (!selected) return;
    setPending(true); setError(false); setResult("");
    try {
      const response = await fetch(`/api/route-preview?${new URLSearchParams({ area: selected.name, zone: selected.zone })}`, { signal: AbortSignal.timeout(10000) });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error("We couldn’t check that area. Please try again.");
      const zone = zones[selected.zone];
      setResult(selected.zone === "custom" ? "We’ll need to confirm pickup coverage and cost for your area." : `${selected.name}: ${zone.fee ? `${formatMoney(zone.fee)} pickup charge` : "pickup is included in your plan"}. ${available ? "Your pickup time is confirmed after you request it." : "New pickups are currently paused."}`);
    } catch (cause) { setError(true); setResult(cause instanceof Error ? cause.message : "We couldn’t check that area. Please try again."); }
    finally { setPending(false); }
  }
  return <div className="pickupCoverage"><form onSubmit={check}>
    <label htmlFor="pickup-area">Where do you need a pickup?</label>
    <div className="coverageControls"><select id="pickup-area" value={area} required disabled={pending} onChange={event => { setArea(event.target.value); setResult(""); }}><option value="" disabled>Choose your area</option>{areas.map(item => <option key={item.name}>{item.name}</option>)}</select><button className="button primary" disabled={pending} type="submit">{pending ? "Checking…" : "Check area"}</button></div>
    {result && <p className={`coverageResult${error ? " error" : ""}`} role="status">{result}</p>}
  </form><Link href="/services#estimate-heading">Estimate your laundry cost</Link></div>;
}
