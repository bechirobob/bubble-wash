import "server-only";

import { randomUUID } from "node:crypto";
import {
  enqueueNotification,
  readSubmissionRecordsForOrder,
  readDueNotifications,
  updateNotificationDelivery,
  type NotificationOutboxRecord,
} from "@/lib/data-store";
import { buildOrderSummaries, type SubmissionRecord } from "@/lib/submissions";

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
  sent: boolean;
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

async function sendEmail(message: NotificationMessage): Promise<NotificationResult> {
  const apiKey = envText("RESEND_API_KEY");
  const from = envText("BUBBLEWASH_EMAIL_FROM") || "Bubble Wash <updates@bubblewash.co>";
  const to = message.toEmail;
  if (!to) return { channel: "email", target: message.target, sent: false, skipped: "No email address available." };
  if (!apiKey) return { channel: "email", target: message.target, sent: false, skipped: "RESEND_API_KEY is not configured." };

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: message.subject,
        text: message.text,
        html: message.html ?? `<p>${htmlEscape(message.text).replaceAll("\n", "<br />")}</p>`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await response.json().catch(() => ({}))) as { id?: string; message?: string; error?: string };
    if (!response.ok) {
      return { channel: "email", target: message.target, sent: false, error: data.message || data.error || "Resend email request failed." };
    }
    return { channel: "email", target: message.target, sent: true, providerId: data.id };
  } catch (error) {
    return { channel: "email", target: message.target, sent: false, error: error instanceof Error ? error.message : "Email send failed." };
  }
}

async function sendWhatsApp(message: NotificationMessage): Promise<NotificationResult> {
  const accessToken = envText("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = envText("WHATSAPP_PHONE_NUMBER_ID");
  const apiVersion = envText("WHATSAPP_API_VERSION");
  const templateName = message.purpose === "early_access"
    ? envText("WHATSAPP_EARLY_ACCESS_TEMPLATE")
    : message.purpose === "booking"
      ? envText("WHATSAPP_BOOKING_TEMPLATE")
      : message.purpose === "privacy"
        ? envText("WHATSAPP_PRIVACY_TEMPLATE")
        : envText("WHATSAPP_OPERATIONS_TEMPLATE");
  const to = normalizeGhanaPhone(message.toWhatsApp ?? "");
  if (!to) return { channel: "whatsapp", target: message.target, sent: false, skipped: "No WhatsApp number available." };
  if (!accessToken || !phoneNumberId || !apiVersion) return { channel: "whatsapp", target: message.target, sent: false, error: "WhatsApp Cloud API credentials are not configured." };
  if (!templateName) return { channel: "whatsapp", target: message.target, sent: false, error: "The approved WhatsApp template is not configured." };

  try {
    const response = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: "en" },
          components: message.whatsappTemplateParameters?.length ? [{
            type: "body",
            parameters: message.whatsappTemplateParameters.map((parameter) => ({ type: "text", text: parameter.slice(0, 1024) })),
          }] : undefined,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await response.json().catch(() => ({}))) as { messages?: Array<{ id?: string }>; error?: { message?: string } };
    if (!response.ok) {
      return { channel: "whatsapp", target: message.target, sent: false, error: data.error?.message || "WhatsApp message request failed." };
    }
    return { channel: "whatsapp", target: message.target, sent: true, providerId: data.messages?.[0]?.id };
  } catch (error) {
    return { channel: "whatsapp", target: message.target, sent: false, error: error instanceof Error ? error.message : "WhatsApp send failed." };
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

async function deliverOutboxRecord(record: NotificationOutboxRecord): Promise<NotificationResult> {
  const message = messageFromOutbox(record);
  const result = record.channel === "email" ? await sendEmail(message) : await sendWhatsApp(message);
  if (result.sent) {
    updateNotificationDelivery({ id: record.id, status: "sent", providerId: result.providerId });
    return result;
  }
  if (result.skipped) {
    updateNotificationDelivery({ id: record.id, status: "skipped", error: result.skipped });
    return result;
  }
  const retryAfterMs = Math.min(24 * 60 * 60_000, 60_000 * (2 ** Math.min(record.attempts, 10)));
  updateNotificationDelivery({ id: record.id, status: "failed", error: result.error ?? "Provider delivery failed.", retryAfterMs });
  return result;
}

async function enqueueAndDeliver(dedupeKey: string, channel: NotificationChannel, message: NotificationMessage) {
  const queued = enqueueNotification({
    id: `NQ-${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`,
    dedupeKey,
    channel,
    target: message.target,
    payload: messagePayload(message),
  });
  if (queued.status === "sent") return { channel, target: message.target, sent: true, providerId: queued.providerId } satisfies NotificationResult;
  return deliverOutboxRecord(queued);
}

export async function processNotificationOutbox(limit = 20) {
  const records = readDueNotifications(Math.max(1, Math.min(limit, 100)));
  const results: NotificationResult[] = [];
  for (const record of records) results.push(await deliverOutboxRecord(record));
  return results;
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
  if (process.env.NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED !== "true") return [{ channel: "email", target: "operations", sent: false, skipped: "Manual customer follow-up is required during the pilot." }];
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
    results.push({ channel, target: message.target, sent: queued.status === "sent", queued: queued.status === "pending" || queued.status === "failed" });
  }
  return results;
}
export async function dispatchSubmissionNotifications(record: SubmissionRecord) {
  return queueSubmissionNotifications(record);
}

export function notificationSummary(results: NotificationResult[]) {
  if (results.some((result) => result.queued)) return "Updates are queued for delivery.";
  const sent = results.filter((result) => result.sent).length;
  const skipped = results.filter((result) => result.skipped).length;
  const failed = results.filter((result) => result.error).length;
  if (sent) return `${sent} notification${sent === 1 ? "" : "s"} sent${failed ? `, ${failed} failed` : ""}.`;
  if (results.some((result) => result.skipped?.includes("Manual customer follow-up"))) return "Saved. Manual customer follow-up is required.";
  if (skipped && !failed) return "Automated updates are enabled but provider credentials are incomplete.";
  if (failed) return `${failed} notification${failed === 1 ? "" : "s"} failed. Check provider configuration.`;
  return "No notifications were required.";
}
