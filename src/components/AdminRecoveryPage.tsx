"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { BrandLink } from "@/components/BrandLink";

export function AdminRecoveryPageClient() {
  const token = useRef("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [status, setStatus] = useState("Choose the username and password you want to use for the master administrator.");
  const [complete, setComplete] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const recoveryToken = window.location.hash.slice(1).trim();
    if (recoveryToken) token.current = recoveryToken;
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function recover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    if (!token.current) {
      setStatus("This page must be opened from the complete private recovery link.");
      return;
    }
    setSubmitting(true);
    setStatus("Securing the new master administrator credentials…");
    try {
      const response = await fetch("/api/admin/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.current, login, password, passwordConfirmation }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setStatus(data.error ?? "Unable to update the master administrator.");
        return;
      }
      token.current = "";
      setPassword("");
      setPasswordConfirmation("");
      setComplete(true);
      setStatus("Your master administrator username and password are ready.");
    } catch {
      setStatus("Unable to reach Bubble Wash. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="loginPage redesignLoginPage">
      <header className="redesignTopbar">
        <BrandLink label="Bubble Wash Admin" priority />
        <nav className="redesignTextNav" aria-label="Admin recovery links"><Link href="/"><ArrowLeft aria-hidden="true" />Back to site</Link></nav>
      </header>
      <section className="redesignLoginGrid" aria-labelledby="recovery-title">
        <aside className="redesignRoleList">
          <p className="eyebrow">Private admin recovery</p>
          <h2>Reset only the master administrator.</h2>
          <p>This one-use link changes the admin sign-in without changing vendor, driver, or support access.</p>
          <div className="redesignRoleRow"><ShieldCheck aria-hidden="true" /><div><strong>Protected reset</strong><small>The link expires and stops working as soon as the credentials are changed.</small></div></div>
        </aside>
        <form className="redesignLoginForm" onSubmit={recover}>
          <p className="eyebrow">Master administrator</p>
          <h1 id="recovery-title">Choose your sign-in</h1>
          {complete ? (
            <>
              <p className="status success" role="status">{status}</p>
              <Link className="button primary full" href="/login?next=/admin">Go to admin sign in</Link>
            </>
          ) : (
            <>
              <p>Use a memorable username and a unique password of at least 16 characters.</p>
              <label>Master admin username<input value={login} onChange={(event) => setLogin(event.target.value)} type="text" placeholder="Your username" autoComplete="username" minLength={3} maxLength={64} required /></label>
              <label>New password<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="At least 16 characters" autoComplete="new-password" minLength={16} maxLength={128} required /></label>
              <label>Confirm new password<input value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} type="password" placeholder="Enter it again" autoComplete="new-password" minLength={16} maxLength={128} required /></label>
              <button className="button primary full" type="submit" disabled={submitting}>{submitting ? "Saving…" : "Set master admin sign-in"}</button>
              <p className="status" role="status" aria-live="polite">{status}</p>
            </>
          )}
        </form>
      </section>
    </main>
  );
}
