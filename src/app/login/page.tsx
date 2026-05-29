"use client";

import Image from "next/image";
import Link from "next/link";
import { FormEvent, Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

const credentialCards = [
  ["Admin", "admin@bubblewash.local", "Full access to admin, vendor, and support workspaces."],
  ["Vendor", "vendor@bubblewash.local", "Vendor capacity and job update workspace."],
  ["Support", "support@bubblewash.local", "Support ticket workspace."],
];

function LoginForm() {
  const searchParams = useSearchParams();
  const nextPath = useMemo(() => {
    const value = searchParams.get("next");
    return value && ["/admin", "/vendors", "/support"].includes(value) ? value : "/admin";
  }, [searchParams]);
  const [email, setEmail] = useState("admin@bubblewash.local");
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

  return (
    <main className="loginPage">
      <section className="loginShell">
        <Link className="brand" href="/" aria-label="Bubble Wash home">
          <Image className="brandMark" src="/bubble-wash-icon.jpg" alt="Bubble Wash logo" width={58} height={58} priority />
          <span>Bubble Wash Staff</span>
        </Link>
        <div className="loginGrid">
          <form className="panel loginPanel" onSubmit={login}>
            <p className="eyebrow">Staff login</p>
            <h1>Separate dashboards, cleaner public page.</h1>
            <p className="lead">Sign in to open the admin, vendor, or support workspace. Customers stay on the booking page; operations move behind credentials.</p>
            <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" placeholder="Staff email" required />
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="Password" required />
            <button className="button primary full" type="submit">Sign in</button>
            <p className="status">Destination: {nextPath}</p>
            <p className="status success">{status}</p>
          </form>
          <aside className="credentialPanel">
            <h2>Staff access</h2>
            <p>Demo users are listed for pilot review, but passwords are no longer printed on the page. Use the issued staff password or environment-backed credentials.</p>
            <div className="credentialList">
              {credentialCards.map(([role, emailValue, copy]) => (
                <button className="credentialCard" type="button" key={role} onClick={() => fillCredential(emailValue)}>
                  <strong>{role}</strong>
                  <span>{emailValue}</span>
                  <small>Password held server-side / issued to staff</small>
                  <small>{copy}</small>
                </button>
              ))}
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="loginPage"><section className="loginShell"><p className="status">Loading staff login…</p></section></main>}>
      <LoginForm />
    </Suspense>
  );
}
