"use client";

/* eslint-disable @next/next/no-html-link-for-pages, @next/next/no-img-element -- The static login shell must not depend on Worker-rendered navigation or image optimization. */

import { FormEvent, Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Bike, Grid2X2, Headphones, ShieldCheck, WashingMachine, type LucideIcon } from "lucide-react";

const showCredentialCards = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_BUBBLEWASH_SHOW_DEMO_LOGIN === "true";

const credentialCards = [
  ["Admin", "admin@bubblewash.local"],
  ["Vendor", "vendor@bubblewash.local"],
  ["Driver", "driver@bubblewash.local"],
  ["Support", "support@bubblewash.local"],
];

function LoginForm() {
  const searchParams = useSearchParams();
  const nextPath = useMemo(() => {
    const value = searchParams.get("next");
    return value && ["/admin", "/vendors", "/drivers", "/support"].includes(value) ? value : "/admin";
  }, [searchParams]);
  const [email, setEmail] = useState(showCredentialCards ? "admin@bubblewash.local" : "");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [status, setStatus] = useState("Enter staff credentials to open a separate workspace.");

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("Checking credentials…");
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, totp, next: nextPath }),
    });
    const data = await response.json<{ ok: boolean; error?: string; next: string }>();
    if (!response.ok || !data.ok) {
      setStatus(data.error ?? "Unable to sign in.");
      return;
    }
    window.location.href = data.next;
  }

  function fillCredential(emailValue: string) {
    setEmail(emailValue);
    setPassword("");
    setTotp("");
    setStatus(`Loaded ${emailValue}. Enter the staff password to continue.`);
  }

  const roleRows: Array<[string, string, LucideIcon]> = [
    ["Admin", "Orders, partners, staffing, escalations", ShieldCheck],
    ["Vendor", "Washing queue, capacity, ready handoff", WashingMachine],
    ["Driver", "Pickup route, delivery stops, handoff proof", Bike],
    ["Support", "Tickets, customer updates, issue closure", Headphones],
  ];

  return (
    <main className="loginPage redesignLoginPage">
      <header className="redesignTopbar">
        <a className="brand" href="/" aria-label="Bubble Wash home">
          <span className="brandCrop"><img className="brandMark" src="/apple-icon.png" alt="" width={42} height={42} /></span>
          <span>Bubble Wash Staff</span>
        </a>
        <nav className="redesignTextNav" aria-label="Staff login links"><a href="/"><ArrowLeft aria-hidden="true" />Back to site</a><a href="/staff"><Grid2X2 aria-hidden="true" />Roles</a></nav>
      </header>
      <section className="redesignLoginGrid" aria-labelledby="login-title">
        <aside className="redesignRoleList">
          <p className="eyebrow">Staff access</p>
          <h2>Choose the workspace that matches your role.</h2>
          <p>Each staff login opens only the tools that person can act on.</p>
          {roleRows.map(([role, copy, Icon]) => (
            <div className="redesignRoleRow" key={role}><Icon aria-hidden="true" /><div><strong>{role}</strong><small>{copy}</small></div></div>
          ))}
          {showCredentialCards ? <div className="credentialList redesignCredentialList">{credentialCards.map(([role, emailValue]) => <button className="credentialCard" type="button" key={role} onClick={() => fillCredential(emailValue)}><strong>{role}</strong><span>{emailValue}</span></button>)}</div> : null}
        </aside>
        <form className="redesignLoginForm" onSubmit={login}>
          <p className="eyebrow">Sign in</p>
          <h1 id="login-title">Open your workspace</h1>
          <p>Use staff credentials. The destination is based on the selected role.</p>
          <label>Staff email<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" placeholder="Staff email" autoComplete="username" required /></label>
          <label>Password<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="Password" autoComplete="current-password" required /></label>
          <label>Admin authenticator code <small>(admin only)</small><input value={totp} onChange={(event) => setTotp(event.target.value.replace(/\D/g, "").slice(0, 6))} type="text" placeholder="6-digit code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" /></label>
          <button className="button primary full" type="submit">Sign in</button>
          <div className="destination"><strong>Destination:</strong> {nextPath}<br />Sessions should expire automatically on shared devices.</div>
          <p className="status success" role="status" aria-live="polite">{status}</p>
        </form>
      </section>
    </main>
  );
}

export function LoginPageClient() {
  return (
    <Suspense fallback={<main className="loginPage"><section className="loginShell"><p className="status">Loading staff login…</p></section></main>}>
      <LoginForm />
    </Suspense>
  );
}
