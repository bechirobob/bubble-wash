"use client";
import { FormEvent, useState } from "react";
import Link from "next/link";
export default function ActivatePage() {
  const [status, setStatus] = useState("Choose a unique password with at least 14 characters.");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; setPending(true);
    try {
      const response = await fetch("/api/staff/activate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: window.location.hash.slice(1), password: new FormData(form).get("password") }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      window.history.replaceState(null, "", window.location.pathname); form.reset(); setStatus("Access activated. You can now sign in.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Connection failed. Please retry."); } finally { setPending(false); }
  }
  return <main className="pageShell serviceSection"><form className="serviceForm manageAccessForm" onSubmit={submit}><p className="sectionLabel">Individual staff access</p><h1>Activate your account</h1><label>New password<input name="password" type="password" autoComplete="new-password" minLength={14} maxLength={200} required /></label><button className="button primary" disabled={pending}>{pending ? "Activating…" : "Activate access"}</button><p role="status">{status}</p><Link href="/login">Staff sign-in</Link></form></main>;
}
