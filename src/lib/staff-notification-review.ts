import "server-only";
import { getDatabase } from "./data-store.ts";
import { notificationOutboxSummary } from "./notifications.ts";

// Operational metadata only. Never expose recipients, message bodies, provider
// request payloads, authentication links, provider IDs or raw error strings.
export function notificationReviewWorklist(start = 0) {
  const offset = Math.max(0, Math.min(1_000_000, Math.floor(start) || 0));
  const summary = notificationOutboxSummary();
  const rows = getDatabase().prepare(`SELECT id, channel, target, delivery_state AS state, attempts,
    created_at AS createdAt, updated_at AS updatedAt FROM notification_outbox
    WHERE delivery_state IN ('manual_review','exhausted','skipped')
    ORDER BY updated_at DESC,id DESC LIMIT 51 OFFSET ?`).all(offset) as {
      id: string; channel: string; target: string; state: string; attempts: number; createdAt: string; updatedAt: string;
    }[];
  return { ok: true, summary, items: rows.slice(0, 50), nextOffset: rows.length > 50 ? offset + 50 : null,
    providerActivationAvailable: false, resendAvailable: false,
    policy: "Acceptance by the delivery service does not confirm delivery. Check unclear results with that service before considering another message. This page cannot resend messages or turn on a delivery service." };
}
