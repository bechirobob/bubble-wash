"use client";

import { useEffect, useState, type FormEvent } from "react";

type Invoice = { invoiceId: string; balanceMinor: number };

/** Loads the exact invoice values; the server still rechecks them at submission. */
export function InvoiceApprovalForm({ orderId, pending, onSubmit, onCancel }: {
  orderId: string;
  pending: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [message, setMessage] = useState("Loading current invoice…");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    fetch(`/api/orders/invoice?orderId=${encodeURIComponent(orderId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load the invoice. Refresh to try again.");
        const data = await response.json();
        if (!active) return;
        const value = data.invoice;
        if (!value || typeof value.invoiceId !== "string" || !value.invoiceId.trim() || !Number.isSafeInteger(value.balanceMinor) || value.balanceMinor <= 0 || value.balanceMinor > 25000000) {
          setMessage("No outstanding invoice is available for approval. Refresh the order before continuing.");
          return;
        }
        setInvoice({ invoiceId: value.invoiceId, balanceMinor: value.balanceMinor });
        setMessage("");
      })
      .catch(() => { if (active) setMessage("Unable to load the invoice. Refresh to try again."); })
      .finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [orderId, revision]);

  return <form className="structuredActionForm" onSubmit={(event) => {
    if (!invoice || pending) { event.preventDefault(); return; }
    onSubmit(event);
  }}>
    <div className="two">
      <label>Invoice number<input name="paymentReference" value={invoice?.invoiceId ?? ""} readOnly required /></label>
      <label>Outstanding amount (GHS)<input name="paymentAmount" value={invoice ? (invoice.balanceMinor / 100).toFixed(2) : ""} readOnly required /></label>
    </div>
    <label>Approval date<input name="paymentReceivedAt" type="date" required /></label>
    <label>Payment note<textarea name="operatorNote" placeholder="Account checked, approver, or exception reviewed" maxLength={600} required /></label>
    {message ? <p role="status">{message}</p> : null}
    <div className="tableActionRow">
      <button className="button primary" type="submit" disabled={!invoice || pending}>Save invoice approval</button>
      <button className="button secondary" type="button" disabled={pending} onClick={() => { setInvoice(null); setMessage("Loading current invoice…"); setRevision((value) => value + 1); }}>Refresh invoice</button>
      <button className="button secondary" type="button" disabled={pending} onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}
