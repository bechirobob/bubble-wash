import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { appendSubmissionRecord } from "@/lib/data-store";
import { assignOrderFromAvailability } from "@/lib/assignment";
import { recordVendorDecline } from "@/lib/availability-store";
import { getCurrentStaffUser } from "@/lib/auth";
import { dispatchSubmissionNotifications, notificationSummary } from "@/lib/notifications";
import { automationActionsForOrder } from "@/lib/order-workflow";
import { buildOrderSummaries, orderBoardRecords, readSubmissions } from "@/lib/submissions";

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: NextRequest) {
  const user = await getCurrentStaffUser();
  if (!user) return NextResponse.json({ ok: false, error: "Authentication required." }, { status: 401 });

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

    const assignment = actionKey === "admin-assign-vendor" ? assignOrderFromAvailability({
      orderId: order.orderId,
      area: order.area,
      serviceType: order.lastEventType,
      vendor: order.vendor,
      driver: order.driver,
    }) : null;
    if (actionKey === "vendor-decline-job") {
      recordVendorDecline({
        orderId: order.orderId,
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
    const notifications = await dispatchSubmissionNotifications(record);
    return NextResponse.json({ ok: true, message: `${selected.label} saved. ${notificationSummary(notifications)}`, id: record.id, nextStatus: selected.nextStatus, notifications });
  } catch {
    return NextResponse.json({ ok: false, error: "Unable to run automation." }, { status: 500 });
  }
}
