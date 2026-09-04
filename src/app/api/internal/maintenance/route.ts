import { operationalDatabase } from "@/lib/operational-store";
import { verifyPaymentReference } from "@/lib/payment-reconciliation";
import { NextRequest, NextResponse } from "next/server";
import { operationsDataMetrics, purgeOperationalData } from "@/lib/data-store";
import { maintenanceAuthorized } from "@/lib/maintenance-auth";
import { processNotificationOutbox } from "@/lib/notifications";
import { logEvent } from "@/lib/observability";

export async function POST(request: NextRequest) {
  if (!maintenanceAuthorized(request.headers)) return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  try {
    const db = operationalDatabase();
    const pendingPayments = process.env.PAYSTACK_SECRET_KEY ? db.prepare(`SELECT DISTINCT json_extract(data, '$.paymentReference') AS reference FROM submissions WHERE json_extract(data, '$.submissionType') = 'checkout-request' AND json_extract(data, '$.paymentReference') IS NOT NULL AND created_at > ? AND json_extract(data, '$.paymentReference') NOT IN (SELECT reference FROM payment_verifications WHERE status = 'success') ORDER BY created_at ASC LIMIT 10`).all(new Date(Date.now() - 7 * 86400000).toISOString()) as { reference: string }[] : [];
    for (const payment of pendingPayments) await verifyPaymentReference(payment.reference);
    const delivered = await processNotificationOutbox(50);
    const purged = purgeOperationalData();
    const metrics = operationsDataMetrics();
    logEvent("info", "maintenance.completed", { deliveryAttempts: delivered.length, purged, metrics });
    return NextResponse.json({ ok: true, deliveryAttempts: delivered.length, purged, metrics, time: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logEvent("error", "maintenance.failed", { errorType: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ ok: false, error: "Maintenance run failed." }, { status: 500 });
  }
}
