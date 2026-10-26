import "server-only";
import { assertUatProviderTrafficDisabled, uatModeEnabled } from "./uat-environment.ts";

import { bookingLabel } from "./booking-label.ts";
import { randomUUID } from "node:crypto";

type PaystackInitializeResponse = {
  status: boolean;
  message: string;
  data?: {
    authorization_url?: string;
    access_code?: string;
    reference?: string;
  };
};

type PaystackVerifyResponse = {
  status: boolean;
  message: string;
  data?: {
    id?: number | string;
    status?: string;
    reference?: string;
    amount?: number;
    currency?: string;
    gateway_response?: string;
    paid_at?: string | null;
    channel?: string;
  };
};

export type CheckoutInput = {
  bookingReference?: string | null;
  orderId: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  amountGhs: number;
  paymentMethod: string;
  message: string;
};

function envText(name: string) {
  return typeof process.env[name] === "string" ? process.env[name]!.trim() : "";
}

export function paystackConfigured() {
  return !uatModeEnabled() && Boolean(envText("PAYSTACK_SECRET_KEY"));
}

export function publicBaseUrl() {
  return envText("BUBBLEWASH_PUBLIC_URL") || "https://bubblewash.co";
}

export function parseGhsAmount(value: unknown) {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  const cleaned = raw.replace(/GHS|GH₵|,/gi, "").trim();
  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100) / 100;
}

export function validateCheckoutInput(input: CheckoutInput) {
  if (!input.name || !input.email || !input.phone || !input.company) return "Missing billing contact fields.";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) return "Enter a valid billing email.";
  if (!Number.isFinite(input.amountGhs) || input.amountGhs < 1) return "Enter an amount of at least GHS 1.";
  if (input.amountGhs > 100000) return "Online checkout is capped at GHS 100,000. Contact Bubble Wash for enterprise billing.";
  return null;
}

export class CheckoutInitializationError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

export function validCheckoutUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.paystack.com"
      && !url.username && !url.password && !url.port;
  } catch { return false; }
}

export async function initializePaystackCheckout(input: CheckoutInput, requestedReference?: string) {
  assertUatProviderTrafficDisabled();
  const secret = envText("PAYSTACK_SECRET_KEY");
  if (!secret) throw new CheckoutInitializationError("PAYSTACK_SECRET_KEY is not configured.", true);

  const reference = requestedReference || `BW-PAY-${randomUUID().replaceAll("-", "").slice(0, 18).toUpperCase()}`;
  const amount = Math.round(input.amountGhs * 100);
  const baseUrl = publicBaseUrl();
  const response = await fetch("https://api.paystack.co/transaction/initialize", {
    signal: AbortSignal.timeout(15000),
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: input.email,
      amount,
      currency: "GHS",
      reference,
      callback_url: `${baseUrl}/book?payment_reference=${encodeURIComponent(reference)}`,
      channels: ["card", "mobile_money"],
      metadata: {
        order_id: input.orderId,
        custom_fields: [
          { display_name: "Booking reference", variable_name: "booking_reference", value: bookingLabel(input) },
          { display_name: "Customer", variable_name: "customer", value: input.name },
          { display_name: "Phone", variable_name: "phone", value: input.phone },
          { display_name: "Account", variable_name: "company", value: input.company },
          { display_name: "Requested method", variable_name: "payment_method", value: input.paymentMethod },
        ],
        note: input.message,
        source: "bubblewash-web-checkout",
      },
    }),
  });

  const payload = await response.json().catch(() => null);
  const data = (payload && typeof payload === "object" ? payload : {}) as PaystackInitializeResponse;
  if (!response.ok || data.status !== true || !validCheckoutUrl(data.data?.authorization_url)
    || typeof data.data?.reference !== "string") {
    // A timeout, malformed success, server failure, or duplicate reference can hide
    // a live provider transaction. Only an explicit ordinary rejection permits retry.
    const message = typeof data.message === "string" ? data.message : "Unable to initialize Paystack checkout.";
    const retryable = [400, 401, 403].includes(response.status) && data.status === false
      && !/duplicate|reference|already|exist/i.test(message);
    throw new CheckoutInitializationError(message, retryable);
  }
  if (data.data.reference !== reference) throw new CheckoutInitializationError("Checkout reference did not match.", false);
  return {
    reference: data.data.reference,
    authorizationUrl: data.data.authorization_url,
    accessCode: data.data.access_code ?? "",
    amountGhs: input.amountGhs,
    amountMinor: amount,
    currency: "GHS" as const,
  };
}

export async function verifyPaystackCheckout(reference: string) {
  assertUatProviderTrafficDisabled();
  const secret = envText("PAYSTACK_SECRET_KEY");
  if (!secret) throw new Error("PAYSTACK_SECRET_KEY is not configured.");
  const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${secret}` },
  });
  const data = (await response.json().catch(() => ({}))) as PaystackVerifyResponse;
  if (!response.ok || !data || typeof data !== "object" || data.status !== true
    || !data.data || typeof data.data !== "object" || Array.isArray(data.data)
    || typeof data.data.status !== "string" || !data.data.status.trim()) {
    throw new Error("Unable to verify Paystack checkout.");
  }
  return data.data;
}
