// A lease exceeds the provider timeout. Claim one record at a time so a slow
// batch cannot consume another record's lease before its request starts.
export const NOTIFICATION_REQUEST_TIMEOUT_MS = 10_000;
export const NOTIFICATION_LEASE_MS = 60_000;
export const NOTIFICATION_MAX_ATTEMPTS = 8;

// Resend retains keys for 24 hours. Stop a minute early, including time for the
// request, rather than risk an accepted-but-unrecorded email being sent again.
// https://resend.com/docs/dashboard/emails/idempotency-keys
export const RESEND_SAFE_RETRY_WINDOW_MS = 24 * 60 * 60_000 - 60_000;

export type NotificationDeliveryState =
  | "queued" | "processing" | "retrying" | "accepted" | "delivered"
  | "skipped" | "exhausted" | "manual_review";

export function commercialNotificationsEnabled() {
  return process.env.NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED === "true";
}

export function notificationRetryDelay(attempts: number) {
  return Math.min(24 * 60 * 60_000, 60_000 * (2 ** Math.min(Math.max(attempts - 1, 0), 10)));
}
