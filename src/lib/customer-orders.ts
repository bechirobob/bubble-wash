import "server-only";
import { invoiceForOrder } from "@/lib/billing";
import { workflowStageFromStatus } from "@/lib/order-workflow";

import type { OrderSummary, SubmissionRecord } from "@/lib/submissions";

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function customerOrderView(order: OrderSummary, records: SubmissionRecord[]) {
  const seed = [...records]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .find((record) => ["pickup-booking", "checkout-request"].includes(text(record.data.submissionType)));
  return {
    orderId: order.orderId,
    invoice: invoiceForOrder(order.orderId),
    customer: order.customer.split(/\s+/)[0] || "Customer",
    createdAt: order.createdAt,
    updatedAt: order.activityUpdatedAt,
    status: order.status,
    nextStep: workflowStageFromStatus(order.status, order.lastEventType).customerNext,
    area: order.area,
    pickupAddress: order.pickupAddress,
    plan: order.plan,
    service: order.service,
    pickupDate: text([...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find((record) => text(record.data.confirmedPickupDate))?.data.confirmedPickupDate) || text(seed?.data.pickupDate),
    pickupWindow: order.dispatch.scheduledWindow || text(seed?.data.pickupWindow),
    timeline: order.timeline.map((event) => ({
      createdAt: event.createdAt,
      status: event.status,
      type: event.type,
    })),
  };
}
