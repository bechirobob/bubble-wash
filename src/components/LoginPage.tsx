"use client";

import Image from "next/image";
import Link from "next/link";
import { FormEvent, Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

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
  const [status, setStatus] = useState("Enter staff credentials to open a separate workspace.");

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("Checking credentials…");
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, next: nextPath }),
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
    setStatus(`Loaded ${emailValue}. Enter the staff password to continue.`);
  }

  const roleRows = [
    ["Admin", "Orders, partners, staffing, escalations"],
    ["Vendor", "Washing queue, capacity, ready handoff"],
    ["Driver", "Pickup route, delivery stops, handoff proof"],
    ["Support", "Tickets, customer updates, issue closure"],
  ];

  return (
    <main className="loginPage redesignLoginPage">
      <header className="redesignTopbar">
        <Link className="brand" href="/" aria-label="Bubble Wash home">
          <Image className="brandMark" src="/bubble-wash-icon.jpg" alt="Bubble Wash logo" width={42} height={42} priority />
          <span>Bubble Wash Staff</span>
        </Link>
        <nav className="redesignTextNav" aria-label="Staff login links"><Link href="/">Back to site</Link><Link href="/staff">Roles</Link></nav>
      </header>
      <section className="redesignLoginGrid" aria-labelledby="login-title">
        <aside className="redesignRoleList">
          <p className="eyebrow">Staff access</p>
          <h2>Choose the workspace that matches your role.</h2>
          <p>Each staff login opens only the tools that person can act on.</p>
          {roleRows.map(([role, copy]) => (
            <div className="redesignRoleRow" key={role}><span aria-hidden="true" /><div><strong>{role}</strong><small>{copy}</small></div></div>
          ))}
          {showCredentialCards ? <div className="credentialList redesignCredentialList">{credentialCards.map(([role, emailValue]) => <button className="credentialCard" type="button" key={role} onClick={() => fillCredential(emailValue)}><strong>{role}</strong><span>{emailValue}</span></button>)}</div> : null}
        </aside>
        <form className="redesignLoginForm" onSubmit={login}>
          <p className="eyebrow">Sign in</p>
          <h1 id="login-title">Open your workspace</h1>
          <p>Use staff credentials. The destination is based on the selected role.</p>
          <label>Staff email<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" placeholder="Staff email" autoComplete="username" required /></label>
          <label>Password<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="Password" autoComplete="current-password" required /></label>
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
