import "server-only";

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
    id?: number;
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
  return Boolean(envText("PAYSTACK_SECRET_KEY"));
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

export async function initializePaystackCheckout(input: CheckoutInput) {
  const secret = envText("PAYSTACK_SECRET_KEY");
  if (!secret) throw new Error("PAYSTACK_SECRET_KEY is not configured.");

  const reference = `BW-PAY-${randomUUID().replaceAll("-", "").slice(0, 18).toUpperCase()}`;
  const amount = Math.round(input.amountGhs * 100);
  const baseUrl = publicBaseUrl();
  const response = await fetch("https://api.paystack.co/transaction/initialize", {
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
      callback_url: `${baseUrl}/?payment_reference=${encodeURIComponent(reference)}#booking`,
      channels: ["card", "mobile_money"],
      metadata: {
        custom_fields: [
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

  const data = (await response.json().catch(() => ({}))) as PaystackInitializeResponse;
  if (!response.ok || !data.status || !data.data?.authorization_url || !data.data.reference) {
    throw new Error(data.message || "Unable to initialize Paystack checkout.");
  }
  return {
    reference: data.data.reference,
    authorizationUrl: data.data.authorization_url,
    accessCode: data.data.access_code ?? "",
    amountGhs: input.amountGhs,
  };
}

export async function verifyPaystackCheckout(reference: string) {
  const secret = envText("PAYSTACK_SECRET_KEY");
  if (!secret) throw new Error("PAYSTACK_SECRET_KEY is not configured.");
  const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const data = (await response.json().catch(() => ({}))) as PaystackVerifyResponse;
  if (!response.ok || !data.status || !data.data) throw new Error(data.message || "Unable to verify Paystack checkout.");
  return data.data;
}
