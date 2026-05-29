import { NextRequest, NextResponse } from "next/server";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
import { findOrderById, readSubmissions } from "@/lib/submissions";

export async function GET(request: NextRequest) {
  if (isRateLimited(clientKey(request.headers, "track"), 40, 60_000)) {
    return NextResponse.json({ ok: false, error: "Too many tracking requests. Try again shortly." }, { status: 429 });
  }

  const id = request.nextUrl.searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ ok: false, error: "Enter a Bubble Wash reference ID." }, { status: 400 });

  const records = await readSubmissions(250);
  const order = findOrderById(records, id);

  if (!order) {
    return NextResponse.json({ ok: false, error: "No request found for that reference yet. Check the ID or contact support." }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    tracking: {
      id: order.orderId,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      type: order.lastEventType,
      customer: order.customer,
      status: order.status,
      nextStep: order.nextStep,
      area: order.area,
      payment: order.payment,
      vendor: order.vendor,
      eventCount: order.eventCount,
    },
  });
}
