import { internalOrderForBookingReference } from "./booking-references.ts";
import "server-only";
import { randomUUID } from "node:crypto";
import { currentStaffUsers, type StaffRole } from "./auth.ts";
import { appendSubmissionRecord, findSubmissionRecordById, readSubmissionRecordsForOrder } from "./data-store.ts";
import { operationalDatabase } from "./operational-store.ts";
import { buildOrderSummaries, orderBoardRecords, orderMatchesStaffEntity, type OrderSummary, type SubmissionRecord } from "./submissions.ts";
import { listVendorAvailability } from "./availability-store.ts";
import { automationActionsForOrder } from "./order-workflow.ts";
import { assignmentCandidates } from "./assignment.ts";
import { invoiceForOrder } from "./billing.ts";
import { automationDatabase, automationHash, capacityFreshness, readOwnership } from "./automation-store.ts";

export type AutomationActor = { email: string; name: string; role: StaffRole; entityId?: string; allStaffAccess?: boolean };
export class AutomationError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const reject = (status: number, message: string): never => { throw new AutomationError(status, message); };
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const desk = (user: AutomationActor) => user.role === "admin" || user.role === "support";
type Signal = { id: string; kind: string; targetId: string; bookingReference?: string | null; title: string; detail: string; priority: "normal" | "high"; dueAt: string; signalVersion: string };
const signal = (kind: string, targetId: string, title: string, detail: string, dueAt: string, basis: unknown, priority: Signal["priority"] = "normal"): Signal => ({
  id: `${kind}:${targetId}`, kind, targetId, title, detail, priority, dueAt, signalVersion: automationHash([kind, targetId, basis]),
});
const terminal = (order: OrderSummary) => ["closed", "cancelled"].includes(order.workflowStage.key);

function accessibleOrder(user: AutomationActor, orderId: string) {
  orderId = internalOrderForBookingReference(operationalDatabase(), orderId) || orderId;
  const records = readSubmissionRecordsForOrder(orderId);
  return buildOrderSummaries(orderBoardRecords(records, user.role, user.entityId, true)).find((order) => order.orderId.toLowerCase() === orderId.toLowerCase() && orderMatchesStaffEntity(order, user.role, user.entityId, true));
}

function orderSignals(order: OrderSummary, user: AutomationActor, now: number): Signal[] {
  if (terminal(order)) return [];
  const result: Signal[] = [];
  const stage = order.workflowStage;
  const deadline = Date.parse(order.updatedAt) + stage.targetMinutes * 60_000;
  if (stage.targetMinutes > 0 && Number.isFinite(deadline) && deadline <= now) {
    result.push(signal(`order-overdue-${stage.key}`, order.orderId, `${stage.label} needs follow-up`, "Review the current order and record the next verified action. This reminder does not change the order.", new Date(deadline).toISOString(), [stage.key, order.updatedAt], "high"));
  }
  if (stage.key === "exception") result.push(signal("order-exception", order.orderId, "Order needs attention", "Check the problem and agree the next step.", order.updatedAt, [order.status, order.updatedAt], "high"));
  if (user.role === "admin" && ["pickup-scheduled", "vendor-assigned"].includes(stage.key) && (!order.vendorId || !order.driverId)) {
    result.push(signal("order-unassigned", order.orderId, "Assign the vendor and rider", "Check service areas and available slots. Suggestions do not reserve a slot or assign anyone.", order.updatedAt, [order.vendorId, order.driverId, order.updatedAt], "high"));
  }
  if (desk(user)) {
    const contactRow = operationalDatabase().prepare("SELECT id,created_at,data FROM submissions WHERE json_extract(data,'$.orderId')=? COLLATE NOCASE AND json_extract(data,'$.submissionType')='support-ticket-action' AND coalesce(json_extract(data,'$.ticketId'),'')='' AND coalesce(json_extract(data,'$.contactChannel'),'')<>'' AND coalesce(json_extract(data,'$.contactOutcome'),'')<>'' AND coalesce(json_extract(data,'$.nextFollowUpAt'),'')<>'' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(order.orderId) as { id: string; created_at: string; data: string } | undefined;
    const contact = contactRow ? { id: contactRow.id, createdAt: contactRow.created_at, data: JSON.parse(contactRow.data) as Record<string, unknown> } : undefined;
    if (contact) {
      const followup = text(contact.data.nextFollowUpAt);
      const precise = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(followup) && Number.isFinite(Date.parse(followup));
      result.push(signal("contact-followup", order.orderId, "Customer contact follow-up", precise ? "Review the latest contact log, then record any new contact through the existing order action." : "The contact log deadline has no reliable timezone. Set an explicit follow-up deadline here.", precise ? new Date(Date.parse(followup)).toISOString() : "", [contact.id, contact.createdAt, followup]));
    }
  }
  return result.map((item) => ({ ...item, bookingReference: order.bookingReference ?? null }));
}

function caseHistory(root: SubmissionRecord): SubmissionRecord[] {
  const db = operationalDatabase();
  const ticketId = text(root.data.ticketId) || root.id;
  const rows = db.prepare(`SELECT id, data, created_at, source FROM submissions WHERE json_extract(data,'$.submissionType')='support-ticket-action'
    AND (json_extract(data,'$.ticketId') IN (?,?) OR (coalesce(json_extract(data,'$.ticketId'),'')='' AND json_extract(data,'$.orderId')=?)) ORDER BY created_at DESC,rowid DESC`).all(ticketId, root.id, root.id) as { id: string; data: string; created_at: string; source?: string }[];
  return rows.map((row) => ({ id: row.id, data: JSON.parse(row.data) as Record<string, unknown>, createdAt: row.created_at, source: row.source }));
}

export function automationCaseRecords(user: AutomationActor, caseId: string) {
  if (!desk(user)) reject(403, "Admin or support access required.");
  if (!caseId || caseId.length > 220) reject(400, "Choose a case reference.");
  let root = findSubmissionRecordById(caseId);
  if (!root) {
    const matches = operationalDatabase().prepare("SELECT id FROM submissions WHERE json_extract(data,'$.submissionType')='support-ticket' AND json_extract(data,'$.ticketId')=? COLLATE NOCASE LIMIT 2").all(caseId) as { id: string }[];
    if (matches.length > 1) reject(409, "This case reference is ambiguous. Open the case from the worklist.");
    if (matches[0]) root = findSubmissionRecordById(matches[0].id);
  }
  if (!root || root.data.submissionType !== "support-ticket") reject(404, "Case unavailable.");
  return [root!, ...caseHistory(root!)];
}

function caseSignal(root: SubmissionRecord, now: number): Signal | null {
  const history = caseHistory(root);
  const events = [...history, root];
  const latest = (key: string, fallback = "") => events.map((event) => text(event.data[key])).find(Boolean) || fallback;
  const status = latest("ticketStatus", "Open");
  if (["Resolved", "Closed"].includes(status)) return null;
  const followup = latest("nextFollowUpAt");
  // Old browser datetime-local values have no timezone. Never silently interpret them in the server's zone.
  const precise = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(followup) && Number.isFinite(Date.parse(followup));
  const dueAt = precise ? new Date(Date.parse(followup)).toISOString() : "";
  const overdue = dueAt && Date.parse(dueAt) <= now;
  return signal("case-followup", root.id, overdue ? "Customer follow-up overdue" : "Case needs someone to take the next step",
    followup && !precise ? "The recorded follow-up has no reliable timezone. Set an explicit deadline before relying on a reminder." : `Current status: ${status}. Review the case before contacting the customer.`,
    dueAt, [history[0]?.id || root.id, history.length, history[0]?.createdAt || root.createdAt, status, followup], overdue || latest("priority") === "Urgent" ? "high" : "normal");
}

function vendorSignal(vendorId: string, now: number): Signal | null {
  const vendor = listVendorAvailability().find((entry) => entry.vendorId.toLowerCase() === vendorId.toLowerCase());
  if (!vendor || !["available", "limited", "active"].includes(vendor.availabilityStatus.toLowerCase())) return null;
  const freshness = capacityFreshness(vendor.vendorId, now);
  if (freshness.fresh) return null;
  const name = vendor.vendorName.trim();
  const title = name && name.toLowerCase() !== vendor.vendorId.toLowerCase() ? `Confirm capacity for ${name}` : "Confirm current vendor capacity";
  return signal("vendor-capacity", vendor.vendorId, title, "Ask the vendor to confirm their available slots. Assigning or completing an order does not confirm current availability.", "", [freshness.confirmedAt, vendor.availabilityStatus]);
}

function projectSignal(item: Signal, user: AutomationActor, now: number) {
  if (!desk(user)) return { ...item, canManage: false, ownerEmail: "", note: "", revision: 0, updatedAt: "", overdue: Boolean(item.dueAt && Date.parse(item.dueAt) <= now) };
  const ownership = readOwnership(item.id);
  const dueAt = ownership.dueAt || item.dueAt;
  const ownerActive = !ownership.ownerEmail || currentStaffUsers().some((person) => person.email.toLowerCase() === ownership.ownerEmail && ["admin", "support"].includes(person.role));
  return { ...item, ...ownership, dueAt, operationalDueAt: item.dueAt, ownerActive, canManage: user.role === "admin" || !ownership.ownerEmail || ownership.ownerEmail === user.email.toLowerCase(), overdue: Boolean(item.dueAt && Date.parse(item.dueAt) <= now || dueAt && Date.parse(dueAt) <= now) };
}

function findSignal(user: AutomationActor, itemId: string, now: number): Signal | null {
  const separator = itemId.indexOf(":");
  const kind = itemId.slice(0, separator), target = itemId.slice(separator + 1);
  if (separator < 1 || !target) return null;
  if (kind === "vendor-capacity") {
    if (user.role !== "admin" && !(user.role === "vendor" && target.toLowerCase() === user.entityId?.toLowerCase())) return null;
    return vendorSignal(target, now);
  }
  if (kind === "case-followup") {
    if (!desk(user)) return null;
    const root = findSubmissionRecordById(target);
    return root?.data.submissionType === "support-ticket" ? caseSignal(root, now) : null;
  }
  const order = accessibleOrder(user, target);
  return order ? orderSignals(order, user, now).find((item) => item.id === itemId) || null : null;
}

export function automationWorklist(user: AutomationActor, params: URLSearchParams, now = Date.now()) {
  if ((user.role === "vendor" || user.role === "driver") && !user.entityId) reject(403, "A bound staff identity is required.");
  const start = Math.max(0, Math.min(1_000_000, Math.floor(Number(params.get("offset")) || 0)));
  const itemId = text(params.get("itemId"));
  if (itemId) {
    const item = findSignal(user, itemId, now);
    return { ok: true, items: item ? [projectSignal(item, user, now)] : [], nextOffset: null, generatedAt: new Date(now).toISOString(), scope: "Current item" };
  }
  // Page root records, then load complete histories. Sparse role pages still return the next offset.
  const rows = operationalDatabase().prepare(`SELECT id FROM submissions WHERE
    (json_extract(data,'$.submissionType') IN ('pickup-booking','checkout-request') AND coalesce(json_extract(data,'$.orderId'),'')='')
    OR (?=1 AND json_extract(data,'$.submissionType')='support-ticket')
    ORDER BY created_at DESC,id DESC LIMIT 101 OFFSET ?`).all(desk(user) ? 1 : 0, start) as { id: string }[];
  const signals = rows.slice(0, 100).flatMap(({ id }) => {
    const root = findSubmissionRecordById(id)!;
    if (root.data.submissionType === "support-ticket") { const item = caseSignal(root, now); return item ? [item] : []; }
    const order = accessibleOrder(user, id);
    return order ? orderSignals(order, user, now) : [];
  });
  if (start === 0 && ["admin", "vendor"].includes(user.role)) {
    for (const vendor of listVendorAvailability()) {
      if (user.role === "vendor" && vendor.vendorId.toLowerCase() !== user.entityId?.toLowerCase()) continue;
      const item = vendorSignal(vendor.vendorId, now); if (item) signals.push(item);
    }
  }
  const filter = params.get("filter") || "all";
  if (!["all", "action", "mine", "unassigned", "overdue", "followups"].includes(filter)) reject(400, "Choose a supported worklist filter.");
  const items = signals.map((item) => projectSignal(item, user, now)).filter((item) => filter === "all" || filter === "action" && (item.overdue || item.priority === "high" || !item.ownerEmail) || filter === "mine" && item.ownerEmail === user.email.toLowerCase() || filter === "unassigned" && !item.ownerEmail || filter === "overdue" && item.overdue || filter === "followups" && ["case-followup", "contact-followup"].includes(item.kind))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || Number(b.priority === "high") - Number(a.priority === "high") || a.id.localeCompare(b.id));
  return { ok: true, items, nextOffset: rows.length > 100 ? start + 100 : null, generatedAt: new Date(now).toISOString(), scope: "These are the loaded records. Use Older records to check earlier work" };
}

export function manageWorkOwnership(user: AutomationActor, body: Record<string, unknown>, now = Date.now()) {
  if (!desk(user)) reject(403, "Only admin and support may manage follow-up ownership.");
  const allowed = ["itemId", "ownerEmail", "dueAt", "note", "expectedRevision", "signalVersion", "idempotencyKey"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) reject(400, "Unsupported ownership field.");
  const itemId = text(body.itemId), ownerEmail = text(body.ownerEmail).toLowerCase(), note = text(body.note), due = text(body.dueAt), key = text(body.idempotencyKey);
  if (!itemId || itemId.length > 220 || typeof body.ownerEmail !== "string" || !note || note.length > 600 || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0 || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) reject(400, "Enter the current item, revision, a note and a unique command key.");
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(due) || !Number.isFinite(Date.parse(due))) reject(400, "Choose an explicit timezone deadline within the next 30 days.");
  const db = automationDatabase(), scope = automationHash([user.email.toLowerCase(), user.role, itemId]);
  const payload = automationHash(Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b))));
  return db.transaction(() => {
    const prior = db.prepare("SELECT payload_hash, response FROM operational_command_receipts WHERE scope=? AND request_key=?").get(scope, key) as { payload_hash: string; response: string } | undefined;
    if (prior) { if (prior.payload_hash !== payload) reject(409, "This command key was already used for different details."); return { ...JSON.parse(prior.response), replayed: true }; }
    const item = findSignal(user, itemId, now);
    if (!item) reject(409, "This exception is no longer active or accessible. Refresh the worklist.");
    if (item!.id !== itemId) reject(400, "Use the exact item reference from the current worklist.");
    if (ownerEmail && !currentStaffUsers().some((person) => person.email.toLowerCase() === ownerEmail && ["admin", "support"].includes(person.role))) reject(400, "Choose an active admin or support account.");
    if (Date.parse(due) < now - 60_000 || Date.parse(due) > now + 30 * 86400_000) reject(400, "Choose an explicit timezone deadline within the next 30 days.");
    const current = readOwnership(itemId);
    if (body.expectedRevision !== current.revision || body.signalVersion !== item!.signalVersion) reject(409, "This work item changed. Refresh before saving.");
    if (user.role === "support" && (ownerEmail && ownerEmail !== user.email.toLowerCase() || current.ownerEmail && current.ownerEmail !== user.email.toLowerCase())) reject(403, "Support may claim unowned work or update its own items. Ask admin to reassign another owner.");
    const updatedAt = new Date(now).toISOString(), revision = current.revision + 1;
    const orderId = item!.kind === "vendor-capacity" ? "" : item!.kind === "case-followup" ? text(findSubmissionRecordById(item!.targetId)?.data.orderId) : item!.targetId;
    db.prepare(`INSERT INTO operational_work_ownership (item_id,owner_email,due_at,note,revision,updated_at,order_id) VALUES (?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET owner_email=excluded.owner_email,due_at=excluded.due_at,note=excluded.note,revision=excluded.revision,updated_at=excluded.updated_at,order_id=excluded.order_id`).run(itemId, ownerEmail, new Date(Date.parse(due)).toISOString(), note, revision, updatedAt, orderId);
    const id = `BW-${randomUUID()}`;
    appendSubmissionRecord({ id, createdAt: updatedAt, source: "browser-operations-work-ownership", data: { submissionType: "operations-work-action", itemId, ...(orderId ? { orderId } : {}), actionType: "Set work owner and deadline", ownerEmail, dueAt: due, message: note, submittedByEmail: user.email, submittedByName: user.name, submittedByRole: user.role } });
    const response = { ok: true, id, revision, message: "Owner and follow-up deadline saved. The underlying order or case has not changed." };
    db.prepare("INSERT INTO operational_command_receipts VALUES (?,?,?,?,?)").run(scope, key, payload, JSON.stringify(response), updatedAt);
    return response;
  }).immediate();
}

export function dispatchRecommendations(user: AutomationActor, orderId: string, now = Date.now()) {
  if (user.role !== "admin") reject(403, "Dispatch recommendations require admin access.");
  const order = accessibleOrder(user, orderId);
  if (!order) reject(404, "Order unavailable.");
  const candidates = assignmentCandidates({ ...order!, serviceType: order!.serviceType });
  const vendors = candidates.vendors.map((vendor) => {
    const freshness = capacityFreshness(vendor.vendorId, now);
    return { ...vendor, freshness, recommended: vendor.eligible && freshness.fresh, reasons: [...vendor.reasons, ...(!freshness.fresh ? ["Vendor must reconfirm capacity"] : [])] };
  }).sort((a, b) => Number(b.recommended) - Number(a.recommended) || Number(b.eligible) - Number(a.eligible) || b.capacityRemaining - a.capacityRemaining || a.name.localeCompare(b.name));
  const drivers = candidates.drivers.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.capacityRemaining - a.capacityRemaining || a.name.localeCompare(b.name));
  return { ok: true, orderId: order!.orderId, bookingReference: order!.bookingReference ?? null, orderRevision: order!.activityUpdatedAt, vendors, drivers, assignmentAvailable: automationActionsForOrder(order!, user.role, user.name, user.allStaffAccess).some((action) => action.key === "admin-assign-vendor"),
    policy: "Suggestions use service areas, services, availability, and remaining slots. They do not find the fastest route or reserve a slot. The assignment action may select a different available person or vendor. Check before confirming.", generatedAt: new Date(now).toISOString() };
}

export function reconciliationWorklist(user: AutomationActor, start = 0) {
  if (user.role !== "admin") reject(403, "Reconciliation work requires admin access.");
  const offset = Math.max(0, Math.min(1_000_000, Math.floor(start) || 0));
  const rows = operationalDatabase().prepare(`SELECT id FROM submissions WHERE json_extract(data,'$.submissionType') IN ('pickup-booking','checkout-request') AND coalesce(json_extract(data,'$.orderId'),'')='' ORDER BY created_at DESC,id DESC LIMIT 101 OFFSET ?`).all(offset) as { id: string }[];
  const items = rows.slice(0, 100).flatMap(({ id }) => {
    const order = accessibleOrder(user, id); if (!order) return [];
    const invoice = invoiceForOrder(id);
    const reasons: string[] = [];
    if (!invoice && (order.timeline.some((event) => event.type === "qr-bag-intake") || ["washing", "ready", "out-for-delivery", "delivered", "closed"].includes(order.workflowStage.key))) reasons.push("Invoice missing after laundry check-in");
    if (invoice && invoice.balanceMinor > 0 && ["delivered", "closed"].includes(order.workflowStage.key)) reasons.push(order.payment === "Invoice approved" ? "Approved invoice has an unpaid balance" : "Delivered order has an outstanding balance");
    if (invoice && invoice.balanceMinor < 0) reasons.push("Overpayment or credit needs checking");
    const refundCase = readSubmissionRecordsForOrder(id).some((record) => record.data.submissionType === "support-ticket" && record.data.customerAction === "refund" && !operationalDatabase().prepare("SELECT 1 FROM submissions WHERE json_extract(data,'$.submissionType')='support-ticket-action' AND json_extract(data,'$.ticketId') IN (?,?) AND json_extract(data,'$.decision') IN ('approve','decline')").get(record.id, text(record.data.ticketId) || record.id));
    if (refundCase) reasons.push(invoice?.entries.some((entry) => entry.kind === "refund") ? "A refund is recorded, but the support case is still open" : "Review the refund request. No completed refund is recorded");
    return reasons.length ? [{ orderId: id, bookingReference: order.bookingReference ?? null, invoiceId: invoice?.invoiceId || "", balanceMinor: invoice?.balanceMinor ?? null, currency: "GHS", reasons, financialActionAvailable: false }] : [];
  });
  return { ok: true, items, nextOffset: rows.length > 100 ? offset + 100 : null, scope: "Read-only review. No payment, refund, credit or order-close action is performed." };
}
