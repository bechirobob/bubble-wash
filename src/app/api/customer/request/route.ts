import { operationalDatabase } from "@/lib/operational-store";
import { validatePickupSlot } from "@/lib/booking-policy";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { customerSessionCookieName, decodeCustomerSession } from "@/lib/customer-session";
import { appendSubmissionRecord, findSubmissionRecordById } from "@/lib/data-store";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
import { sameOriginJsonGuard } from "@/lib/security";

const actions = new Map([
  ["reschedule", "Customer reschedule request"],
  ["cancel", "Customer cancellation request"],
  ["quality", "Customer quality complaint"],
  ["damage", "Customer loss or damage claim"],
  ["refund", "Customer refund request"],
  ["care", "Customer garment-care note"],
]);


function text(value: unknown, max = 600) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function POST(request: NextRequest) {
  const guard = sameOriginJsonGuard(request.headers, "customer order request");
  if (guard) return guard;
  if (isRateLimited(clientKey(request.headers, "customer-request"), 10, 60_000)) {
    return NextResponse.json({ ok: false, error: "Too many requests. Try again shortly." }, { status: 429 });
  }
  const session = decodeCustomerSession(request.cookies.get(customerSessionCookieName)?.value);
  if (!session) return NextResponse.json({ ok: false, error: "Verify your booking details to continue." }, { status: 401 });
  try {
    const body = await request.json();
    const action = text(body.action, 30);
    const issueType = actions.get(action);
    const requestedDate = text(body.requestedDate, 20);
    const requestedWindow = text(body.requestedWindow, 80);
    const note = text(body.note);
    if (!issueType || !note || (action === "reschedule" && (
      validatePickupSlot(requestedDate, requestedWindow)
    ))) {
      return NextResponse.json({ ok: false, error: "Complete the request details before submitting." }, { status: 400 });
    }
    const seed = findSubmissionRecordById(session.orderId);
    if (!seed) return NextResponse.json({ ok: false, error: "This booking is no longer available." }, { status: 404 });
    const createdAt = new Date().toISOString();
    const ticketId = `BWC-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    operationalDatabase().transaction(() => {
    appendSubmissionRecord({
      id: ticketId,
      createdAt,
      source: "bubblewash-customer-self-service",
      data: {
        submissionType: "support-ticket",
        ticketId,
        orderId: session.orderId,
        name: text(seed.data.name, 100) || "Customer",
        email: text(seed.data.email, 160),
        phone: text(seed.data.phone, 80),
        company: "Bubble Wash customer",
        issueType,
        ticketStatus: "Open — customer request",
        priority: action === "cancel" ? "High" : "Normal",
        customerAction: action,
        requestedDate,
        requestedWindow,
        message: note,
        submittedByRole: "customer",
      },
    });
    if (["quality", "damage", "refund"].includes(action)) operationalDatabase().prepare("INSERT INTO order_holds VALUES (?, ?, ?) ON CONFLICT(order_id) DO UPDATE SET reason = excluded.reason, updated_at = excluded.updated_at").run(session.orderId, issueType, createdAt);
    }).immediate();
    return NextResponse.json({ ok: true, ticketId, message: "Your request is on the operations queue. The current order status remains in place until Bubble Wash confirms the change." });
  } catch {
    return NextResponse.json({ ok: false, error: "Unable to save this request right now." }, { status: 500 });
  }
}
