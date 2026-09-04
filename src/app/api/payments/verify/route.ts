import { NextRequest, NextResponse } from "next/server";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
import { verifyPaymentReference } from "@/lib/payment-reconciliation";

export async function GET(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED !== "true") {
    return NextResponse.json({ ok: false, error: "Online payment verification is not enabled for the pilot." }, { status: 503 });
  }
  if (isRateLimited(clientKey(request.headers, "payments-verify"), 30, 60_000)) {
    return NextResponse.json({ ok: false, error: "Too many verification requests. Try again shortly." }, { status: 429 });
  }

  const reference = request.nextUrl.searchParams.get("reference")?.trim();
  if (!reference) return NextResponse.json({ ok: false, error: "Missing payment reference." }, { status: 400 });
  if (!/^[A-Za-z0-9._-]{6,120}$/.test(reference)) {
    return NextResponse.json({ ok: false, error: "Invalid payment reference." }, { status: 400 });
  }

  return verifyPaymentReference(reference);
}
