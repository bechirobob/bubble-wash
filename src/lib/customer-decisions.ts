import "server-only";
import { randomUUID } from "node:crypto";
import { operationalDatabase } from "./operational-store.ts";
import { appendSubmissionRecord, findSubmissionRecordById, readSubmissionRecordsForOrder } from "./data-store.ts";
import { appendSubmissionRecordAndReleaseOrderCapacity } from "./availability-store.ts";
import { buildOrderSummaries } from "./submissions.ts";
import { validatePickupSlot } from "./booking-policy.ts";
import { queueSubmissionNotifications } from "./notifications.ts";
import { invoiceForOrder, recordBillingEntry } from "./billing.ts";
export function decideCustomerRequest(ticketId: string, decision: "approve" | "decline", note: string, actor: string) {
  const db = operationalDatabase();
  return db.transaction(() => {
    const ticket = findSubmissionRecordById(ticketId);
    if (!ticket || ticket.data.submissionType !== "support-ticket" || !ticket.data.customerAction) throw new Error("Select a customer change request.");
    const prior = db.prepare("SELECT 1 FROM submissions WHERE json_extract(data, '$.ticketId') = ? AND json_extract(data, '$.decision') IN ('approve', 'decline')").get(ticketId);
    if (prior) throw new Error("This request has already been decided.");
    const orderId = String(ticket.data.orderId);
    const order = buildOrderSummaries(readSubmissionRecordsForOrder(orderId))[0];
    if (!order) throw new Error("Order unavailable.");
    const action = String(ticket.data.customerAction);
    const record = { id: `BW-${randomUUID()}`, createdAt: new Date().toISOString(), source: "customer-request-decision", data: { submissionType: "support-ticket-action", ticketId, orderId, decision, ticketStatus: decision === "approve" ? "Resolved" : "Closed", message: note, submittedByEmail: actor } as Record<string, unknown> };
    if (decision === "approve" && ["cancel", "reschedule"].includes(action)) {
      if (!["received", "pickup-scheduled", "vendor-assigned", "vendor-accepted", "driver-en-route"].includes(order.workflowStage.key)) throw new Error("Collection has progressed. Resolve return and billing arrangements before cancellation or rescheduling.");
      const change = { ...record, id: `BW-${randomUUID()}`, data: { orderId, submissionType: "admin-operation", actionType: action === "cancel" ? "Cancel order" : "Schedule pickup", orderStatus: action === "cancel" ? "Cancelled" : order.status, confirmedPickupDate: String(ticket.data.requestedDate || ""), routeWindow: String(ticket.data.requestedWindow || ""), pickupConfirmation: "confirmed", message: note, submittedByEmail: actor } };
      if (action === "reschedule") {
        const error = validatePickupSlot(change.data.confirmedPickupDate, change.data.routeWindow); if (error) throw new Error(error);
        appendSubmissionRecord(change);
      } else {
        const invoice = invoiceForOrder(orderId);
        if (invoice && invoice.balanceMinor > 0) recordBillingEntry(orderId, "credit", invoice.balanceMinor, `cancel:${ticketId}`, actor);
        appendSubmissionRecordAndReleaseOrderCapacity(change, orderId, order.vendorId, order.driverId);
      }
      queueSubmissionNotifications(change);
    }
    if (decision === "approve" && action === "refund" && !invoiceForOrder(orderId)?.entries.some((entry) => entry.kind === "refund")) throw new Error("Record the refund and its bank/provider reference in the invoice panel before closing this case.");
    appendSubmissionRecord(record);
    // Keep the retention hold until every dispute has an explicit decision.
    const unresolved = readSubmissionRecordsForOrder(orderId).filter((r) => ["quality", "damage", "refund"].includes(String(r.data.customerAction))).some((r) => !db.prepare("SELECT 1 FROM submissions WHERE json_extract(data, '$.ticketId') = ? AND json_extract(data, '$.decision') IN ('approve', 'decline')").get(r.id));
    if (!unresolved) db.prepare("DELETE FROM order_holds WHERE order_id = ?").run(orderId);
    return record.id;
  }).immediate();
}
