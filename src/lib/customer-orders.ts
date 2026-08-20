import "server-only";

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
    customer: order.customer.split(/\s+/)[0] || "Customer",
    createdAt: order.createdAt,
    updatedAt: order.activityUpdatedAt,
    status: order.status,
    nextStep: order.nextStep,
    area: order.area,
    pickupAddress: order.pickupAddress,
    plan: order.plan,
    service: order.service,
    pickupDate: text(seed?.data.pickupDate),
    pickupWindow: text(seed?.data.pickupWindow),
    timeline: order.timeline.map((event) => ({
      createdAt: event.createdAt,
      status: event.status,
      type: event.type,
    })),
  };
}
