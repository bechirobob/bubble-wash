import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { appendSubmissionRecord } from "@/lib/data-store";
import { dispatchSubmissionNotifications, notificationSummary } from "@/lib/notifications";
import { initializePaystackCheckout, parseGhsAmount, validateCheckoutInput } from "@/lib/payments";
import { clientKey, isRateLimited } from "@/lib/rate-limit";

function text(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 1200) : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: NextRequest) {
  if (isRateLimited(clientKey(request.headers, "payments-initialize"), 12, 60_000)) {
    return NextResponse.json({ ok: false, error: "Too many checkout attempts. Try again shortly." }, { status: 429 });
  }

  try {
    const body = await request.json();
    if (!isObject(body)) {
      return NextResponse.json({ ok: false, error: "Invalid checkout payload." }, { status: 400 });
    }
    const amountGhs = parseGhsAmount(body.amount);
    const input = {
      name: text(body.name),
      email: text(body.email),
      phone: text(body.phone),
      company: text(body.company),
      amountGhs: amountGhs ?? 0,
      paymentMethod: text(body.paymentMethod) || "Card or Mobile Money",
      message: text(body.message),
    };
    const validationError = validateCheckoutInput(input);
    if (validationError) return NextResponse.json({ ok: false, error: validationError }, { status: 400 });

    const checkout = await initializePaystackCheckout(input);
    const record = {
      id: `BW-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`,
      createdAt: new Date().toISOString(),
      source: "bubblewash-paystack-checkout",
      data: {
        submissionType: "checkout-request",
        name: input.name,
        email: input.email,
        phone: input.phone,
        company: input.company,
        amount: `GHS ${input.amountGhs.toFixed(2)}`,
        paymentMethod: input.paymentMethod,
        paymentProvider: "Paystack",
        paymentReference: checkout.reference,
        paymentStatus: "Checkout initialized",
        message: input.message,
      },
    };

    appendSubmissionRecord(record);
    const notifications = await dispatchSubmissionNotifications(record);
    return NextResponse.json({
      ok: true,
      message: `Secure checkout created. ${notificationSummary(notifications)}`,
      id: record.id,
      payment: checkout,
      notifications,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to initialize checkout.";
    const status = message.includes("PAYSTACK_SECRET_KEY") ? 503 : 502;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
