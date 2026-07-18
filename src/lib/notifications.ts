import "server-only";

import type { SubmissionRecord } from "@/lib/submissions";

type NotificationChannel = "email" | "whatsapp";

type NotificationTarget = "customer" | "operations";

type NotificationMessage = {
  target: NotificationTarget;
  toEmail?: string;
  toWhatsApp?: string;
  subject: string;
  text: string;
  html?: string;
};

type NotificationResult = {
  channel: NotificationChannel;
  target: NotificationTarget;
  sent: boolean;
  providerId?: string;
  skipped?: string;
  error?: string;
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
  if (normalized.includes("call")) return channel === "whatsapp";
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
  const apiVersion = envText("WHATSAPP_API_VERSION") || "v23.0";
  const to = normalizeGhanaPhone(message.toWhatsApp ?? "");
  if (!to) return { channel: "whatsapp", target: message.target, sent: false, skipped: "No WhatsApp number available." };
  if (!accessToken || !phoneNumberId) return { channel: "whatsapp", target: message.target, sent: false, skipped: "WhatsApp Cloud API credentials are not configured." };

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
        type: "text",
        text: { preview_url: true, body: message.text },
      }),
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

function customerBookingMessage(record: SubmissionRecord): NotificationMessage {
  const data = record.data;
  const name = text(data.name) || "there";
  const area = text(data.area) || text(data.zone) || "your area";
  const publicUrl = configuredPublicUrl();
  const body = `Hi ${name}, Bubble Wash received your request ${record.id}.\n\nArea: ${area}\nPayment: ${text(data.paymentPreference) || text(data.paymentMethod) || "To be confirmed"}\n\nTrack it here: ${publicUrl}/#track\nUse reference: ${record.id}`;
  return {
    target: "customer",
    toEmail: text(data.email),
    toWhatsApp: text(data.phone),
    subject: `Bubble Wash request received: ${record.id}`,
    text: body,
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
  };
}

export async function dispatchSubmissionNotifications(record: SubmissionRecord) {
  if (process.env.NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED !== "true") {
    return [{ channel: "email", target: "operations", sent: false, skipped: "Manual customer follow-up is required during the pilot." }] satisfies NotificationResult[];
  }
  const type = text(record.data.submissionType);
  const preference = text(record.data.alertPreference);
  const messages = [operationsMessage(record)];
  if (["pickup-booking", "checkout-request", "client-onboarding"].includes(type)) messages.push(customerBookingMessage(record));

  const results: NotificationResult[] = [];
  for (const message of messages) {
    if (message.target === "customer") {
      if (alertAllows("email", preference)) results.push(await sendEmail(message));
      if (alertAllows("whatsapp", preference)) results.push(await sendWhatsApp(message));
    } else {
      results.push(await sendEmail(message));
      results.push(await sendWhatsApp(message));
    }
  }
  return results;
}

export function notificationSummary(results: NotificationResult[]) {
  const sent = results.filter((result) => result.sent).length;
  const skipped = results.filter((result) => result.skipped).length;
  const failed = results.filter((result) => result.error).length;
  if (sent) return `${sent} notification${sent === 1 ? "" : "s"} sent${failed ? `, ${failed} failed` : ""}.`;
  if (results.some((result) => result.skipped?.includes("Manual customer follow-up"))) return "Saved. Manual customer follow-up is required.";
  if (skipped && !failed) return "Automated updates are enabled but provider credentials are incomplete.";
  if (failed) return `${failed} notification${failed === 1 ? "" : "s"} failed. Check provider configuration.`;
  return "No notifications were required.";
}
