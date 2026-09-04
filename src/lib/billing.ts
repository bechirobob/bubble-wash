import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { operationalDatabase } from "./operational-store.ts";
import { findSubmissionRecordById } from "./data-store.ts";
import { plans, addons, zones, type Plan, type AddonKey, type ZoneKey } from "./pricing.ts";

type PriceSnapshot = { version: string; plan: Plan; addons: typeof addons; zoneFee: number; minimum: number };
export type InvoiceLine = { label: string; amountMinor: number };
export function freezePricing(planName: string, zone: string): PriceSnapshot {
  const plan = plans.find((p) => p.name === planName);
  if (!plan) throw new Error("Select a valid plan.");
  return { version: "2026-09-04", plan, addons, zoneFee: zones[zone as ZoneKey]?.fee ?? 0, minimum: 450 };
}
export function issueIntakeInvoice(orderId: string, kg: number) {
  const db = operationalDatabase();
  return db.transaction(() => {
    if (invoiceForOrder(orderId)) return invoiceForOrder(orderId);
    const booking = findSubmissionRecordById(orderId);
    if (!booking || !Number.isFinite(kg) || kg <= 0 || kg > 10000) throw new Error("Verified intake weight is required.");
    const confirmedFee = db.prepare("SELECT amount_minor FROM order_route_fees WHERE order_id = ?").get(orderId) as { amount_minor: number } | undefined;
    if (booking.data.zone === "custom" && !confirmedFee) throw new Error("Confirm the custom route fee before invoicing this order.");
    const price = (booking.data.pricingSnapshot || freezePricing(String(booking.data.plan), String(booking.data.zone))) as PriceSnapshot;
    const band = [...price.plan.bands].reverse().find((b) => kg >= b.min) ?? price.plan.bands[0];
    const processing = Math.round(kg * band.rate * 100);
    const lines: InvoiceLine[] = [{ label: `Processing: ${kg.toFixed(2)} kg × GHS ${band.rate.toFixed(2)}`, amountMinor: processing }];
    for (const key of (booking.data.addons ?? []) as AddonKey[]) {
      const item = price.addons[key];
      const amount = "perKg" in item ? kg * item.perKg * 100 : "percent" in item ? processing * item.percent : item.fixed * 100;
      lines.push({ label: item.label, amountMinor: Math.round(amount) });
    }
    lines.push({ label: "Route fee", amountMinor: confirmedFee?.amount_minor ?? Math.round(price.zoneFee * 100) });
    const minimumAdjustment = Math.max(0, price.minimum * 100 - lines.reduce((sum, line) => sum + line.amountMinor, 0));
    if (minimumAdjustment) lines.push({ label: "Pickup minimum adjustment", amountMinor: minimumAdjustment });
    const accountKey = createHash("sha256").update(`${String(booking.data.email).trim().toLowerCase()}:${String(booking.data.company).trim().toLowerCase()}`).digest("hex");
    const period = booking.createdAt.slice(0, 7);
    const fee = db.prepare("INSERT OR IGNORE INTO account_service_fees VALUES (?, ?, ?)").run(accountKey, period, orderId);
    if (fee.changes) lines.push({ label: `${price.plan.name} monthly service fee (${period})`, amountMinor: Math.round(price.plan.subscription * 100) });
    db.prepare("INSERT INTO order_invoices VALUES (?, ?, ?, ?, ?, ?, ?)").run(orderId, `INV-${orderId}`, accountKey, period, JSON.stringify(lines), lines.reduce((s, l) => s + l.amountMinor, 0), new Date().toISOString());
    return invoiceForOrder(orderId);
  }).immediate();
}
export function invoiceForOrder(orderId: string) {
  const db = operationalDatabase();
  const invoice = db.prepare("SELECT invoice_id AS invoiceId, lines, total_minor AS totalMinor, created_at AS createdAt FROM order_invoices WHERE order_id = ?").get(orderId) as { invoiceId: string; lines: string; totalMinor: number; createdAt: string } | undefined;
  if (!invoice) return null;
  const entries = db.prepare("SELECT id, kind, amount_minor AS amountMinor, reference, created_at AS createdAt FROM billing_entries WHERE order_id = ? ORDER BY created_at").all(orderId) as { id: string; kind: string; amountMinor: number; reference: string; createdAt: string }[];
  const paidMinor = entries.reduce((sum, e) => sum + (e.kind === "refund" ? -e.amountMinor : e.amountMinor), 0);
  return { ...invoice, lines: JSON.parse(invoice.lines) as InvoiceLine[], entries, paidMinor, balanceMinor: invoice.totalMinor - paidMinor, status: paidMinor >= invoice.totalMinor ? "paid" : paidMinor > 0 ? "partially paid" : "invoiced" };
}
export function recordBillingEntry(orderId: string, kind: "payment" | "credit" | "refund", amountMinor: number, reference: string, actor: string, allowOverpayment = false) {
  const db = operationalDatabase();
  return db.transaction(() => {
    const prior = db.prepare("SELECT order_id, kind, amount_minor FROM billing_entries WHERE reference = ?").get(reference) as { order_id: string; kind: string; amount_minor: number } | undefined;
    if (prior) {
      if (prior.order_id !== orderId || prior.kind !== kind || prior.amount_minor !== amountMinor) throw new Error("Billing reference already used for another entry.");
      return false;
    }
    const invoice = invoiceForOrder(orderId);
    if (!invoice) throw new Error("Issue the verified intake invoice before recording payment.");
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || (kind !== "refund" && !allowOverpayment && amountMinor > invoice.balanceMinor)) throw new Error("Amount exceeds the outstanding invoice balance.");
    const cash = invoice.entries.reduce((sum, e) => sum + (e.kind === "payment" ? e.amountMinor : e.kind === "refund" ? -e.amountMinor : 0), 0);
    if (kind === "refund" && amountMinor > cash) throw new Error("Refund exceeds payments received.");
    db.prepare("INSERT INTO billing_entries VALUES (?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), orderId, kind, amountMinor, reference, actor, new Date().toISOString());
    return true;
  }).immediate();
}
