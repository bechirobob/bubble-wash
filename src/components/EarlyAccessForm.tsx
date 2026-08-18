"use client";

import { FormEvent, useState } from "react";

type Result = { kind: "idle" | "submitting" | "success" | "error"; message?: string; updated?: boolean; confirmation?: { whatsapp: string; email: string } };

export function EarlyAccessForm() {
  const [result, setResult] = useState<Result>({ kind: "idle" });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setResult({ kind: "submitting" });
    try {
      const response = await fetch("/api/early-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: data.get("firstName"), phone: data.get("phone"), email: data.get("email"),
          area: data.get("area"), frequency: data.get("frequency"), website: data.get("website"),
          consent: data.get("consent") === "on",
        }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? "Unable to join early access.");
      setResult({ kind: "success", message: body.message, updated: body.updated, confirmation: body.confirmation });
      form.reset();
    } catch (error) {
      setResult({ kind: "error", message: error instanceof Error ? error.message : "Unable to join early access." });
    }
  }

  if (result.kind === "success") {
    return <aside className="servicePanel earlyAccessPanel" id="early-access" aria-live="polite"><p className="sectionLabel">You are on the list</p><h2>{result.updated ? "Your details are up to date." : "We saved your early-access request."}</h2><p>{result.message}</p><dl className="recordList"><div><dt>WhatsApp confirmation</dt><dd>{result.confirmation?.whatsapp === "sent" ? "Sent" : "Queued"}</dd></div><div><dt>Email confirmation</dt><dd>{result.confirmation?.email === "not_requested" ? "Not requested" : result.confirmation?.email === "sent" ? "Sent" : "Queued"}</dd></div></dl><button className="button secondary" type="button" onClick={() => setResult({ kind: "idle" })}>Update another signup</button></aside>;
  }

  return <aside className="servicePanel earlyAccessPanel" id="early-access" aria-labelledby="early-access-heading"><p className="sectionLabel">Early access</p><h2 id="early-access-heading">Get first notice for your area.</h2><p>No payment and no booking commitment.</p><form className="serviceForm earlyAccessForm" onSubmit={submit}><label>First name<input name="firstName" autoComplete="given-name" minLength={2} maxLength={60} required /></label><label>WhatsApp number<input name="phone" type="tel" autoComplete="tel" inputMode="tel" placeholder="024 000 0000" required /></label><label>Email <small>Optional</small><input name="email" type="email" autoComplete="email" maxLength={120} /></label><div className="formGrid two"><label>Area<select name="area" autoComplete="address-level2" defaultValue="" required><option value="" disabled>Select your area</option><option>Osu</option><option>Labone</option><option>Cantonments</option><option>Airport Residential</option><option>East Legon</option><option>Dzorwulu</option><option>Ridge</option><option>Adabraka</option><option>Spintex</option><option>Tema</option><option>Another Accra area</option></select></label><label>Laundry need<select name="frequency" defaultValue="Weekly" required><option>Weekly</option><option>Twice a month</option><option>When needed</option></select></label></div><label className="websiteField" aria-hidden="true">Website<input name="website" tabIndex={-1} autoComplete="off" /></label><label className="termsCheck"><input name="consent" type="checkbox" required /><span>I agree that Bubble Wash may contact me by WhatsApp, SMS or email about household launch availability, early-access offers and service updates. I can opt out at any time through the <a href="/privacy">privacy page</a>.</span></label><button className="button primary full" type="submit" disabled={result.kind === "submitting"}>{result.kind === "submitting" ? "Joining…" : "Join early access"}</button>{result.kind === "error" ? <p className="status error" role="alert">{result.message}</p> : null}<small>We collect only what is needed to plan coverage and contact you about this launch. We do not ask for a full home address here.</small></form></aside>;
}
