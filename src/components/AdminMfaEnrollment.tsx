"use client";

import Image from "next/image";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { ArrowLeft, Copy, Download, ShieldCheck } from "lucide-react";
import { BrandLink } from "@/components/BrandLink";

type Enrollment = {
  qrCodeDataUrl: string;
  manualKey: string;
  expiresAt: string;
};

async function enrollmentRequest(payload: Record<string, string>) {
  const response = await fetch("/api/admin/mfa/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error ?? "Authenticator enrollment failed.");
  return data;
}

export function AdminMfaEnrollment() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("Use the production admin credentials to begin.");

  useEffect(() => {
    let active = true;
    enrollmentRequest({ action: "resume" })
      .then((data) => {
        if (!active || !Array.isArray(data.recoveryCodes) || !data.recoveryCodes.length) return;
        setRecoveryCodes(data.recoveryCodes);
        setStatus("Your recovery-code screen was restored. Save every code before continuing.");
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setStatus("Creating a protected authenticator setup…");
    try {
      const data = await enrollmentRequest({ action: "start", email, password });
      setEnrollment(data.enrollment);
      setStatus("Scan the QR code, then enter the current six-digit code.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to start authenticator setup.");
    } finally {
      setPending(false);
    }
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setStatus("Confirming the authenticator…");
    try {
      const data = await enrollmentRequest({ action: "confirm", email, password, code });
      setRecoveryCodes(data.recoveryCodes);
      setEnrollment(null);
      setPassword("");
      setCode("");
      setStatus("Authenticator enrolled. Save every recovery code before continuing.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to confirm authenticator setup.");
    } finally {
      setPending(false);
    }
  }

  async function copyRecoveryCodes() {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
      setStatus("Recovery codes copied. Store them in a secure password manager.");
    } catch {
      setStatus("Copy was blocked by the browser. Download the codes instead.");
    }
  }

  function downloadRecoveryCodes() {
    const content = ["Bubble Wash admin recovery codes", "Each code works once.", "", ...recoveryCodes].join("\n");
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "bubble-wash-admin-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
    setStatus("Recovery codes downloaded. Keep the file private.");
  }

  async function finish() {
    setPending(true);
    try {
      await enrollmentRequest({ action: "acknowledge" });
      window.location.href = "/admin";
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to finish enrollment.");
      setPending(false);
    }
  }

  return (
    <main className="loginPage redesignLoginPage">
      <header className="redesignTopbar">
        <BrandLink label="Bubble Wash Staff" priority />
        <nav className="redesignTextNav" aria-label="Enrollment links"><Link href="/login"><ArrowLeft aria-hidden="true" />Back to sign in</Link></nav>
      </header>
      <section className="mfaEnrollmentShell" aria-labelledby="mfa-title">
        <header className="mfaEnrollmentIntro"><ShieldCheck aria-hidden="true" /><div><p className="eyebrow">Admin security</p><h1 id="mfa-title">Set up your authenticator</h1><p>This adds a time-limited code to the admin password. Codes refresh every 30 seconds and cannot be replayed.</p></div></header>

        {!enrollment && !recoveryCodes.length ? <form className="redesignLoginForm mfaEnrollmentForm" onSubmit={start}>
          <h2>Verify the admin account</h2>
          <label>Admin email<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="username" required /></label>
          <label>Password<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required /></label>
          <button className="button primary full" type="submit" disabled={pending}>{pending ? "Starting…" : "Start secure setup"}</button>
        </form> : null}

        {enrollment && !recoveryCodes.length ? <div className="mfaSetupGrid">
          <section className="mfaQrPanel" aria-label="Authenticator QR code">
            <Image src={enrollment.qrCodeDataUrl} alt="Bubble Wash admin authenticator QR code" width={320} height={320} unoptimized priority />
            <p>Scan with Apple Passwords, Google Authenticator, Microsoft Authenticator, 1Password, or another TOTP app.</p>
          </section>
          <form className="redesignLoginForm mfaEnrollmentForm" onSubmit={confirm}>
            <h2>Confirm the connection</h2>
            <p>If you cannot scan, enter this setup key manually:</p>
            <code className="mfaManualKey">{enrollment.manualKey}</code>
            <label>Current six-digit code<input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required /></label>
            <button className="button primary full" type="submit" disabled={pending || code.length !== 6}>{pending ? "Confirming…" : "Confirm authenticator"}</button>
            <small>Setup expires at {new Date(enrollment.expiresAt).toLocaleTimeString()}.</small>
          </form>
        </div> : null}

        {recoveryCodes.length ? <section className="mfaRecoveryPanel" aria-labelledby="recovery-title">
          <h2 id="recovery-title">Save your recovery codes</h2>
          <p>Each code works once if the authenticator is unavailable. They will not be shown again after you continue.</p>
          <div className="mfaRecoveryCodes">{recoveryCodes.map((recovery) => <code key={recovery}>{recovery}</code>)}</div>
          <div className="tableActionRow"><button className="button secondary" type="button" onClick={() => void copyRecoveryCodes()}><Copy aria-hidden="true" />Copy all</button><button className="button secondary" type="button" onClick={downloadRecoveryCodes}><Download aria-hidden="true" />Download</button></div>
          <button className="button primary full" type="button" onClick={() => void finish()} disabled={pending}>{pending ? "Finishing…" : "I saved the codes — open admin"}</button>
        </section> : null}

        <p className="status" role="status" aria-live="polite">{status}</p>
      </section>
    </main>
  );
}
