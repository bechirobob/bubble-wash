import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { appendSubmissionRecord, findSubmissionRecordById } from "@/lib/data-store";
import { dispatchSubmissionNotifications } from "@/lib/notifications";
import { initializePaystackCheckout, validateCheckoutInput } from "@/lib/payments";
import { addons, calculateQuote, plans, zones, type AddonKey, type PlanName, type ZoneKey } from "@/lib/pricing";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
import { sameOriginJsonGuard } from "@/lib/security";

function text(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 1200) : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const planNames = new Set(plans.map((plan) => plan.name));
const zoneNames = new Set(Object.keys(zones));
const addonNames = new Set(Object.keys(addons));

function addonList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is AddonKey => typeof item === "string" && addonNames.has(item));
}

async function readCheckoutPayload(request: NextRequest) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED !== "true") {
    return NextResponse.json({ ok: false, error: "Online payments are coming soon. Use bank transfer or request an invoice for the pilot." }, { status: 503 });
  }
  const requestGuardError = sameOriginJsonGuard(request.headers, "checkout request");
  if (requestGuardError) return requestGuardError;
  if (isRateLimited(clientKey(request.headers, "payments-initialize"), 12, 60_000)) {
    return NextResponse.json({ ok: false, error: "Too many checkout attempts. Try again shortly." }, { status: 429 });
  }

  try {
    const body = await readCheckoutPayload(request);
    if (!isObject(body)) {
      return NextResponse.json({ ok: false, error: "Invalid checkout payload." }, { status: 400 });
    }
    const orderId = text(body.orderId);
    if (!/^BW-[A-Z0-9]{8,32}$/.test(orderId)) {
      return NextResponse.json({ ok: false, error: "Enter a valid Bubble Wash booking reference." }, { status: 400 });
    }
    const booking = findSubmissionRecordById(orderId);
    if (!booking || text(booking.data.submissionType) !== "pickup-booking") {
      return NextResponse.json({ ok: false, error: "That reference is not linked to a customer booking." }, { status: 404 });
    }
    const plan = text(booking.data.preferredPlan);
    const zone = text(booking.data.zone);
    const kg = Number(booking.data.kg);
    if (!planNames.has(plan as PlanName) || !zoneNames.has(zone) || !Number.isFinite(kg) || kg <= 0) {
      return NextResponse.json({ ok: false, error: "The booking does not contain a valid price estimate." }, { status: 409 });
    }
    const quote = calculateQuote(plan as PlanName, kg, addonList(booking.data.addons), zone as ZoneKey, "none");
    const input = {
      orderId,
      name: text(booking.data.name),
      email: text(booking.data.email),
      phone: text(booking.data.phone),
      company: text(booking.data.company),
      amountGhs: quote.estimatedMonthlyTotal,
      paymentMethod: text(body.paymentMethod) || "Card or Mobile Money",
      message: `Payment for Bubble Wash booking ${orderId}`,
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
        orderId,
        name: input.name,
        email: input.email,
        phone: input.phone,
        company: input.company,
        amount: `GHS ${input.amountGhs.toFixed(2)}`,
        paymentMethod: input.paymentMethod,
        paymentProvider: "Paystack",
        paymentReference: checkout.reference,
        paymentAmountMinor: checkout.amountMinor,
        paymentCurrency: checkout.currency,
        paymentStatus: "Checkout initialized",
        message: input.message,
      },
    };

    appendSubmissionRecord(record);
    await dispatchSubmissionNotifications(record);
    return NextResponse.json({
      ok: true,
      message: "Secure checkout created. Complete payment on the protected Paystack page.",
      id: record.id,
      payment: checkout,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to initialize checkout.";
    console.error("Bubble Wash checkout initialization failed", { message });
    const status = message.includes("PAYSTACK_SECRET_KEY") ? 503 : 502;
    return NextResponse.json({ ok: false, error: status === 503 ? "Online checkout is temporarily unavailable." : "Unable to initialize checkout." }, { status });
  }
}
