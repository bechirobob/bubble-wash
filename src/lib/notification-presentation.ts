/** Browser-safe status wording. A successful API response is not delivery proof. */
export function notificationStatusLabel(status?: string) {
  if (status === "not_requested") return "Not requested";
  if (status === "delivered") return "Delivery confirmed";
  if (status === "accepted" || status === "sent") return "Delivery service accepted; delivery not confirmed";
  if (["retrying", "failed"].includes(status || "")) return "Waiting to try again";
  if (["queued", "pending", "processing"].includes(status || "")) return "Waiting to send; not delivered yet";
  if (["manual_review", "uncertain"].includes(status || "")) return "Delivery uncertain; team review needed";
  return "Not sent; follow-up needed";
}
