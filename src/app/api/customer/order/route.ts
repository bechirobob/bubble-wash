import { NextRequest, NextResponse } from "next/server";
import { customerSessionCookieName, decodeCustomerSession } from "@/lib/customer-session";
import { customerOrderView } from "@/lib/customer-orders";
import { readSubmissionRecordsForOrder } from "@/lib/data-store";
import { buildOrderSummaries } from "@/lib/submissions";

export async function GET(request: NextRequest) {
  const session = decodeCustomerSession(request.cookies.get(customerSessionCookieName)?.value);
  if (!session) return NextResponse.json({ ok: false, error: "Verify your booking details to continue." }, { status: 401 });
  const records = readSubmissionRecordsForOrder(session.orderId);
  const order = buildOrderSummaries(records)[0];
  if (!order) return NextResponse.json({ ok: false, error: "This booking is no longer available." }, { status: 404 });
  return NextResponse.json({ ok: true, order: customerOrderView(order, records) }, { headers: { "Cache-Control": "private, no-store" } });
}
