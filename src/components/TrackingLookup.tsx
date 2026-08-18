"use client";

import { Search } from "lucide-react";
import { FormEvent, useState } from "react";
import { formatDate, statusTone } from "@/lib/public-ui";

type TrackingResult = { id: string; createdAt: string; updatedAt?: string; status: string; nextStep: string; area: string; routeWindow?: string };

export function TrackingLookup() {
  const [status, setStatus] = useState("Enter the reference issued after booking.");
  const [result, setResult] = useState<TrackingResult | null>(null);
  const [pending, setPending] = useState(false);

  async function track(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reference = String(new FormData(event.currentTarget).get("trackingId") ?? "").trim();
    if (!reference) { setResult(null); setStatus("Enter a Bubble Wash reference first."); return; }
    setPending(true);
    setStatus("Checking the order…");
    try {
      const response = await fetch(`/api/track?id=${encodeURIComponent(reference)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Tracking lookup failed.");
      setResult(data.tracking);
      setStatus("Order found.");
    } catch (error) { setResult(null); setStatus(error instanceof Error ? error.message : "Unable to load tracking details."); }
    finally { setPending(false); }
  }

  return (
    <section className="serviceSection pageShell trackingPageSection" aria-labelledby="tracking-heading">
      <div className="trackingLayout"><form className="serviceForm" onSubmit={track}><label id="tracking-heading">Order reference<input name="trackingId" placeholder="BW-…" autoComplete="off" /></label><button className="button primary" type="submit" disabled={pending}><Search aria-hidden="true" />{pending ? "Checking…" : "Check order"}</button><p className={statusTone(status)} role="status" aria-live="polite">{status}</p></form>{result ? <article className="trackingResult"><strong className="trackingStatus">{result.status}</strong><p>{result.nextStep}</p><dl className="miniFacts"><div><dt>Reference</dt><dd>{result.id}</dd></div><div><dt>Collection area</dt><dd>{result.area}</dd></div><div><dt>Time window</dt><dd>{result.routeWindow || "Confirmation pending"}</dd></div><div><dt>Last updated</dt><dd>{formatDate(result.updatedAt || result.createdAt)}</dd></div></dl></article> : null}</div>
    </section>
  );
}
