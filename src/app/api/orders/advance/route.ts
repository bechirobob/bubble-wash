import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { appendSubmissionRecord, claimWorkflowAction, releaseWorkflowActionClaim } from "@/lib/data-store";
import { assignOrderFromAvailability } from "@/lib/assignment";
import { recordVendorDecline, releaseAssignmentCapacity } from "@/lib/availability-store";
import { getCurrentStaffUser } from "@/lib/auth";
import { dispatchSubmissionNotifications, notificationSummary } from "@/lib/notifications";
import { automationActionsForOrder } from "@/lib/order-workflow";
import { buildOrderSummaries, orderBoardRecords, readSubmissions } from "@/lib/submissions";
import { staffWriteGuard } from "@/lib/security";

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: NextRequest) {
  const user = await getCurrentStaffUser();
  if (!user) return NextResponse.json({ ok: false, error: "Authentication required." }, { status: 401 });
  const staffGuardError = staffWriteGuard(request.headers);
  if (staffGuardError) return staffGuardError;

  let claimKey = "";
  let assignment: ReturnType<typeof assignOrderFromAvailability> | null = null;
  let recordSaved = false;
  try {
    const body = await request.json();
    const orderId = text(body.orderId);
    const actionKey = text(body.actionKey);
    if (!orderId || !actionKey) {
      return NextResponse.json({ ok: false, error: "Missing orderId or actionKey." }, { status: 400 });
    }

    const allRecords = await readSubmissions(500);
    const accessibleRecords = orderBoardRecords(allRecords, user.role);
    const order = buildOrderSummaries(accessibleRecords).find((item) => item.orderId.toLowerCase() === orderId.toLowerCase());
    if (!order) {
      return NextResponse.json({ ok: false, error: "Order is not available to this role." }, { status: 404 });
    }

    const actions = automationActionsForOrder(order, user.role, user.name);
    const selected = actions.find((action) => action.key === actionKey);
    if (!selected) {
      return NextResponse.json({ ok: false, error: "That automation is not allowed for the current order stage." }, { status: 400 });
    }

    claimKey = `${order.orderId}:${actionKey}:${order.updatedAt}`;
    if (!claimWorkflowAction({ claimKey, orderId: order.orderId, actionKey, orderUpdatedAt: order.updatedAt })) {
      return NextResponse.json({ ok: false, error: "That action was already processed. Refresh the order board." }, { status: 409 });
    }

    assignment = actionKey === "admin-assign-vendor" ? assignOrderFromAvailability({
      orderId: order.orderId,
      area: order.area,
      vendor: order.workflowStage.key === "exception" ? "Unassigned" : order.vendor,
      driver: order.driver,
    }) : null;
    if (actionKey === "vendor-decline-job") {
      recordVendorDecline({
        orderId: order.orderId,
        vendorId: order.vendorId || undefined,
        vendorName: order.vendor,
        reason: text(body.reason) || "Vendor declined assignment from shared order board.",
        declinedBy: user.name,
      });
    }
    const payload = assignment ? {
      ...selected.payload,
      vendorName: assignment.vendorName,
      driverName: assignment.driverName,
      vendorId: assignment.vendorId,
      driverId: assignment.driverId,
      message: `${selected.payload.message} ${assignment.assignmentNote}`,
    } : selected.payload;

    const record = {
      id: `BW-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`,
      createdAt: new Date().toISOString(),
      source: "bubblewash-workflow-automation",
      data: payload,
    };

    appendSubmissionRecord(record);
    recordSaved = true;
    const notifications = await dispatchSubmissionNotifications(record);
    return NextResponse.json({ ok: true, message: `${selected.label} saved. ${notificationSummary(notifications)}`, id: record.id, nextStatus: selected.nextStatus, notifications });
  } catch (error) {
    if (!recordSaved && assignment) {
      try {
        releaseAssignmentCapacity(assignment.vendorId, assignment.driverId);
      } catch (cleanupError) {
        console.error("Bubble Wash capacity rollback failed", {
          message: cleanupError instanceof Error ? cleanupError.message : "Unknown error",
          claimKey,
        });
      }
    }
    if (!recordSaved && claimKey) {
      try {
        releaseWorkflowActionClaim(claimKey);
      } catch (cleanupError) {
        console.error("Bubble Wash workflow claim rollback failed", {
          message: cleanupError instanceof Error ? cleanupError.message : "Unknown error",
          claimKey,
        });
      }
    }
    console.error("Bubble Wash order automation failed", {
      message: error instanceof Error ? error.message : "Unknown error",
      claimKey,
    });
    return NextResponse.json({ ok: false, error: "Unable to run automation." }, { status: 500 });
  }
}
