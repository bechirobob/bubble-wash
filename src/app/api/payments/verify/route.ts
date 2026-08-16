import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { appendPaymentVerificationOnce, findCheckoutByPaymentReference } from "@/lib/data-store";
import { parseGhsAmount, verifyPaystackCheckout } from "@/lib/payments";
import { clientKey, isRateLimited } from "@/lib/rate-limit";

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function expectedAmountMinor(data: Record<string, unknown>) {
  if (typeof data.paymentAmountMinor === "number" && Number.isSafeInteger(data.paymentAmountMinor) && data.paymentAmountMinor > 0) {
    return data.paymentAmountMinor;
  }
  const amount = parseGhsAmount(data.amount);
  return amount ? Math.round(amount * 100) : null;
}

export async function GET(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED !== "true") {
    return NextResponse.json({ ok: false, error: "Online payment verification is not enabled for the pilot." }, { status: 503 });
  }
  if (await isRateLimited(clientKey(request.headers, "payments-verify"), 30, 60_000)) {
    return NextResponse.json({ ok: false, error: "Too many verification requests. Try again shortly." }, { status: 429 });
  }

  const reference = request.nextUrl.searchParams.get("reference")?.trim();
  if (!reference) return NextResponse.json({ ok: false, error: "Missing payment reference." }, { status: 400 });
  if (!/^[A-Za-z0-9._-]{6,120}$/.test(reference)) {
    return NextResponse.json({ ok: false, error: "Invalid payment reference." }, { status: 400 });
  }

  const checkout = await findCheckoutByPaymentReference(reference);
  if (!checkout) {
    return NextResponse.json({ ok: false, error: "That payment reference is not linked to a Bubble Wash checkout." }, { status: 404 });
  }

  try {
    const verification = await verifyPaystackCheckout(reference);
    const providerReference = text(verification.reference);
    const providerStatus = text(verification.status).toLowerCase() || "unknown";
    const currency = text(verification.currency).toUpperCase();
    const amountMinor = verification.amount;
    const expectedMinor = expectedAmountMinor(checkout.data);
    const matchesCheckout = providerReference === reference
      && currency === "GHS"
      && Number.isSafeInteger(amountMinor)
      && typeof amountMinor === "number"
      && amountMinor > 0
      && expectedMinor !== null
      && amountMinor === expectedMinor;
    if (!matchesCheckout) {
      console.error("Bubble Wash Paystack verification mismatch", {
        reference,
        providerReference,
        currency,
        amountMatches: amountMinor === expectedMinor,
      });
      return NextResponse.json({ ok: false, error: "Payment details did not match the Bubble Wash checkout." }, { status: 409 });
    }

    const verifiedAmountMinor = amountMinor as number;
    const orderId = text(checkout.data.orderId) || checkout.id;
    const record = {
      id: `BW-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`,
      createdAt: new Date().toISOString(),
      source: "bubblewash-paystack-verification",
      data: {
        submissionType: "payment-update",
        orderId,
        name: "Paystack verification",
        email: "payments@bubblewash.local",
        phone: "payments-desk",
        company: "Bubble Wash Payments",
        paymentProvider: "Paystack",
        paymentReference: providerReference,
        paymentStatus: providerStatus,
        paymentAmountMinor: verifiedAmountMinor,
        paymentCurrency: currency,
        amount: `GHS ${(verifiedAmountMinor / 100).toFixed(2)}`,
        paymentMethod: verification.channel ?? "Unknown",
        message: `Paystack verification: ${verification.gateway_response ?? verification.status ?? "No gateway response"}`,
      },
    };
    const recorded = await appendPaymentVerificationOnce({
      record,
      reference,
      status: providerStatus,
      transactionId: verification.id === undefined ? undefined : String(verification.id),
      amountMinor: verifiedAmountMinor,
      currency,
    });
    return NextResponse.json({
      ok: true,
      payment: {
        reference: providerReference,
        status: providerStatus,
        paid: providerStatus === "success",
        amountGhs: verifiedAmountMinor / 100,
        currency,
        channel: text(verification.channel) || "unknown",
      },
      recorded,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to verify checkout.";
    console.error("Bubble Wash checkout verification failed", { message, reference });
    const status = message.includes("PAYSTACK_SECRET_KEY") ? 503 : 502;
    return NextResponse.json({ ok: false, error: status === 503 ? "Payment verification is temporarily unavailable." : "Unable to verify checkout." }, { status });
  }
}
