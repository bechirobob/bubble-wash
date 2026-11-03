"use client";

import { Search } from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { bookingLabel } from "@/lib/booking-label";
import { formatDate } from "@/lib/public-ui";

type TrackingResult = { id: string; bookingReference?: string | null; createdAt: string; updatedAt?: string; status: string; nextStep: string; area: string; routeWindow?: string };

export function TrackingLookup() {
  const [status, setStatus] = useState("Open the private tracking link saved after booking. Your BW reference alone cannot unlock an order.");
  const [result, setResult] = useState<TrackingResult | null>(null);
  const [tone, setTone] = useState<"info" | "success" | "error">("info");
  const [pending, setPending] = useState(false);
  const [canRetry, setCanRetry] = useState(false);

  const activeRequest = useRef<AbortController | null>(null);
  const retryToken = useRef("");

  const loadTracking = useCallback(async (reference: string) => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    retryToken.current = reference;
    setCanRetry(Boolean(reference));
    setResult(null);
    if (!reference) { setPending(false); setTone("error"); setStatus("Enter your private tracking code first."); return; }
    setPending(true);
    setTone("info");
    setStatus("Checking the order…");
    try {
      const response = await fetch(`/api/track?trackingToken=${encodeURIComponent(reference)}`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
      const data = await response.json();
      if (activeRequest.current !== controller || controller.signal.aborted) return;
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Tracking lookup failed.");
      setResult(data.tracking);
      setStatus("Order found.");
      setTone("success");
    } catch (error) {
      if (activeRequest.current !== controller || controller.signal.aborted) return;
      setTone("error"); setStatus(error instanceof Error && error.name === "TimeoutError" ? "Tracking is taking too long. Try again." : error instanceof Error ? error.message : "Unable to load tracking details.");
    } finally {
      if (activeRequest.current === controller && !controller.signal.aborted) setPending(false);
    }
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    const token = new URLSearchParams(url.hash.slice(1)).get("tracking") || url.searchParams.get("id");
    if (token) {
      window.history.replaceState(window.history.state, "", url.pathname);
      retryToken.current = token;
    }
    // Retryable GET only. Keep the private token in memory, never storage or links.
    if (retryToken.current) void loadTracking(retryToken.current);
    return () => { activeRequest.current?.abort(); };
  }, [loadTracking]);

  async function track(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await loadTracking(String(new FormData(event.currentTarget).get("trackingId") ?? "").trim());
  }

  return (
    <section className="serviceSection pageShell trackingPageSection" aria-labelledby="tracking-heading">
      <div className="trackingLayout"><form className="serviceForm" onSubmit={track}><label id="tracking-heading">Private tracking code<input name="trackingId" placeholder="Paste private code" autoComplete="off" /></label><button className="button primary" type="submit" disabled={pending}><Search aria-hidden="true" />{pending ? "Checking…" : "Check order"}</button><p className={`status ${tone}`} role="status" aria-live="polite">{status}</p>{tone === "error" && canRetry ? <button className="button secondary" type="button" disabled={pending} onClick={() => void loadTracking(retryToken.current)}>Try tracking again</button> : null}<p><a href="/manage">Recover access using your booking email</a></p></form>{result ? <article className="trackingResult"><strong className="trackingStatus">{result.status}</strong><p>{result.nextStep}</p><dl className="miniFacts"><div><dt>Reference</dt><dd>{bookingLabel(result)}</dd></div><div><dt>Pickup locality</dt><dd>{result.area}</dd></div><div><dt>Pickup window</dt><dd>{result.routeWindow || "Confirmation pending"}</dd></div><div><dt>Last updated</dt><dd>{formatDate(result.updatedAt || result.createdAt)}</dd></div></dl></article> : null}</div>
    </section>
  );
}
