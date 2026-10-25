import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { operationalDatabase } from "./operational-store.ts";
import { validatePickupSlot } from "./booking-policy.ts";
import { appendSubmissionRecord, findSubmissionRecordById, readSubmissionRecordsForOrder } from "./data-store.ts";

const actions = new Map([
  ["reschedule", "Customer reschedule request"], ["cancel", "Customer cancellation request"],
  ["quality", "Customer quality complaint"], ["damage", "Customer loss or damage claim"],
  ["refund", "Customer refund request"], ["care", "Customer garment-care note"],
]);
const text = (value: unknown, max = 600) => typeof value === "string" ? value.trim().slice(0, max) : "";
const requestReceipt = (ticketId: string) => ({ ok: true, ticketId, message: "Your request is on the operations queue. The current order status remains in place until Bubble Wash confirms the change." });
type Result = { status: number; body: Record<string, unknown> };
export function createCustomerRequest(orderId: string, body: Record<string, unknown>, idempotencyKey?: string): Result {
  const action = text(body.action, 30);
  const issueType = actions.get(action);
  const requestedDate = text(body.requestedDate, 20);
  const requestedWindow = text(body.requestedWindow, 80);
  const note = text(body.note);
  if (!issueType || !note || (action === "reschedule" && validatePickupSlot(requestedDate, requestedWindow))) {
    return { status: 400, body: { ok: false, error: "Complete the request details before submitting." } };
  }
  const seed = findSubmissionRecordById(orderId);
  if (!seed) return { status: 404, body: { ok: false, error: "This booking is no longer available." } };
  const db = operationalDatabase();
  const requestKeyHash = idempotencyKey ? createHash("sha256").update(idempotencyKey).digest("hex") : undefined;
  const payloadHash = createHash("sha256").update(JSON.stringify([action, requestedDate, requestedWindow, note])).digest("hex");
  return db.transaction((): Result => {
    if (idempotencyKey) {
      // Preserve receipts from older keyed clients without creating a new table.
      const legacyTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mobile_customer_requests'").get();
      const legacy = legacyTable ? db.prepare("SELECT payload_hash, receipt FROM mobile_customer_requests WHERE order_id = ? AND request_key = ?").get(orderId, idempotencyKey) as { payload_hash: string; receipt: string } | undefined : undefined;
      const prior = readSubmissionRecordsForOrder(orderId).find(record => record.data.submissionType === "support-ticket" && record.data.customerRequestKeyHash === requestKeyHash);
      if (legacy || prior) {
        const matches = (legacy?.payload_hash ?? prior?.data.customerRequestPayloadHash) === payloadHash;
        return matches
          ? { status: 200, body: { ...(legacy ? JSON.parse(legacy.receipt) : requestReceipt(prior!.id)), replayed: true } }
          : { status: 409, body: { ok: false, error: "This request changed. Start a new request before submitting different details." } };
      }
    }
    const createdAt = new Date().toISOString();
    const ticketId = `BWC-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    appendSubmissionRecord({ id: ticketId, createdAt, source: "bubblewash-customer-self-service", data: {
      submissionType: "support-ticket", ticketId, orderId,
      name: text(seed.data.name, 100) || "Customer", email: text(seed.data.email, 160), phone: text(seed.data.phone, 80),
      company: "Bubble Wash customer", issueType, ticketStatus: "Open — customer request", priority: action === "cancel" ? "High" : "Normal",
      customerAction: action, requestedDate, requestedWindow, message: note, submittedByRole: "customer",
      ...(requestKeyHash ? { customerRequestKeyHash: requestKeyHash, customerRequestPayloadHash: payloadHash } : {}),
    } });
    if (["quality", "damage", "refund"].includes(action)) db.prepare("INSERT INTO order_holds VALUES (?, ?, ?) ON CONFLICT(order_id) DO UPDATE SET reason = excluded.reason, updated_at = excluded.updated_at").run(orderId, issueType, createdAt);
    const receipt = requestReceipt(ticketId);
    return { status: 200, body: receipt };
  }).immediate();
}
