import { NextRequest, NextResponse } from "next/server";
import { customerSessionCookieName, decodeCustomerSession } from "@/lib/customer-session";
import { createCustomerRequest } from "@/lib/customer-requests";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
import { sameOriginJsonGuard } from "@/lib/security";

export async function POST(request: NextRequest) {
  const guard = sameOriginJsonGuard(request.headers, "customer order request");
  if (guard) return guard;
  if (isRateLimited(clientKey(request.headers, "customer-request"), 10, 60_000)) {
    return NextResponse.json({ ok: false, error: "Too many requests. Try again shortly." }, { status: 429 });
  }
  const session = decodeCustomerSession(request.cookies.get(customerSessionCookieName)?.value);
  if (!session) return NextResponse.json({ ok: false, error: "Verify your booking details to continue." }, { status: 401 });
  try {
    const result = createCustomerRequest(session.orderId, await request.json());
    return NextResponse.json(result.body, { status: result.status });
  } catch {
    return NextResponse.json({ ok: false, error: "Unable to save this request right now." }, { status: 500 });
  }
}
