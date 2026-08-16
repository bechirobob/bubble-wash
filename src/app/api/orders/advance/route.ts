import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { appendSubmissionRecord, appendSubmissionRecordWithDeliveryProof, claimWorkflowAction, deliveryCodeRecord, releaseWorkflowActionClaim } from "@/lib/data-store";
import { assignOrderFromAvailability } from "@/lib/assignment";
import { appendSubmissionRecordAndReleaseOrderCapacity, recordVendorDecline, releaseAssignmentCapacity } from "@/lib/availability-store";
import { getCurrentStaffUser } from "@/lib/auth";
import { dispatchSubmissionNotifications, notificationSummary } from "@/lib/notifications";
import { automationActionsForOrder, isValidDriverEtaAt } from "@/lib/order-workflow";
import { buildOrderSummaries, orderBoardRecords, orderMatchesStaffEntity, readSubmissionsForOrder } from "@/lib/submissions";
import { staffWriteGuard } from "@/lib/security";
import { deliveryCodeHash } from "@/lib/chain-of-custody";

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function validEvidenceCount(value: string) {
  if (!/^\d+$/.test(value)) return false;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 1 && count <= 10000;
}

export async function POST(request: NextRequest) {
  const user = await getCurrentStaffUser();
  if (!user) return NextResponse.json({ ok: false, error: "Authentication required." }, { status: 401 });
  const staffGuardError = staffWriteGuard(request.headers);
  if (staffGuardError) return staffGuardError;

  let claimKey = "";
  let assignment: Awaited<ReturnType<typeof assignOrderFromAvailability>> | null = null;
  let recordSaved = false;
  try {
    const body = await request.json<Record<string, unknown>>();
    const orderId = text(body.orderId);
    const actionKey = text(body.actionKey);
    if (!orderId || !actionKey) {
      return NextResponse.json({ ok: false, error: "Missing orderId or actionKey." }, { status: 400 });
    }

    const orderRecords = await readSubmissionsForOrder(orderId);
    const accessibleRecords = orderBoardRecords(orderRecords, user.role, user.entityId);
    const order = buildOrderSummaries(accessibleRecords).find((item) => (
      item.orderId.toLowerCase() === orderId.toLowerCase()
      && orderMatchesStaffEntity(item, user.role, user.entityId)
    ));
    if (!order) {
      return NextResponse.json({ ok: false, error: "Order is not available to this role." }, { status: 404 });
    }

    const actions = automationActionsForOrder(order, user.role, user.name);
    const selected = actions.find((action) => action.key === actionKey);
    if (!selected) {
      return NextResponse.json({ ok: false, error: "That action is not allowed for the current order stage." }, { status: 400 });
    }

    const rawOperatorNote = text(body.operatorNote);
    const operatorNote = rawOperatorNote.slice(0, 600);
    const confirmedPickupWindow = text(body.confirmedPickupWindow).slice(0, 120);
    const contactChannel = text(body.contactChannel).slice(0, 80);
    const contactOutcome = text(body.contactOutcome).slice(0, 160);
    const nextFollowUpAt = text(body.nextFollowUpAt).slice(0, 80);
    const paymentReference = text(body.paymentReference).slice(0, 120);
    const paymentAmount = text(body.paymentAmount).replace(/[^\d.]/g, "");
    const paymentReceivedAt = text(body.paymentReceivedAt).slice(0, 40);
    const bagTag = text(body.bagTag).slice(0, 120);
    const intakeBagCount = text(body.intakeBagCount).slice(0, 40);
    const receivedWeightKg = text(body.receivedWeightKg).replace(/[^\d.]/g, "");
    const intakeCondition = text(body.intakeCondition).slice(0, 160);
    const readyBagCount = text(body.readyBagCount).slice(0, 40);
    const qualityCheck = text(body.qualityCheck).slice(0, 200);
    const pickupBagCount = text(body.pickupBagCount).slice(0, 40);
    const vendorRecipient = text(body.vendorRecipient).slice(0, 160);
    const handoffBagCount = text(body.handoffBagCount).slice(0, 40);
    const recipientName = text(body.recipientName).slice(0, 160);
    const bagCount = text(body.bagCount).slice(0, 40);
    const deliveryCode = text(body.deliveryCode).slice(0, 6);
    const revisedEta = text(body.revisedEta).slice(0, 80);
    const driverEtaAt = text(body.driverEtaAt);
    const rawRouteCheckpoint = text(body.routeCheckpoint);
    const routeCheckpoint = rawRouteCheckpoint.slice(0, 240);

    if (actionKey === "admin-schedule-pickup" && (!confirmedPickupWindow || !operatorNote)) {
      return NextResponse.json({ ok: false, error: "Record the confirmed pickup window and scheduling note." }, { status: 400 });
    }
    if (actionKey === "support-log-customer-contact" && (!contactChannel || !contactOutcome || !nextFollowUpAt || !operatorNote)) {
      return NextResponse.json({ ok: false, error: "Record the contact channel, outcome, next follow-up time, and operator note." }, { status: 400 });
    }
    if (["admin-confirm-bank-transfer", "admin-approve-invoice"].includes(actionKey)) {
      const amount = Number(paymentAmount);
      if (!paymentReference || !paymentReceivedAt || !operatorNote || !Number.isFinite(amount) || amount <= 0 || amount > 250000) {
        return NextResponse.json({ ok: false, error: "Record a valid amount, reference, received/approved date, and reconciliation note." }, { status: 400 });
      }
    }
    if (actionKey === "vendor-log-intake") {
      const weight = receivedWeightKg ? Number(receivedWeightKg) : 0;
      if (!bagTag || !validEvidenceCount(intakeBagCount) || !intakeCondition || !operatorNote || (receivedWeightKg && (!Number.isFinite(weight) || weight <= 0 || weight > 10000))) {
        return NextResponse.json({ ok: false, error: "Record the bag tag, bag/item count, intake condition, note, and a valid received weight if supplied." }, { status: 400 });
      }
    }
    if (actionKey === "vendor-mark-ready" && (!validEvidenceCount(readyBagCount) || !qualityCheck || !operatorNote)) {
      return NextResponse.json({ ok: false, error: "Record the ready bag/item count, quality check, and dispatch note." }, { status: 400 });
    }
    if (actionKey === "driver-mark-picked-up" && (!validEvidenceCount(pickupBagCount) || !operatorNote)) {
      return NextResponse.json({ ok: false, error: "Record the collected bag/item count and customer handoff note." }, { status: 400 });
    }
    if (actionKey === "driver-drop-at-vendor" && (!vendorRecipient || !validEvidenceCount(handoffBagCount) || !operatorNote)) {
      return NextResponse.json({ ok: false, error: "Record the vendor recipient, handed-over bag/item count, and handoff note." }, { status: 400 });
    }
    if (actionKey === "driver-mark-delivered" && (!recipientName || !validEvidenceCount(bagCount) || !operatorNote || !/^\d{6}$/.test(deliveryCode))) {
      return NextResponse.json({ ok: false, error: "Record the recipient, returned bag count, six-digit customer handoff code, and handoff note before delivery." }, { status: 400 });
    }
    if (actionKey === "driver-mark-delivered") {
      const proof = await deliveryCodeRecord(order.orderId);
      if (!proof || proof.usedAt) return NextResponse.json({ ok: false, error: "A valid unused delivery confirmation code is not available for this order." }, { status: 409 });
    }
    if (actionKey === "driver-report-delay" && (!revisedEta || !routeCheckpoint || !operatorNote)) {
      return NextResponse.json({ ok: false, error: "Record the revised ETA, current checkpoint, and delay reason." }, { status: 400 });
    }
    if (actionKey === "driver-update-eta" && (!isValidDriverEtaAt(driverEtaAt) || !routeCheckpoint || rawRouteCheckpoint.length > 240 || rawOperatorNote.length > 240)) {
      return NextResponse.json({ ok: false, error: "Record ETA as HH:MM, a current checkpoint up to 240 characters, and an optional note up to 240 characters." }, { status: 400 });
    }

    const changesFulfillment = actionKey !== "driver-update-eta"
      && ["admin-operation", "vendor-job-update", "qr-bag-intake", "driver-route-log"].includes(selected.submissionType);
    const version = changesFulfillment ? order.updatedAt : order.activityUpdatedAt;
    claimKey = changesFulfillment ? `${order.orderId}:fulfillment:${version}` : `${order.orderId}:${actionKey}:${version}`;
    if (!await claimWorkflowAction({ claimKey, orderId: order.orderId, actionKey, orderUpdatedAt: version })) {
      return NextResponse.json({ ok: false, error: "That action was already processed. Refresh the order board." }, { status: 409 });
    }

    assignment = actionKey === "admin-assign-vendor" ? await assignOrderFromAvailability({
      orderId: order.orderId,
      area: order.area,
      serviceType: order.serviceType,
      vendor: order.workflowStage.key === "exception" ? "Unassigned" : order.vendor,
      driver: order.driver,
    }) : null;
    if (actionKey === "vendor-decline-job") {
      await recordVendorDecline({
        orderId: order.orderId,
        vendorId: order.vendorId || undefined,
        vendorName: order.vendor,
        reason: text(body.reason) || "Vendor declined assignment from shared order board.",
        declinedBy: user.name,
      });
    }
    const basePayload: Record<string, string> = assignment ? {
      ...selected.payload,
      vendorName: assignment.vendorName,
      driverName: assignment.driverName,
      ...(assignment.vendorId ? { vendorId: assignment.vendorId } : {}),
      ...(assignment.driverId ? { driverId: assignment.driverId } : {}),
      message: `${selected.payload.message} ${assignment.assignmentNote}`,
    } : {
      ...selected.payload,
      ...(order.vendorId ? { vendorId: order.vendorId } : {}),
      ...(order.driverId ? { driverId: order.driverId } : {}),
    };
    const payload = actionKey === "admin-schedule-pickup" ? {
      ...basePayload,
      routeWindow: confirmedPickupWindow,
      scheduleNote: operatorNote,
      message: `${basePayload.message} Confirmed window: ${confirmedPickupWindow}. Scheduling note: ${operatorNote}`,
    } : actionKey === "support-log-customer-contact" ? {
      ...basePayload,
      contactChannel,
      contactOutcome,
      nextFollowUpAt,
      message: `${basePayload.message} Channel: ${contactChannel}. Outcome: ${contactOutcome}. Follow-up: ${nextFollowUpAt}. Operator note: ${operatorNote}`,
    } : ["admin-confirm-bank-transfer", "admin-approve-invoice"].includes(actionKey) ? {
      ...basePayload,
      paymentReference,
      paymentAmount: `GHS ${Number(paymentAmount).toFixed(2)}`,
      paymentReceivedAt,
      reconciliationNote: operatorNote,
      message: `${basePayload.message} Reference: ${paymentReference}. Amount: GHS ${Number(paymentAmount).toFixed(2)}. Date: ${paymentReceivedAt}. Reconciliation: ${operatorNote}`,
    } : actionKey === "vendor-log-intake" ? {
      ...basePayload,
      qrTag: bagTag,
      bagCount: intakeBagCount,
      receivedWeightKg: receivedWeightKg ? `${Number(receivedWeightKg).toFixed(2)} kg` : "Not recorded",
      itemCondition: intakeCondition,
      intakeNote: operatorNote,
      message: `${basePayload.message} Bag tag: ${bagTag}. Count: ${intakeBagCount}. Received weight: ${receivedWeightKg ? `${Number(receivedWeightKg).toFixed(2)} kg` : "not recorded"}. Condition: ${intakeCondition}. Note: ${operatorNote}`,
    } : actionKey === "vendor-mark-ready" ? {
      ...basePayload,
      bagCount: readyBagCount,
      qualityCheck,
      dispatchNote: operatorNote,
      message: `${basePayload.message} Ready count: ${readyBagCount}. Quality check: ${qualityCheck}. Dispatch note: ${operatorNote}`,
    } : actionKey === "driver-mark-picked-up" ? {
      ...basePayload,
      bagCount: pickupBagCount,
      handoffNote: operatorNote,
      message: `${basePayload.message} Collected count: ${pickupBagCount}. Customer handoff: ${operatorNote}`,
    } : actionKey === "driver-drop-at-vendor" ? {
      ...basePayload,
      recipientName: vendorRecipient,
      bagCount: handoffBagCount,
      handoffNote: operatorNote,
      message: `${basePayload.message} Vendor recipient: ${vendorRecipient}. Handed-over count: ${handoffBagCount}. Handoff: ${operatorNote}`,
    } : actionKey === "driver-mark-delivered" ? {
      ...basePayload,
      recipientName,
      bagCount,
      proofNote: operatorNote,
      message: `${basePayload.message} Recipient: ${recipientName}. Returned bags/items: ${bagCount}. Handoff: ${operatorNote}`,
    } : actionKey === "driver-update-eta" ? {
      ...basePayload,
      driverEtaAt,
      driverEta: driverEtaAt,
      etaSource: "rider-reported",
      routeCheckpoint,
      locationNote: routeCheckpoint,
      ...(operatorNote ? { operatorNote } : {}),
      message: `Rider ETA updated for ${order.orderId}. ETA: ${driverEtaAt}. Checkpoint: ${routeCheckpoint}.${operatorNote ? ` Note: ${operatorNote}` : ""}`,
    } : actionKey === "driver-report-delay" ? {
      ...basePayload,
      driverEta: revisedEta,
      locationNote: routeCheckpoint,
      delayReason: operatorNote,
      message: `${basePayload.message} Revised ETA: ${revisedEta}. Checkpoint: ${routeCheckpoint}. Reason: ${operatorNote}`,
    } : basePayload;

    const record = {
      id: `BW-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`,
      createdAt: new Date().toISOString(),
      source: "bubblewash-workflow-automation",
      data: payload,
    };

    if (actionKey === "driver-mark-delivered") {
      await appendSubmissionRecordWithDeliveryProof(record, { orderId: order.orderId, codeHash: deliveryCodeHash(order.orderId, deliveryCode), usedBy: user.email, recipientName });
    } else if (actionKey === "admin-close-order") {
      await appendSubmissionRecordAndReleaseOrderCapacity(record, order.orderId, order.vendorId || undefined, order.driverId || undefined);
    } else {
      await appendSubmissionRecord(record);
    }
    recordSaved = true;
    const notifications = await dispatchSubmissionNotifications(record);
    return NextResponse.json({ ok: true, message: `${selected.label} saved. ${notificationSummary(notifications)}`, id: record.id, nextStatus: selected.nextStatus, notifications });
  } catch (error) {
    if (!recordSaved && assignment) {
      try {
        await releaseAssignmentCapacity(assignment.reservationId, "workflow-rollback");
      } catch (cleanupError) {
        console.error("Bubble Wash capacity rollback failed", {
          message: cleanupError instanceof Error ? cleanupError.message : "Unknown error",
          claimKey,
        });
      }
    }
    if (!recordSaved && claimKey) {
      try {
        await releaseWorkflowActionClaim(claimKey);
      } catch (cleanupError) {
        console.error("Bubble Wash workflow claim rollback failed", {
          message: cleanupError instanceof Error ? cleanupError.message : "Unknown error",
          claimKey,
        });
      }
    }
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Bubble Wash order workflow action failed", {
      message: errorMessage,
      claimKey,
    });
    if (errorMessage.startsWith("No eligible ")) {
      return NextResponse.json({ ok: false, error: errorMessage }, { status: 409 });
    }
    if (errorMessage.startsWith("Delivery confirmation code")) {
      return NextResponse.json({ ok: false, error: errorMessage }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: "Unable to complete workflow action." }, { status: 500 });
  }
}
