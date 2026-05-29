export type WorkflowStageKey =
  | "received"
  | "pickup-scheduled"
  | "vendor-assigned"
  | "vendor-accepted"
  | "driver-en-route"
  | "picked-up"
  | "at-vendor"
  | "washing"
  | "ready"
  | "out-for-delivery"
  | "delivered"
  | "closed"
  | "exception";

export type WorkflowStage = {
  key: WorkflowStageKey;
  label: string;
  targetMinutes: number;
  customerNext: string;
  staffNext: string;
};

export type WorkflowRole = "admin" | "vendor" | "driver" | "support";

export type WorkflowOrderSnapshot = {
  orderId: string;
  customer: string;
  email: string;
  phone: string;
  area: string;
  vendor: string;
  driver: string;
  routeWindow: string;
  locationNote: string;
  status: string;
  payment: string;
  priority: string;
  lastEventType: string;
  stageTimer?: { tone: "ok" | "due" | "breached" | "paused"; label: string };
};

export type WorkflowAutomationAction = {
  key: string;
  label: string;
  description: string;
  submissionType: string;
  nextStatus: string;
  payload: Record<string, string>;
};

export const workflowStages: WorkflowStage[] = [
  { key: "received", label: "Received", targetMinutes: 20, customerNext: "We received the order and are confirming pickup.", staffNext: "Admin confirms pickup details, payment preference, route area, and customer notes." },
  { key: "pickup-scheduled", label: "Pickup Scheduled", targetMinutes: 60, customerNext: "Pickup window is scheduled.", staffNext: "Admin assigns a vendor and keeps the customer window attached to the order." },
  { key: "vendor-assigned", label: "Vendor Assigned", targetMinutes: 60, customerNext: "A laundry partner has been assigned.", staffNext: "Vendor accepts the job from the inherited order context." },
  { key: "vendor-accepted", label: "Vendor Accepted", targetMinutes: 90, customerNext: "The laundry partner accepted the job.", staffNext: "Driver picks up and hands bags to the assigned vendor." },
  { key: "driver-en-route", label: "Driver En Route", targetMinutes: 75, customerNext: "The driver is on the way.", staffNext: "Driver confirms pickup or records a delay before support has to chase." },
  { key: "picked-up", label: "Picked Up", targetMinutes: 45, customerNext: "Your laundry has been picked up.", staffNext: "Driver drops bags at vendor and logs bag count or exceptions." },
  { key: "at-vendor", label: "At Vendor", targetMinutes: 45, customerNext: "Your laundry is with the washing team.", staffNext: "Vendor confirms intake and starts the washing stage." },
  { key: "washing", label: "Washing", targetMinutes: 360, customerNext: "Your laundry is being washed and finished.", staffNext: "Vendor updates progress and flags stain, damage, or count exceptions early." },
  { key: "ready", label: "Ready", targetMinutes: 120, customerNext: "Your laundry is ready for return delivery.", staffNext: "Driver starts the return route and support watches any late orders." },
  { key: "out-for-delivery", label: "Out for Delivery", targetMinutes: 75, customerNext: "Your laundry is out for delivery.", staffNext: "Driver completes customer handoff and closes delivery notes." },
  { key: "delivered", label: "Delivered", targetMinutes: 30, customerNext: "Delivered. Thank you for using Bubble Wash.", staffNext: "Admin confirms payment/invoice and closes the order if no issue remains." },
  { key: "closed", label: "Closed", targetMinutes: 0, customerNext: "Order closed.", staffNext: "No action needed unless support reopens the order." },
  { key: "exception", label: "Needs Attention", targetMinutes: 30, customerNext: "The team is reviewing an update on this order.", staffNext: "Support/admin resolves the exception, then returns the order to the right stage." },
];

const stageByKey = new Map(workflowStages.map((stage) => [stage.key, stage]));

export function workflowStageFromStatus(status: string, lastEventType = "") {
  const normalized = `${status} ${lastEventType}`.toLowerCase();
  if (/closed|resolved/.test(normalized)) return stageByKey.get("closed")!;
  if (/delivered|completed/.test(normalized)) return stageByKey.get("delivered")!;
  if (/out for delivery|return route/.test(normalized)) return stageByKey.get("out-for-delivery")!;
  if (/ready|ready for driver|ready for delivery/.test(normalized)) return stageByKey.get("ready")!;
  if (/washing|ironing|finishing|wash started/.test(normalized)) return stageByKey.get("washing")!;
  if (/at vendor|dropped at vendor|vendor received|qr-bag|intake/.test(normalized)) return stageByKey.get("at-vendor")!;
  if (/picked up|collected/.test(normalized)) return stageByKey.get("picked-up")!;
  if (/driver en route/.test(normalized)) return stageByKey.get("driver-en-route")!;
  if (/accepted|vendor accepted/.test(normalized)) return stageByKey.get("vendor-accepted")!;
  if (/vendor assigned|assigned vendor/.test(normalized)) return stageByKey.get("vendor-assigned")!;
  if (/pickup scheduled|confirm pickup|scheduled/.test(normalized)) return stageByKey.get("pickup-scheduled")!;
  if (/delayed|issue|missing|quality|escalated|needs attention|waiting/.test(normalized)) return stageByKey.get("exception")!;
  return stageByKey.get("received")!;
}

export function minutesSince(value: string) {
  const started = new Date(value).getTime();
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.round((Date.now() - started) / 60_000));
}

export function stageTimerForWorkflow(status: string, updatedAt: string, lastEventType = "") {
  const stage = workflowStageFromStatus(status, lastEventType);
  const elapsedMinutes = minutesSince(updatedAt);
  if (stage.targetMinutes === 0) {
    return { label: stage.key === "closed" || stage.key === "delivered" ? "Timer complete" : "Timer paused", tone: "paused" as const, elapsedMinutes, targetMinutes: 0 };
  }
  const remaining = stage.targetMinutes - elapsedMinutes;
  if (remaining < 0) return { label: `Overdue by ${Math.abs(remaining)} min`, tone: "breached" as const, elapsedMinutes, targetMinutes: stage.targetMinutes };
  if (remaining <= 20) return { label: `Due in ${remaining} min`, tone: "due" as const, elapsedMinutes, targetMinutes: stage.targetMinutes };
  return { label: `Elapsed ${elapsedMinutes} min · SLA ${stage.targetMinutes} min`, tone: "ok" as const, elapsedMinutes, targetMinutes: stage.targetMinutes };
}

export function workflowNextStep(order: WorkflowOrderSnapshot) {
  const stage = workflowStageFromStatus(order.status, order.lastEventType);
  if (order.priority === "Urgent" || order.stageTimer?.tone === "breached") return "Support/admin should handle this as an exception before the customer has to chase.";
  if (stage.key === "vendor-assigned" && (!order.vendor || order.vendor === "Unassigned")) return "Admin should assign a vendor so the next role inherits the order context.";
  if (stage.key === "driver-en-route" && (!order.driver || order.driver === "Unassigned")) return "Admin should attach a driver name before route updates continue.";
  return stage.staffNext;
}

function roleEmail(role: WorkflowRole) {
  return `${role}@bubblewash.local`;
}

function orderPhone(order: WorkflowOrderSnapshot) {
  return order.phone || "operations-line";
}

function customerLine(order: WorkflowOrderSnapshot) {
  return `${order.customer}${order.email ? ` · ${order.email}` : ""}${order.phone ? ` · ${order.phone}` : ""}`;
}

function basePayload(order: WorkflowOrderSnapshot, role: WorkflowRole, userName: string) {
  return {
    name: userName,
    email: roleEmail(role),
    phone: orderPhone(order),
    company: role === "admin" ? "Bubble Wash Operations" : role === "driver" ? "Bubble Wash Route Team" : role === "vendor" ? (order.vendor === "Unassigned" ? "Vendor Partner" : order.vendor) : order.customer,
    orderId: order.orderId,
    area: order.area,
    routeWindow: order.routeWindow,
    paymentPreference: order.payment,
    priority: order.priority,
  };
}

function action(key: string, label: string, description: string, submissionType: string, nextStatus: string, payload: Record<string, string>): WorkflowAutomationAction {
  return { key, label, description, submissionType, nextStatus, payload: { ...payload, submissionType } };
}

export function automationActionsForOrder(order: WorkflowOrderSnapshot, role: WorkflowRole, userName: string): WorkflowAutomationAction[] {
  const stage = workflowStageFromStatus(order.status, order.lastEventType);
  const base = basePayload(order, role, userName);
  const customer = customerLine(order);
  const urgent = order.priority === "Urgent" || order.stageTimer?.tone === "breached";
  const actions: WorkflowAutomationAction[] = [];

  if (role === "admin") {
    if (stage.key === "received") {
      actions.push(action("admin-schedule-pickup", "Schedule pickup from order", "Confirms the pickup window using the original customer booking.", "admin-operation", "Pickup scheduled", {
        ...base,
        actionType: "Schedule pickup",
        orderStatus: "Pickup scheduled",
        vendorName: order.vendor,
        driverName: order.driver,
        message: `Pickup scheduled from inherited order data. Customer: ${customer}. Area: ${order.area}. Window: ${order.routeWindow}.`,
      }));
    }
    if (["received", "pickup-scheduled"].includes(stage.key)) {
      actions.push(action("admin-assign-vendor", "Assign vendor + driver", "Creates the dispatch handoff so vendor and driver dashboards inherit the same Order ID.", "admin-operation", "Vendor assigned", {
        ...base,
        actionType: "Assign vendor",
        orderStatus: "Vendor assigned",
        vendorName: order.vendor === "Unassigned" ? "Next available vendor" : order.vendor,
        driverName: order.driver === "Unassigned" ? "Next available driver" : order.driver,
        message: `Dispatch assignment created from order context. Customer: ${customer}. Payment: ${order.payment}.`,
      }));
    }
    if (stage.key === "delivered") {
      actions.push(action("admin-close-order", "Close order", "Closes the completed order after payment/invoice confirmation.", "admin-operation", "Closed", {
        ...base,
        actionType: "Close order",
        orderStatus: "Closed",
        vendorName: order.vendor,
        driverName: order.driver,
        message: `Order closed after delivery. Payment lane: ${order.payment}.`,
      }));
    }
    if (urgent || stage.key === "exception") {
      actions.push(action("admin-escalate-support", "Escalate to support", "Creates a support ticket with customer/order details already attached.", "support-ticket", "Escalated", {
        ...base,
        company: order.customer,
        issueType: "Workflow follow-up",
        ticketStatus: "Escalated",
        priority: urgent ? "Urgent" : "High",
        message: `Automated escalation for ${order.orderId}. Status: ${order.status}. Timer: ${order.stageTimer?.label ?? "Timer unavailable"}. Next step: ${workflowNextStep(order)}`,
      }));
    }
  }

  if (role === "vendor") {
    if (["vendor-assigned", "pickup-scheduled", "received"].includes(stage.key)) {
      actions.push(action("vendor-accept-job", "Accept assigned job", "Accepts the job using the inherited customer, area, and pickup window.", "vendor-job-update", "Accepted", {
        ...base,
        vendorName: order.vendor === "Unassigned" ? "Vendor Partner" : order.vendor,
        jobStatus: "Accepted",
        message: `Vendor accepted via automation. Customer: ${customer}. Area: ${order.area}. Window: ${order.routeWindow}.`,
      }));
    }
    if (["vendor-accepted", "picked-up"].includes(stage.key)) {
      actions.push(action("vendor-log-intake", "Confirm bag intake", "Adds intake to the same timeline; manual notes are only for exceptions.", "qr-bag-intake", "At vendor", {
        ...base,
        vendorName: order.vendor === "Unassigned" ? "Vendor Partner" : order.vendor,
        qrTag: `${order.orderId}-BAG`,
        itemCondition: "All items accepted",
        message: `Bag intake confirmed for ${order.orderId}. Staff only adds count mismatch, stain, or damage exceptions if needed.`,
      }));
    }
    if (["at-vendor", "vendor-accepted"].includes(stage.key)) {
      actions.push(action("vendor-start-washing", "Start washing", "Moves the order into production without re-entering customer details.", "vendor-job-update", "Washing", {
        ...base,
        vendorName: order.vendor === "Unassigned" ? "Vendor Partner" : order.vendor,
        jobStatus: "Washing started",
        message: `Washing started from inherited order context for ${order.orderId}.`,
      }));
    }
    if (stage.key === "washing") {
      actions.push(action("vendor-mark-ready", "Mark ready for driver", "Signals dispatch for return delivery on the same Order ID.", "vendor-job-update", "Ready", {
        ...base,
        vendorName: order.vendor === "Unassigned" ? "Vendor Partner" : order.vendor,
        jobStatus: "Ready for driver",
        message: `Order ready for return driver. Customer: ${customer}.`,
      }));
    }
  }

  if (role === "driver") {
    if (["pickup-scheduled", "vendor-assigned", "vendor-accepted"].includes(stage.key)) {
      actions.push(action("driver-start-route", "Start pickup route", "Starts route using the inherited area and pickup window.", "driver-route-log", "Driver en route", {
        ...base,
        company: "Bubble Wash Route Team",
        orderStatus: "Driver en route",
        driverName: order.driver === "Unassigned" ? userName : order.driver,
        driverEta: order.routeWindow,
        locationNote: order.locationNote === "No driver checkpoint yet" ? "Route started" : order.locationNote,
        message: `Driver route started from existing order data. Customer: ${customer}. Area: ${order.area}.`,
      }));
    }
    if (stage.key === "driver-en-route") {
      actions.push(action("driver-mark-picked-up", "Mark picked up", "Adds the pickup checkpoint without creating a second order.", "driver-route-log", "Picked up", {
        ...base,
        company: "Bubble Wash Route Team",
        orderStatus: "Picked up",
        driverName: order.driver === "Unassigned" ? userName : order.driver,
        driverEta: order.routeWindow,
        locationNote: "Pickup confirmed",
        message: `Pickup confirmed via automation for ${order.orderId}. Add exceptions only if bag count or customer handoff changed.`,
      }));
    }
    if (stage.key === "picked-up") {
      actions.push(action("driver-drop-at-vendor", "Drop at vendor", "Records the vendor handoff using the same customer/order data.", "driver-route-log", "Dropped at vendor", {
        ...base,
        company: "Bubble Wash Route Team",
        orderStatus: "Dropped at vendor",
        driverName: order.driver === "Unassigned" ? userName : order.driver,
        driverEta: order.routeWindow,
        locationNote: "Vendor handoff complete",
        message: `Bags handed to ${order.vendor}. Manual note needed only for count mismatch or exception.`,
      }));
    }
    if (stage.key === "ready") {
      actions.push(action("driver-out-for-delivery", "Start return delivery", "Starts final delivery from the ready order state.", "driver-route-log", "Out for delivery", {
        ...base,
        company: "Bubble Wash Route Team",
        orderStatus: "Out for delivery",
        driverName: order.driver === "Unassigned" ? userName : order.driver,
        driverEta: order.routeWindow,
        locationNote: "Return delivery started",
        message: `Return delivery started for ${order.orderId}.`,
      }));
    }
    if (stage.key === "out-for-delivery") {
      actions.push(action("driver-mark-delivered", "Mark delivered", "Closes the delivery leg and prompts admin closeout.", "driver-route-log", "Delivered", {
        ...base,
        company: "Bubble Wash Route Team",
        orderStatus: "Delivered",
        driverName: order.driver === "Unassigned" ? userName : order.driver,
        driverEta: order.routeWindow,
        locationNote: "Delivered to customer",
        message: `Delivered via automation for ${order.orderId}.`,
      }));
    }
  }

  if (role === "support") {
    actions.push(action("support-open-follow-up", "Open order follow-up", "Creates a ticket from the timeline instead of retyping customer and route details.", "support-ticket", "In Review", {
      ...base,
      company: order.customer,
      issueType: "General question",
      ticketStatus: "In Review",
      priority: urgent ? "High" : order.priority,
      message: `Support follow-up created from ${order.orderId}. Customer: ${customer}. Status: ${order.status}. Next step: ${workflowNextStep(order)}`,
    }));
    if (urgent || stage.key === "exception") {
      actions.push(action("support-notify-customer", "Notify customer of delay", "Records customer outreach with the order context already filled.", "support-ticket-action", "Waiting on Customer", {
        ...base,
        company: order.customer,
        assignedRole: "Support",
        escalationLevel: urgent ? "Level 2" : "Level 1",
        ticketStatus: "Waiting on Customer",
        priority: urgent ? "Urgent" : "High",
        message: `Customer notified about ${order.orderId}. Status: ${order.status}. Timer: ${order.stageTimer?.label ?? "Timer unavailable"}.`,
      }));
    }
  }

  return actions;
}
