"use client";

import { FormEvent, useState } from "react";

export function PrivacyRequestForm() {
  const [status, setStatus] = useState("");
  const [phase, setPhase] = useState<"idle" | "pending" | "success" | "error">("idle");
  const pending = phase === "pending";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setPhase("pending");
    setStatus("Saving your request…");
    try {
      const data = new FormData(form);
      const response = await fetch("/api/privacy/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(data.entries())),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? "Unable to save the request.");
      setPhase("success");
      setStatus(`${body.message} Reference: ${body.id}`);
      form.reset();
    } catch (error) {
      setPhase("error");
      setStatus(error instanceof Error ? error.message : "Unable to save the request.");
    }
  }

  return <form className="serviceForm policyRequestForm" onSubmit={submit}><div className="formGrid two"><label>Name<input name="name" autoComplete="name" maxLength={100} required /></label><label>Email or Ghana phone<input name="contact" autoComplete="email" maxLength={160} required /></label></div><div className="formGrid two"><label>Request<select name="requestType" defaultValue="access"><option value="access">Access my information</option><option value="correction">Correct my information</option><option value="deletion">Delete eligible information</option><option value="marketing_opt_out">Stop marketing updates</option></select></label><label>Order reference <small>Optional</small><input name="orderId" placeholder="BW-…" autoComplete="off" maxLength={120} /></label></div><label className="websiteField" aria-hidden="true">Website<input name="website" tabIndex={-1} autoComplete="off" /></label><button className="button primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Submit privacy request"}</button>{status ? <p className={`status ${phase === "error" ? "error" : phase === "success" ? "success" : ""}`} role={phase === "error" ? "alert" : "status"}>{status}</p> : null}<small>Identity verification may be required before information is disclosed, corrected or deleted.</small></form>;
}
