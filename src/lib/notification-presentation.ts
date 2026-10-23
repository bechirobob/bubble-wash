/** Browser-safe status wording. A successful API response is not delivery proof. */
export function notificationStatusLabel(status?: string) {
  if (status === "not_requested") return "Not requested";
  if (status === "delivered") return "Delivery confirmed";
  if (status === "accepted" || status === "sent") return "Provider accepted; delivery unverified";
  if (["retrying", "failed"].includes(status || "")) return "Retry pending";
  if (["queued", "pending", "processing"].includes(status || "")) return "Confirmation queued; not delivered yet";
  if (["manual_review", "uncertain"].includes(status || "")) return "Delivery uncertain; team review needed";
  return "Not sent; follow-up needed";
}
