import { formatMoney } from "./public-ui.ts";

export async function checkPaymentCallback(reference: string, signal?: AbortSignal) {
  const response = await fetch(`/api/payments/verify?reference=${encodeURIComponent(reference)}`, {
    cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok || data?.ok !== true || typeof data.payment?.paid !== "boolean"
    || typeof data.payment.status !== "string" || typeof data.payment.amountGhs !== "number"
    || !Number.isFinite(data.payment.amountGhs)) {
    throw new Error("Unable to verify payment right now. Check its status again before starting another payment.");
  }
  return {
    paid: data.payment.paid,
    message: data.payment.paid
      ? `Payment verified: ${formatMoney(data.payment.amountGhs)}.`
      : `Payment status: ${data.payment.status}. Check again before starting another payment.`,
  };
}

export function paidCallbackUrl(href: string) {
  const url = new URL(href);
  url.searchParams.delete("payment_reference");
  return `${url.pathname}${url.search}${url.hash}`;
}

// Never apply an older verification result to another navigation or reference.
export function paymentCallbackStillCurrent(reference: string, startedHref: string, currentHref: string, signal: AbortSignal) {
  return !signal.aborted && new URL(startedHref).pathname === new URL(currentHref).pathname
    && new URL(currentHref).searchParams.get("payment_reference") === reference;
}
