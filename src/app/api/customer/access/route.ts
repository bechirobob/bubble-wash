import { NextRequest, NextResponse } from "next/server";
import { customerContactFingerprint, decodeCustomerSession, customerContactMatches, customerSessionCookieName, customerSessionCookieOptions, encodeCustomerSession } from "@/lib/customer-session";
import { customerOrderView } from "@/lib/customer-orders";
import { findSubmissionRecordById, readSubmissionRecordsForOrder } from "@/lib/data-store";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
import { sameOriginJsonGuard } from "@/lib/security";
import { buildOrderSummaries } from "@/lib/submissions";

function text(value: unknown, max = 160) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function POST(request: NextRequest) {
  const guard = sameOriginJsonGuard(request.headers, "customer order access");
  if (guard) return guard;
  if (isRateLimited(clientKey(request.headers, "customer-access"), 8, 60_000)) {
    return NextResponse.json({ ok: false, error: "Too many access attempts. Try again shortly." }, { status: 429 });
  }
  try {
    const body = await request.json();
    const orderId = text(body.orderId, 40).toUpperCase();
    const contact = text(body.contact);
    if (!/^BW-[A-Z0-9]{8,32}$/.test(orderId) || !contact) {
      return NextResponse.json({ ok: false, error: "Enter your Bubble Wash reference and booking email or phone." }, { status: 400 });
    }
    const seed = findSubmissionRecordById(orderId);
    const submissionType = text(seed?.data.submissionType);
    const email = text(seed?.data.email);
    const phone = text(seed?.data.phone);
    if (!seed || !["pickup-booking", "checkout-request"].includes(submissionType) || !customerContactMatches(contact, email, phone)) {
      return NextResponse.json({ ok: false, error: "We could not verify those booking details." }, { status: 401 });
    }
    const records = readSubmissionRecordsForOrder(orderId);
    const order = buildOrderSummaries(records)[0];
    if (!order) return NextResponse.json({ ok: false, error: "We could not verify those booking details." }, { status: 401 });
    const existingSession = decodeCustomerSession(request.cookies.get(customerSessionCookieName)?.value);
    const verifiedContact = Boolean(existingSession?.verifiedContact && existingSession.contactFingerprint === customerContactFingerprint(contact));
    const response = NextResponse.json({ ok: true, order: customerOrderView(order, records) });
    response.cookies.set({
      name: customerSessionCookieName,
      value: encodeCustomerSession(orderId, contact, verifiedContact),
      ...customerSessionCookieOptions(),
    });
    return response;
  } catch {
    return NextResponse.json({ ok: false, error: "Unable to open this order right now." }, { status: 500 });
  }
}
