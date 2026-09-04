import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentStaffUser } from "@/lib/auth";
import { issueIntakeInvoice, invoiceForOrder, recordBillingEntry } from "@/lib/billing";
import { operationalDatabase } from "@/lib/operational-store";
import { appendSubmissionRecord } from "@/lib/data-store";
import { staffWriteGuard } from "@/lib/security";
export async function GET(request: NextRequest) {
  const user = await getCurrentStaffUser();
  if (!user || !["admin", "support"].includes(user.role)) return NextResponse.json({ ok: false }, { status: 403 });
  return NextResponse.json({ ok: true, invoice: invoiceForOrder(request.nextUrl.searchParams.get("orderId") || "") }, { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: NextRequest) {
  const guard = staffWriteGuard(request.headers); if (guard) return guard;
  const user = await getCurrentStaffUser();
  if (user?.role !== "admin") return NextResponse.json({ ok: false, error: "Admin authorization required." }, { status: 403 });
  try {
    const { orderId, kind, amount, reference, note, weight, routeFee } = await request.json();
    if (kind === "issue") {
      if (typeof orderId !== "string" || typeof note !== "string" || note.trim().length < 10 || note.length > 600) throw new Error("Document the source of the verified intake weight.");
      operationalDatabase().transaction(() => {
        if (routeFee !== "" && routeFee !== undefined) {
          const fee = Math.round(Number(routeFee) * 100);
          if (!Number.isSafeInteger(fee) || fee < 0 || fee > 25000000) throw new Error("Enter a valid agreed route fee.");
          operationalDatabase().prepare("INSERT INTO order_route_fees VALUES (?, ?, ?, ?, ?) ON CONFLICT(order_id) DO NOTHING").run(orderId, fee, user.email, note, new Date().toISOString());
        }
        issueIntakeInvoice(orderId, Number(weight));
        appendSubmissionRecord({ id: `BW-${randomUUID()}`, createdAt: new Date().toISOString(), source: "invoice-backfill", data: { submissionType: "invoice-audit", orderId, receivedWeightKg: weight, message: note, submittedByEmail: user.email } });
      }).immediate();
      return NextResponse.json({ ok: true, invoice: invoiceForOrder(orderId) });
    }
    if (!['payment', 'credit', 'refund'].includes(kind) || typeof reference !== "string" || reference.trim().length < 3 || reference.length > 120 || typeof note !== "string" || !note.trim() || note.length > 600 || typeof orderId !== "string") throw new Error("Enter the amount, unique bank/provider reference, and reconciliation note.");
    const amountMinor = Math.round(Number(amount) * 100);
    operationalDatabase().transaction(() => {
      const saved = recordBillingEntry(orderId, kind, amountMinor, `manual:${reference.trim()}`, user.email);
      if (saved) appendSubmissionRecord({ id: `BW-${randomUUID()}`, createdAt: new Date().toISOString(), source: "invoice-reconciliation", data: { submissionType: "payment-update", orderId, paymentStatus: invoiceForOrder(orderId)?.status === "paid" ? "Paid" : "Balance outstanding", paymentReference: reference, amountMinor, kind, message: note.trim(), submittedByEmail: user.email } });
    }).immediate();
    return NextResponse.json({ ok: true, invoice: invoiceForOrder(orderId) });
  } catch (error) { return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to record entry." }, { status: 409 }); }
}
