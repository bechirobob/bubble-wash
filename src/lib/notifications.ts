import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  enqueueNotification,
  readSubmissionRecordsForOrder,
  beginNotificationAttempt,
  claimNotification,
  readNotification,
  notificationOutboxMetrics,
  updateNotificationDelivery,
  type NotificationOutboxRecord,
} from "@/lib/data-store";
import { buildOrderSummaries, type SubmissionRecord } from "@/lib/submissions";
import { commercialNotificationsEnabled, NOTIFICATION_REQUEST_TIMEOUT_MS, notificationRetryDelay, type NotificationDeliveryState } from "./notification-policy.ts";

export type NotificationChannel = "email" | "whatsapp";

export type NotificationTarget = "customer" | "operations";

export type NotificationMessage = {
  target: NotificationTarget;
  toEmail?: string;
  toWhatsApp?: string;
  subject: string;
  text: string;
  html?: string;
  purpose?: "booking" | "early_access" | "operations" | "privacy";
  whatsappTemplateParameters?: string[];
};

export type NotificationResult = {
  channel: NotificationChannel;
  target: NotificationTarget;
  /** Compatibility alias for provider acceptance, never proof of delivery. */
  sent: boolean;
  status?: NotificationDeliveryState;
  accepted?: boolean;
  delivered?: boolean;
  manualFollowUp?: boolean;
  exhausted?: boolean;
  outboxId?: string;
  providerId?: string;
  skipped?: string;
  error?: string;
  queued?: boolean;
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function envText(name: string) {
  return text(process.env[name]);
}

function configuredPublicUrl() {
  return envText("BUBBLEWASH_PUBLIC_URL") || "https://bubblewash.co";
}

function htmlEscape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function normalizeGhanaPhone(value: string) {
  const digits = value.replace(/[^\d+]/g, "");
  if (!digits) return "";
  if (digits.startsWith("+")) return digits.slice(1);
  if (digits.startsWith("233")) return digits;
  if (digits.startsWith("0") && digits.length >= 10) return `233${digits.slice(1)}`;
  return digits;
}

function alertAllows(channel: NotificationChannel, preference: string) {
  const normalized = preference.toLowerCase();
  if (!normalized) return true;
  if (normalized.includes("call")) return false;
  if (normalized.includes("whatsapp only")) return channel === "whatsapp";
  if (normalized.includes("email only")) return channel === "email";
  return normalized.includes(channel) || normalized.includes("email + whatsapp") || normalized.includes("both");
}

type PreparedRequest = {
  url: string;
  body: string;
  credential: string;
  accountHash: string;
  snapshot: string;
  idempotencyKey: string;
};

type ProviderOutcome = {
  status: "accepted" | "failed" | "uncertain" | "manual_review";
  providerId?: string;
  error?: string;
};

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

// Persist the exact body and destination once. A config/template/from-address
// change must not alter a retry carrying an already-used idempotency key.
function prepareRequest(record: NotificationOutboxRecord): PreparedRequest | { blocked: string } {
  const message = messageFromOutbox(record);
  let url: string;
  let body: string;
  let credential: string;
  let account: string;
  if (record.channel === "email") {
    if (!message.toEmail) return { blocked: "No email address available." };
    credential = envText("RESEND_API_KEY");
    if (!credential) return { blocked: "RESEND_API_KEY is not configured." };
    account = credential;
    url = "https://api.resend.com/emails";
    body = JSON.stringify({
      from: envText("BUBBLEWASH_EMAIL_FROM") || "Bubble Wash <updates@bubblewash.co>",
      to: [message.toEmail], subject: message.subject, text: message.text,
      html: message.html || `<p>${htmlEscape(message.text).replaceAll("\n", "<br />")}</p>`,
    });
  } else {
    const to = normalizeGhanaPhone(message.toWhatsApp ?? "");
    if (!to) return { blocked: "No WhatsApp number available." };
    credential = envText("WHATSAPP_ACCESS_TOKEN");
    const phoneNumberId = envText("WHATSAPP_PHONE_NUMBER_ID");
    const apiVersion = envText("WHATSAPP_API_VERSION");
    if (!credential || !phoneNumberId || !apiVersion) return { blocked: "WhatsApp Cloud API credentials are not configured." };
    account = `${credential}:${phoneNumberId}`;
    url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
    const templateName = envText(message.purpose === "early_access" ? "WHATSAPP_EARLY_ACCESS_TEMPLATE"
      : message.purpose === "booking" ? "WHATSAPP_BOOKING_TEMPLATE"
        : message.purpose === "privacy" ? "WHATSAPP_PRIVACY_TEMPLATE" : "WHATSAPP_OPERATIONS_TEMPLATE");
    if (!record.providerRequest && !templateName) return { blocked: "The approved WhatsApp template is not configured." };
    body = JSON.stringify({
      messaging_product: "whatsapp", recipient_type: "individual", to, type: "template",
      template: {
        name: templateName, language: { code: "en" },
        components: message.whatsappTemplateParameters?.length ? [{
          type: "body", parameters: message.whatsappTemplateParameters.map((parameter) => ({ type: "text", text: parameter.slice(0, 1024) })),
        }] : undefined,
      },
    });
  }
  const accountHash = hash(account);
  if (record.providerAccountHash && record.providerAccountHash !== accountHash) {
    return { blocked: "Provider account credentials changed after an attempt. Verify the original provider outcome before any resend." };
  }
  if (record.providerRequest) {
    try {
      const saved = JSON.parse(record.providerRequest) as { url?: string; body?: string };
      if (typeof saved.url !== "string" || typeof saved.body !== "string") throw new Error("Invalid snapshot");
      // Provider destinations are generated by us, not accepted from form data.
      if (record.channel === "email" ? saved.url !== "https://api.resend.com/emails"
        : !/^https:\/\/graph\.facebook\.com\/[^/]+\/[^/]+\/messages$/.test(saved.url)) throw new Error("Invalid provider");
      url = saved.url;
      body = saved.body;
    } catch {
      return { blocked: "Saved provider request is invalid. Manual review is required." };
    }
  }
  const snapshot = record.providerRequest || JSON.stringify({ url, body });
  const idempotencyKey = record.channel === "email"
    ? record.providerIdempotencyKey || `bubblewash/${hash(`${record.id}:${snapshot}`)}` : "";
  return { url, body, credential, accountHash, snapshot, idempotencyKey };
}

async function sendPreparedRequest(channel: NotificationChannel, request: PreparedRequest): Promise<ProviderOutcome> {
  try {
    const response = await fetch(request.url, {
      method: "POST", redirect: "error",
      headers: {
        Authorization: `Bearer ${request.credential}`, "Content-Type": "application/json",
        ...(request.idempotencyKey ? { "Idempotency-Key": request.idempotencyKey } : {}),
      },
      body: request.body,
      signal: AbortSignal.timeout(NOTIFICATION_REQUEST_TIMEOUT_MS),
    });
    const data = await response.json().catch(() => null) as {
      id?: string; name?: string; message?: string;
      messages?: Array<{ id?: string }>; error?: { message?: string } | string;
    } | null;
    if (response.ok) {
      const providerId = channel === "email" ? data?.id : data?.messages?.[0]?.id;
      if (typeof providerId === "string" && providerId.trim()) return { status: "accepted", providerId };
      return { status: "uncertain", error: "Provider returned success without a message ID. Acceptance is uncertain; delivery is not confirmed." };
    }
    const error = text(data?.message)
      || text(typeof data?.error === "string" ? data.error : data?.error?.message)
      || `Provider rejected the request (HTTP ${response.status}).`;
    // A timeout/server failure can happen after acceptance. WhatsApp has no
    // provider dedupe in this integration, so these must never be blind retries.
    if (response.status === 408 || response.status >= 500) return { status: "uncertain", error };
    if (response.status === 429 || (channel === "email" && response.status === 409 && data?.name === "concurrent_idempotent_requests")) {
      return { status: "failed", error };
    }
    return { status: "manual_review", error };
  } catch {
    // Do not persist thrown provider/client text, which may contain credentials.
    return { status: "uncertain", error: "Provider connection timed out or failed. The request may have been accepted; delivery is not confirmed." };
  }
}

function messagePayload(message: NotificationMessage) {
  return {
    toEmail: message.toEmail ?? "",
    toWhatsApp: message.toWhatsApp ?? "",
    subject: message.subject,
    text: message.text,
    html: message.html ?? "",
    purpose: message.purpose ?? "operations",
    whatsappTemplateParameters: message.whatsappTemplateParameters ?? [],
  };
}

function messageFromOutbox(record: NotificationOutboxRecord): NotificationMessage {
  const payload = record.payload;
  return {
    target: record.target,
    toEmail: text(payload.toEmail),
    toWhatsApp: text(payload.toWhatsApp),
    subject: text(payload.subject),
    text: text(payload.text),
    html: text(payload.html),
    purpose: ["booking", "early_access", "operations", "privacy"].includes(text(payload.purpose))
      ? text(payload.purpose) as NotificationMessage["purpose"]
      : "operations",
    whatsappTemplateParameters: Array.isArray(payload.whatsappTemplateParameters)
      ? payload.whatsappTemplateParameters.filter((value): value is string => typeof value === "string").slice(0, 10)
      : [],
  };
}

function resultFromOutbox(record: NotificationOutboxRecord): NotificationResult {
  const accepted = record.deliveryState === "accepted" || record.deliveryState === "delivered";
  return {
    channel: record.channel, target: record.target, outboxId: record.id,
    status: record.deliveryState, sent: accepted, accepted,
    delivered: record.deliveryState === "delivered", providerId: record.providerId || undefined,
    queued: ["queued", "retrying", "processing"].includes(record.deliveryState),
    skipped: record.deliveryState === "skipped" ? record.lastError : undefined,
    error: ["retrying", "exhausted", "manual_review"].includes(record.deliveryState) ? record.lastError : undefined,
    manualFollowUp: ["skipped", "exhausted", "manual_review"].includes(record.deliveryState),
    exhausted: record.deliveryState === "exhausted",
  };
}

async function deliverOutboxRecord(record: NotificationOutboxRecord): Promise<NotificationResult> {
  const prepared = prepareRequest(record);
  if ("blocked" in prepared) {
    updateNotificationDelivery({ id: record.id, leaseToken: record.leaseToken,
      status: record.attempts ? "manual_review" : "skipped", error: prepared.blocked });
    return resultFromOutbox(readNotification(record.id) ?? record);
  }
  const attempt = beginNotificationAttempt({ id: record.id, leaseToken: record.leaseToken,
    providerRequest: prepared.snapshot, idempotencyKey: prepared.idempotencyKey, accountHash: prepared.accountHash });
  if (!attempt) {
    updateNotificationDelivery({ id: record.id, leaseToken: record.leaseToken, status: "manual_review",
      error: "The request lease, retry limit, or deduplication evidence changed before sending. No new provider request was made." });
    return resultFromOutbox(readNotification(record.id) ?? record);
  }
  const result = await sendPreparedRequest(record.channel, prepared);
  updateNotificationDelivery({ id: record.id, leaseToken: record.leaseToken, ...result, retryAfterMs: notificationRetryDelay(attempt.attempts) });
  return resultFromOutbox(readNotification(record.id) ?? attempt);
}

async function enqueueAndDeliver(dedupeKey: string, channel: NotificationChannel, message: NotificationMessage) {
  const queued = enqueueNotification({
    id: `NQ-${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`,
    dedupeKey, channel, target: message.target, payload: messagePayload(message),
  });
  const claimed = claimNotification({ id: queued.id });
  return claimed ? deliverOutboxRecord(claimed) : resultFromOutbox(readNotification(queued.id) ?? queued);
}

export async function processNotificationOutbox(limit = 20) {
  const maximum = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 100)) : 20;
  const results: NotificationResult[] = [];
  for (let index = 0; index < maximum; index += 1) {
    const record = claimNotification();
    if (!record) break;
    results.push(await deliverOutboxRecord(record));
  }
  return results;
}

export function notificationOutboxSummary() {
  const metrics = notificationOutboxMetrics();
  return {
    queued: metrics.queued, retrying: metrics.retrying, processing: metrics.processing,
    accepted: metrics.accepted, delivered: metrics.delivered,
    skipped: metrics.skipped, exhausted: metrics.exhausted, manualReview: metrics.manualReview,
    manualFollowUp: metrics.skipped + metrics.exhausted + metrics.manualReview,
  };
}

function customerBookingMessage(record: SubmissionRecord): NotificationMessage {
  const data = record.data;
  const name = text(data.name) || "there";
  const area = text(data.area) || text(data.zone) || "your area";
  const publicUrl = configuredPublicUrl();
  const body = `Hi ${name}, Bubble Wash received your request ${record.id}.\n\nArea: ${area}\nPayment: ${text(data.paymentPreference) || text(data.paymentMethod) || "To be confirmed"}\n\nTrack it here: ${publicUrl}/track?id=${encodeURIComponent(record.id)}\nUse reference: ${record.id}`;
  return {
    target: "customer",
    toEmail: text(data.email),
    toWhatsApp: text(data.phone),
    subject: `Bubble Wash request received: ${record.id}`,
    text: body,
    purpose: "booking",
    whatsappTemplateParameters: [name, record.id, area],
  };
}

function operationsMessage(record: SubmissionRecord): NotificationMessage {
  const data = record.data;
  const type = text(data.submissionType) || "request";
  const body = `New Bubble Wash ${type}\n\nReference: ${record.id}\nCustomer: ${text(data.name) || "Unknown"}\nPhone: ${text(data.phone) || "Missing"}\nEmail: ${text(data.email) || "Missing"}\nArea: ${text(data.area) || text(data.zone) || "Not supplied"}\nPayment: ${text(data.paymentPreference) || text(data.paymentMethod) || "Not supplied"}\n\nNote: ${text(data.message) || "No note supplied."}`;
  return {
    target: "operations",
    toEmail: envText("BUBBLEWASH_OPERATIONS_EMAIL"),
    toWhatsApp: envText("BUBBLEWASH_OPERATIONS_WHATSAPP"),
    subject: `New Bubble Wash ${type}: ${record.id}`,
    text: body,
    purpose: "operations",
    whatsappTemplateParameters: [type, record.id],
  };
}

export async function dispatchEarlyAccessConfirmation(input: {
  id: string;
  firstName: string;
  phone: string;
  email: string;
  area: string;
}) {
  const message: NotificationMessage = {
    target: "customer",
    toEmail: input.email,
    toWhatsApp: input.phone,
    subject: "You are on the Bubble Wash early-access list",
    text: `Hi ${input.firstName}, you are on the Bubble Wash household early-access list for ${input.area}. We will contact you when residential collection is ready in your area. You can change your communication choice at ${configuredPublicUrl()}/privacy.`,
    purpose: "early_access",
    whatsappTemplateParameters: [input.firstName, input.area],
  };
  const results = [await enqueueAndDeliver(`${input.id}:early-access:whatsapp`, "whatsapp", message)];
  if (input.email) results.push(await enqueueAndDeliver(`${input.id}:early-access:email`, "email", message));
  return results;
}

export async function dispatchPrivacyRequestConfirmation(input: {
  id: string;
  name: string;
  contact: string;
  requestType: string;
}) {
  const isEmail = input.contact.includes("@");
  const message: NotificationMessage = {
    target: "customer",
    toEmail: isEmail ? input.contact : "",
    toWhatsApp: isEmail ? "" : input.contact,
    subject: `Bubble Wash privacy request received: ${input.id}`,
    text: `Hi ${input.name}, Bubble Wash received your ${input.requestType.replaceAll("_", " ")} request. Reference: ${input.id}. Identity verification may be required before personal information is disclosed, corrected or deleted.`,
    purpose: "privacy",
    whatsappTemplateParameters: [input.name, input.id, input.requestType.replaceAll("_", " ")],
  };
  return [await enqueueAndDeliver(`${input.id}:privacy:${isEmail ? "email" : "whatsapp"}`, isEmail ? "email" : "whatsapp", message)];
}

export function queueSubmissionNotifications(record: SubmissionRecord): NotificationResult[] {
  if (!commercialNotificationsEnabled()) return [{ channel: "email", target: "operations", sent: false, status: "skipped", manualFollowUp: true, skipped: "Manual customer follow-up is required during the pilot." }];
  const type = text(record.data.submissionType);
  const orderRecords = text(record.data.orderId) ? readSubmissionRecordsForOrder(text(record.data.orderId)) : [];
  const seed = orderRecords.find((item) => text(item.data.submissionType) === "pickup-booking");
  const preference = text(seed?.data.alertPreference) || text(record.data.alertPreference);
  const messages = [operationsMessage(record)];
  if (["pickup-booking", "client-onboarding"].includes(type)) messages.push(customerBookingMessage(record));
  else if (seed && ["admin-operation", "vendor-job-update", "driver-route-log", "qr-bag-intake", "payment-update"].includes(type)) {
    const order = buildOrderSummaries(orderRecords)[0];
    messages.push({ target: "customer", toEmail: text(seed.data.email), toWhatsApp: text(seed.data.phone), subject: `Bubble Wash ${seed.id}: ${order.status}`, text: `Your order ${seed.id}: ${order.status}. View your current schedule and invoice at ${configuredPublicUrl()}/manage.`, purpose: "operations" });
  }
  const results: NotificationResult[] = [];
  for (const message of messages) for (const channel of ["email", "whatsapp"] as const) {
    if (message.target === "customer" && !alertAllows(channel, preference)) continue;
    const queued = enqueueNotification({ id: `NQ-${randomUUID()}`, dedupeKey: `${record.id}:${message.target}:${channel}`, channel, target: message.target, payload: messagePayload(message) });
    results.push(resultFromOutbox(queued));
  }
  return results;
}
export async function dispatchSubmissionNotifications(record: SubmissionRecord) {
  return queueSubmissionNotifications(record);
}

export function notificationSummary(results: NotificationResult[]) {
  if (results.some((result) => result.skipped?.includes("Manual customer follow-up"))) return "Saved. Manual customer follow-up is required.";
  const delivered = results.filter((result) => result.delivered).length;
  const accepted = results.filter((result) => (result.accepted || result.sent) && !result.delivered).length;
  const queued = results.filter((result) => result.queued).length;
  const skipped = results.filter((result) => result.skipped).length;
  const exhausted = results.filter((result) => result.exhausted).length;
  const review = results.filter((result) => result.manualFollowUp && !result.skipped && !result.exhausted).length;
  const failed = results.filter((result) => result.error && !result.queued && !result.manualFollowUp).length;
  const parts: string[] = [];
  if (delivered) parts.push(`${delivered} confirmed delivered`);
  if (accepted) parts.push(`${accepted} accepted by the provider (delivery not confirmed)`);
  if (queued) parts.push(`${queued} queued for delivery${results.some((result) => result.status === "retrying") ? " or safe retry" : ""}`);
  if (skipped) parts.push(`${skipped} skipped; manual follow-up required`);
  if (exhausted) parts.push(`${exhausted} exhausted retries; manual follow-up required`);
  if (review) parts.push(`${review} require manual review before any resend`);
  if (failed) parts.push(`${failed} failed; check provider configuration`);
  return parts.length ? `Notifications: ${parts.join("; ")}.` : "No notifications were required.";
}
