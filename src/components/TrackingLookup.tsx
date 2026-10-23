"use client";

import { Search } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { bookingLabel } from "@/lib/booking-label";
import { formatDate } from "@/lib/public-ui";

type TrackingResult = { id: string; bookingReference?: string | null; createdAt: string; updatedAt?: string; status: string; nextStep: string; area: string; routeWindow?: string };

export function TrackingLookup() {
  const [status, setStatus] = useState("Open the private tracking link saved after booking. Your BW reference alone cannot unlock an order.");
  const [result, setResult] = useState<TrackingResult | null>(null);
  const [tone, setTone] = useState<"info" | "success" | "error">("info");
  const [pending, setPending] = useState(false);

  async function loadTracking(reference: string) {
    if (!reference) { setTone("error"); setResult(null); setStatus("Enter your private tracking code first."); return; }
    setPending(true);
    setTone("info");
    setStatus("Checking the order…");
    try {
      const response = await fetch(`/api/track?trackingToken=${encodeURIComponent(reference)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Tracking lookup failed.");
      setResult(data.tracking);
      setStatus("Order found.");
      setTone("success");
    } catch (error) { setTone("error"); setResult(null); setStatus(error instanceof Error ? error.message : "Unable to load tracking details."); }
    finally { setPending(false); }
  }

  useEffect(() => {
    const url = new URL(window.location.href);
    const token = new URLSearchParams(url.hash.slice(1)).get("tracking") || url.searchParams.get("id");
    if (token) {
      window.history.replaceState(null, "", url.pathname);
      let active = true;
      fetch(`/api/track?trackingToken=${encodeURIComponent(token)}`, { cache: "no-store" })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok || !data.ok) throw new Error(data.error || "Tracking lookup failed.");
          if (active) { setResult(data.tracking); setStatus("Order found."); setTone("success"); }
        }).catch((error) => {
          if (active) { setResult(null); setStatus(error instanceof Error ? error.message : "Unable to load tracking details."); setTone("error"); }
        });
      return () => { active = false; };
    }
  }, []);

  async function track(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await loadTracking(String(new FormData(event.currentTarget).get("trackingId") ?? "").trim());
  }

  return (
    <section className="serviceSection pageShell trackingPageSection" aria-labelledby="tracking-heading">
      <div className="trackingLayout"><form className="serviceForm" onSubmit={track}><label id="tracking-heading">Private tracking code<input name="trackingId" placeholder="BW-…" autoComplete="off" /></label><button className="button primary" type="submit" disabled={pending}><Search aria-hidden="true" />{pending ? "Checking…" : "Check order"}</button><p className={`status ${tone}`} role="status" aria-live="polite">{status}</p><p><a href="/manage">Recover access using your booking email</a></p></form>{result ? <article className="trackingResult"><strong className="trackingStatus">{result.status}</strong><p>{result.nextStep}</p><dl className="miniFacts"><div><dt>Reference</dt><dd>{bookingLabel(result)}</dd></div><div><dt>Pickup locality</dt><dd>{result.area}</dd></div><div><dt>Pickup window</dt><dd>{result.routeWindow || "Confirmation pending"}</dd></div><div><dt>Last updated</dt><dd>{formatDate(result.updatedAt || result.createdAt)}</dd></div></dl></article> : null}</div>
    </section>
  );
}
