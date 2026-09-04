"use client";

import Link from "next/link";
import { FormEvent, Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Grid2X2 } from "lucide-react";
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
  const [statusTone, setStatusTone] = useState<"info" | "error">("info");

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("Checking credentials…");
    setStatusTone("info");
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, totp, next: nextPath }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setStatus(data.error ?? "Login cannot be reached.");
        setStatusTone("error");
        return;
      }
      window.location.href = data.next;
    } catch {
      setStatus("Login cannot be reached.");
      setStatusTone("error");
    }
  }

  function fillCredential(emailValue: string) {
    setEmail(emailValue);
    setPassword("");
    setTotp("");
    setStatus(`Loaded ${emailValue}. Enter the staff password to continue.`);
    setStatusTone("info");
  }


  return (
    <main className="loginPage redesignLoginPage">
      <header className="redesignTopbar">
        <BrandLink label="Bubble Wash Staff" priority />
        <nav className="redesignTextNav" aria-label="Staff login links"><Link href="/"><ArrowLeft aria-hidden="true" />Back to site</Link><Link href="/staff"><Grid2X2 aria-hidden="true" />Roles</Link></nav>
      </header>
      <section className="redesignLoginGrid" aria-labelledby="login-title">
        <aside className="redesignRoleList">
          <p className="eyebrow">Staff access</p>
          <h2>Staff sign-in</h2>
          <p>Use your individual work account to open your assigned workspace.</p>
          {showCredentialCards ? <div className="credentialList redesignCredentialList">{credentialCards.map(([role, emailValue]) => <button className="credentialCard" type="button" key={role} onClick={() => fillCredential(emailValue)}><strong>{role}</strong><span>{emailValue}</span></button>)}</div> : null}
        </aside>
        <form className="redesignLoginForm" onSubmit={login}>
          <p className="eyebrow">Sign in</p>
          <h1 id="login-title">Open your workspace</h1>
          <p>Enter your staff username or work email.</p>
          <label>Staff username or email<input value={email} onChange={(event) => setEmail(event.target.value)} type="text" placeholder="Staff username or email" autoComplete="username" required /></label>
          <label>Password<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="Password" autoComplete="current-password" required /></label>
          {adminMfaRequired ? <label>Admin authenticator or recovery code <small>(admin only)</small><input value={totp} onChange={(event) => setTotp(event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 18))} type="text" placeholder="6 digits or recovery code" inputMode="text" autoComplete="one-time-code" /></label> : null}
          <button className="button primary full" type="submit">Sign in</button>
          {adminMfaRequired ? <Link className="inlineIconLink" href="/admin/mfa/enroll">Set up admin authenticator</Link> : null}
          <p className="destination">Sessions expire after eight hours. Sign out when using a shared device.</p>
          <p className={`status ${statusTone}`} role={statusTone === "error" ? "alert" : "status"} aria-live={statusTone === "error" ? "assertive" : "polite"}>{status}</p>
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
