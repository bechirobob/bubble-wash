import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { appendSubmissionRecord } from "@/lib/data-store";
import { verifyPaystackCheckout } from "@/lib/payments";
import { clientKey, isRateLimited } from "@/lib/rate-limit";

export async function GET(request: NextRequest) {
  if (isRateLimited(clientKey(request.headers, "payments-verify"), 30, 60_000)) {
    return NextResponse.json({ ok: false, error: "Too many verification requests. Try again shortly." }, { status: 429 });
  }

  const reference = request.nextUrl.searchParams.get("reference")?.trim();
  if (!reference) return NextResponse.json({ ok: false, error: "Missing payment reference." }, { status: 400 });

  try {
    const verification = await verifyPaystackCheckout(reference);
    appendSubmissionRecord({
      id: `BW-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`,
      createdAt: new Date().toISOString(),
      source: "bubblewash-paystack-verification",
      data: {
        submissionType: "checkout-request",
        name: "Paystack verification",
        email: "payments@bubblewash.local",
        phone: "payments-desk",
        company: "Bubble Wash Payments",
        paymentProvider: "Paystack",
        paymentReference: verification.reference ?? reference,
        paymentStatus: verification.status ?? "unknown",
        amount: verification.amount ? `GHS ${(verification.amount / 100).toFixed(2)}` : "Unknown",
        paymentMethod: verification.channel ?? "Unknown",
        message: `Paystack verification: ${verification.gateway_response ?? verification.status ?? "No gateway response"}`,
      },
    });
    return NextResponse.json({ ok: true, payment: verification });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to verify checkout.";
    const status = message.includes("PAYSTACK_SECRET_KEY") ? 503 : 502;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
