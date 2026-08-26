"use client";

import Link from "next/link";
import { FormEvent, Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Bike, Grid2X2, Headphones, ShieldCheck, WashingMachine, type LucideIcon } from "lucide-react";
import { BrandLink } from "@/components/BrandLink";

const showCredentialCards = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_BUBBLEWASH_SHOW_DEMO_LOGIN === "true";
const adminMfaRequired = process.env.NEXT_PUBLIC_BUBBLEWASH_ADMIN_MFA_REQUIRED === "true";

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
    const data = await response.json();
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
        <BrandLink label="Bubble Wash Staff" priority />
        <nav className="redesignTextNav" aria-label="Staff login links"><Link href="/"><ArrowLeft aria-hidden="true" />Back to site</Link><Link href="/staff"><Grid2X2 aria-hidden="true" />Roles</Link></nav>
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
          <label>Staff username or email<input value={email} onChange={(event) => setEmail(event.target.value)} type="text" placeholder="Staff username or email" autoComplete="username" required /></label>
          <label>Password<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="Password" autoComplete="current-password" required /></label>
          {adminMfaRequired ? <label>Admin authenticator or recovery code <small>(admin only)</small><input value={totp} onChange={(event) => setTotp(event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 18))} type="text" placeholder="6 digits or recovery code" inputMode="text" autoComplete="one-time-code" /></label> : null}
          <button className="button primary full" type="submit">Sign in</button>
          {adminMfaRequired ? <Link className="inlineIconLink" href="/admin/mfa/enroll">Set up admin authenticator</Link> : null}
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
