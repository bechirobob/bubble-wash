import { customerSessionCookieName, decodeCustomerSession } from "@/lib/customer-session";
import { invoiceForOrder } from "@/lib/billing";
import { operationalDatabase } from "@/lib/operational-store";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { appendSubmissionRecord, findSubmissionRecordById } from "@/lib/data-store";
import { dispatchSubmissionNotifications } from "@/lib/notifications";
import { CheckoutInitializationError, initializePaystackCheckout, validateCheckoutInput, validCheckoutUrl } from "@/lib/payments";
import { verifyPaymentReference } from "@/lib/payment-reconciliation";
import { plans, type PlanName } from "@/lib/pricing";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
import { sameOriginJsonGuard } from "@/lib/security";

function text(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 1200) : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const planNames = new Set(plans.map((plan) => plan.name));
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

  let releaseLock: (() => void) | undefined;
  try {
    const body = await readCheckoutPayload(request);
    if (!isObject(body)) {
      return NextResponse.json({ ok: false, error: "Invalid checkout payload." }, { status: 400 });
    }
    const orderId = text(body.orderId);
    if (!/^BW-[A-Z0-9]{8,32}$/.test(orderId)) {
      return NextResponse.json({ ok: false, error: "Enter a valid Bubble Wash booking reference." }, { status: 400 });
    }
    const session = decodeCustomerSession(request.cookies.get(customerSessionCookieName)?.value);
    if (!session || session.orderId !== orderId) return NextResponse.json({ ok: false, error: "Verify your booking before paying." }, { status: 401 });
    const db = operationalDatabase();
    db.exec("CREATE TABLE IF NOT EXISTS payment_initialization_locks (order_id TEXT PRIMARY KEY, created_at TEXT NOT NULL)");
    const lockTime = new Date().toISOString();
    const acquired = db.transaction(() => {
      db.prepare("DELETE FROM payment_initialization_locks WHERE order_id = ? AND created_at < ?").run(orderId, new Date(Date.now() - 60_000).toISOString());
      return db.prepare("INSERT OR IGNORE INTO payment_initialization_locks VALUES (?, ?)").run(orderId, lockTime).changes;
    }).immediate();
    if (!acquired) return NextResponse.json({ ok: false, error: "Checkout is already being prepared. Wait a moment and try again." }, { status: 409 });
    releaseLock = () => { db.prepare("DELETE FROM payment_initialization_locks WHERE order_id = ? AND created_at = ?").run(orderId, lockTime); };
    const ownsLock = () => Boolean(db.prepare("SELECT 1 FROM payment_initialization_locks WHERE order_id = ? AND created_at = ?").get(orderId, lockTime)) && Date.now() - Date.parse(lockTime) < 60_000;
    let invoice = invoiceForOrder(orderId);
    if (!invoice || invoice.balanceMinor <= 0) return NextResponse.json({ ok: false, error: "No outstanding invoice is ready for payment." }, { status: 409 });
    const existing = db.prepare("SELECT data FROM submissions WHERE json_extract(data, '$.submissionType') = 'checkout-request' AND json_extract(data, '$.orderId') = ? ORDER BY created_at DESC, rowid DESC").all(orderId) as { data: string }[];
    let reusableCheckout: { reference: string; authorizationUrl: string; amountMinor: number } | undefined;
    for (const row of existing) {
      const prior = JSON.parse(row.data);
      if (prior.paymentStatus === "Checkout initialization failed") continue;
      let terminal = db.prepare("SELECT 1 FROM payment_verifications WHERE reference = ? AND status IN ('success', 'failed', 'abandoned', 'reversed')").get(prior.paymentReference);
      if (!terminal && !validCheckoutUrl(prior.authorizationUrl) && typeof prior.paymentReference === "string") {
        await verifyPaymentReference(prior.paymentReference);
        terminal = db.prepare("SELECT 1 FROM payment_verifications WHERE reference = ? AND status IN ('success', 'failed', 'abandoned', 'reversed')").get(prior.paymentReference);
      }
      if (!terminal) {
        if (!reusableCheckout && prior.paymentAmountMinor === invoice.balanceMinor && validCheckoutUrl(prior.authorizationUrl)) {
          reusableCheckout = { reference: prior.paymentReference, authorizationUrl: prior.authorizationUrl, amountMinor: prior.paymentAmountMinor };
          continue;
        }
        return NextResponse.json({ ok: false, reference: prior.paymentReference, error: "An earlier payment attempt is still being reconciled. Check its status before starting another." }, { status: 409 });
      }
    }
    invoice = invoiceForOrder(orderId);
    if (!invoice || invoice.balanceMinor <= 0) return NextResponse.json({ ok: false, error: "No outstanding invoice is ready for payment." }, { status: 409 });
    if (reusableCheckout) {
      if (reusableCheckout.amountMinor !== invoice.balanceMinor) return NextResponse.json({ ok: false, error: "The invoice balance changed. Reconcile the earlier checkout before trying again." }, { status: 409 });
      return NextResponse.json({ ok: true, payment: { reference: reusableCheckout.reference, authorizationUrl: reusableCheckout.authorizationUrl } });
    }
    if (!ownsLock()) throw new Error("Checkout preparation expired. Try again.");
    const booking = findSubmissionRecordById(orderId);
    if (!booking || text(booking.data.submissionType) !== "pickup-booking") {
      return NextResponse.json({ ok: false, error: "That reference is not linked to a customer booking." }, { status: 404 });
    }
    const plan = text(booking.data.plan);
    const selectedPlan = plans.find((item) => item.name === plan);
    if (!planNames.has(plan as PlanName) || !selectedPlan) {
      return NextResponse.json({ ok: false, error: "The booking does not contain a valid service plan." }, { status: 409 });
    }
    const input = {
      orderId,
      name: text(booking.data.name),
      email: text(booking.data.email),
      phone: text(booking.data.phone),
      company: text(booking.data.company),
      amountGhs: invoice.balanceMinor / 100,
      paymentMethod: text(body.paymentMethod) || "Card or Mobile Money",
      message: `Invoice ${invoice.invoiceId} outstanding balance.`,
    };
    const validationError = validateCheckoutInput(input);
    if (validationError) return NextResponse.json({ ok: false, error: validationError }, { status: 400 });

    const paymentReference = `BW-PAY-${randomUUID().replaceAll("-", "").slice(0, 18).toUpperCase()}`;
    const pendingRecord = { id: `BW-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`, createdAt: new Date().toISOString(), source: "bubblewash-paystack-checkout", data: { submissionType: "checkout-request", orderId, paymentReference, paymentAmountMinor: invoice.balanceMinor, paymentCurrency: "GHS", paymentStatus: "Checkout preparing", name: input.name, email: input.email, phone: input.phone, company: input.company } };
    appendSubmissionRecord(pendingRecord);
    let checkout;
    try {
      checkout = await initializePaystackCheckout(input, paymentReference);
      if (!ownsLock()) throw new Error("Checkout preparation expired. Try again.");
    } catch (error) {
      const paymentStatus = error instanceof CheckoutInitializationError && error.retryable
        ? "Checkout initialization failed" : "Checkout reconciliation required";
      db.prepare("UPDATE submissions SET data = json_set(data, '$.paymentStatus', ?) WHERE id = ?").run(paymentStatus, pendingRecord.id);
      throw error;
    }
    const record = {
      id: pendingRecord.id,
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
        authorizationUrl: checkout.authorizationUrl,
        paymentAmountMinor: checkout.amountMinor,
        paymentCurrency: checkout.currency,
        paymentStatus: "Checkout initialized",
        message: input.message,
      },
    };

    db.prepare("UPDATE submissions SET data = ? WHERE id = ?").run(JSON.stringify(record.data), pendingRecord.id);
    // The checkout remains usable even when a secondary notification fails.
    try { await dispatchSubmissionNotifications(record); }
    catch { console.error("Bubble Wash checkout notification failed"); }
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
  } finally {
    releaseLock?.();
  }
}
