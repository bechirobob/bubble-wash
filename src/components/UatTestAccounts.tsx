"use client";
import { FormEvent, useEffect, useState } from "react";
type Team = { accounts: { username: string; name: string; role: string; entityId: string; status: string }[]; expiresAt: number; remaining: number; limit: number };
export function UatTestAccounts() {
  const [team, setTeam] = useState<Team | null>(null);
  const [status, setStatus] = useState("");
  const [newRole, setNewRole] = useState("support");
  const [pending, setPending] = useState(false);
  async function load() {
    const response = await fetch("/api/uat/accounts", { cache: "no-store" });
    if (!response.ok) throw new Error("Test user access is unavailable.");
    setTeam(await response.json());
  }
  useEffect(() => { let active = true; fetch("/api/uat/accounts", { cache: "no-store" }).then(async response => {
    if (!response.ok) throw new Error("Test user access is unavailable.");
    const data = await response.json(); if (active) setTeam(data);
  }).catch(error => { if (active) setStatus(error.message); }); return () => { active = false; }; }, []);
  async function update(body: Record<string, unknown>) {
    const response = await fetch("/api/uat/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    setStatus(result.message); await load();
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; setPending(true); setStatus("");
    try { await update({ action: "create", ...Object.fromEntries(new FormData(form)) }); form.reset(); setNewRole("support"); }
    catch(error) { setStatus(error instanceof Error ? error.message : "Unable to create test user."); }
    finally { setPending(false); }
  }
  async function revoke(username: string) {
    setPending(true); setStatus("");
    try { await update({ action: "revoke", username }); }
    catch(error) { setStatus(error instanceof Error ? error.message : "Unable to revoke test access."); }
    finally { setPending(false); }
  }
  return <section className="staffAccountPanel">
    <h2>Test users</h2>
    <p>Add Vendor, Driver or Support testers. They use a username and password, not an email invitation. You cannot create another administrator or owner.</p>
    {team ? <p>All test access ends {new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Malabo" }).format(team.expiresAt)} (Malabo). Adding a user does not start another seven days. {team.remaining} of {team.limit} account places remain.</p> : <p>Loading test users…</p>}
    {team?.accounts.map(account => <div className="staffCaseRow" key={account.username}>
      <div className="staffAccountIdentity"><strong>{account.name}</strong><span>{account.username} · {account.role} · {account.status}</span></div>
      <button type="button" className="button secondary" disabled={pending || account.status !== "active"} onClick={() => revoke(account.username)}>Revoke access</button>
    </div>)}
    <details><summary>Add a test user</summary><form onSubmit={create}>
      <div className="formGrid two">
        <label>Name<input name="name" required maxLength={100} /></label>
        <label>Username<input name="username" required minLength={3} maxLength={64} pattern="[a-z][a-z0-9._\-]{2,63}" autoComplete="off" /></label>
        <label>Role<select name="role" value={newRole} onChange={event => setNewRole(event.target.value)}><option value="support">Support</option><option value="vendor">Vendor</option><option value="driver">Driver</option></select></label>
        <label>Staff record ID<input name="entityId" disabled={newRole === "support"} required={newRole !== "support"} placeholder="Required for Vendor and Driver" /></label>
        <label>Temporary password<input name="password" type="password" required minLength={14} maxLength={200} autoComplete="new-password" /></label>
      </div>
      <p>Use a unique password of at least 14 characters. Keep it in the approved private handover: it cannot be viewed here again. Vendor and Driver users need an existing test staff record.</p>
      <button className="button primary" disabled={pending || !team || team.remaining === 0}>{pending ? "Saving…" : "Create test user"}</button>
    </form></details>
    <p role="status">{status}</p>
  </section>;
}
