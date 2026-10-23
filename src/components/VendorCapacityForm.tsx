"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";

type Capacity = { vendorId: string; vendorName: string; serviceZones: string[]; serviceTypes: string[]; capacityRemaining: number; availabilityStatus: string; updatedAt: string; revision: string; capacityEditable: boolean; allowedStatuses: string[]; notes?: string; capacityFreshness: { fresh: boolean } };
const labels: Record<string, string> = { available: "Available today", "available-tomorrow": "Available tomorrow", limited: "Limited capacity", paused: "Paused today" };
export function VendorCapacityForm({ onSaved }: { onSaved: () => void }) {
  const [vendor, setVendor] = useState<Capacity | null>(null);
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState<{ capacityRemaining: number; availabilityStatus: string; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const locked = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const version = ++generation.current;
    fetch("/api/vendor/capacity", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Unable to load capacity.");
      if (version === generation.current) {
        setVendor(data.vendors[0] || null);
        if (!data.vendors.length) setMessage("Your vendor roster is unavailable. Contact an administrator.");
      }
    }).catch((error) => { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Unable to load capacity."); });
    return () => { controller.abort(); generation.current = version + 1; };
  }, [refresh]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current || !vendor?.capacityEditable) return;
    locked.current = true; setBusy(true); setMessage("");
    const version = generation.current;
    const fields = new FormData(event.currentTarget);
    const command = { capacityRemaining: Number(fields.get("capacity")), availabilityStatus: String(fields.get("availability")), note: String(fields.get("note") || ""), expectedUpdatedAt: vendor.updatedAt, expectedRevision: vendor.revision, idempotencyKey: crypto.randomUUID() };
    try {
      const response = await fetch("/api/vendor/capacity", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Unable to confirm capacity.");
      if (version !== generation.current) return;
      setDraft(null);
      setMessage("Capacity confirmed for 12 hours. Approved coverage and services are unchanged.");
      onSaved(); setVendor(null); setRefresh((value) => value + 1);
    } catch (error) {
      if (version !== generation.current) return;
      setDraft(command);
      setVendor(null);
      setMessage(`${error instanceof Error ? error.message : "The result could not be confirmed."} Your edits are retained. Refresh capacity to compare the saved values before trying again.`);
    } finally { locked.current = false; setBusy(false); }
  }
  return <section className="staffContentSection"><div className="staffNarrowForm">
    <h2>Confirm today&apos;s capacity</h2><p>Confirm remaining slots, even when unchanged. Only an administrator can change approved coverage or services.</p>
    <button className="button" type="button" disabled={busy} onClick={() => { setVendor(null); setMessage(""); setRefresh((value) => value + 1); onSaved(); }}>Refresh capacity</button>
    {vendor ? <form key={`${vendor.revision}:${refresh}`} className="staffForm" onSubmit={save}>
      <p>{vendor.vendorName} · {vendor.serviceZones.join(", ")} · {vendor.serviceTypes.join(", ")}</p>
      {draft ? <p>Your unsaved edits are retained below. Current saved capacity: {vendor.capacityRemaining}; availability: {labels[vendor.availabilityStatus] || vendor.availabilityStatus}. Current saved note: {vendor.notes || "No note"}. Review before confirming again.</p> : null}
      <p>{vendor.capacityFreshness.fresh ? "Capacity is currently confirmed." : "Capacity needs confirmation."}</p>
      {!vendor.capacityEditable ? <p>This vendor cannot reactivate its availability. Contact an administrator.</p> : <>
        <label>Order slots remaining<input name="capacity" type="number" min="0" max="999" step="1" defaultValue={draft?.capacityRemaining ?? vendor.capacityRemaining} required disabled={busy} /></label>
        <label>Availability<select name="availability" defaultValue={draft?.availabilityStatus ?? (vendor.availabilityStatus === "active" ? "available" : vendor.availabilityStatus)} disabled={busy}>{vendor.allowedStatuses.map((status) => <option key={status} value={status}>{labels[status] || status}</option>)}</select></label>
        <label>Capacity note<textarea name="note" maxLength={600} defaultValue={draft?.note ?? vendor.notes ?? ""} disabled={busy} /></label>
        <button className="button primary" type="submit" disabled={busy}>{busy ? "Confirming capacity…" : "Confirm capacity"}</button>
      </>}
    </form> : null}
    {message ? <p role="status">{message}</p> : null}
  </div></section>;
}
