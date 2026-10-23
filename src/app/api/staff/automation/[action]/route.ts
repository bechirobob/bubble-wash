import { NextResponse } from "next/server";
import { currentStaffUsers, getCurrentStaffUser } from "@/lib/auth";
import { staffWriteGuard } from "@/lib/security";
import { isRateLimited } from "@/lib/rate-limit";
import { AutomationError, automationCaseRecords, automationWorklist, dispatchRecommendations, manageWorkOwnership, reconciliationWorklist } from "@/lib/operations-automation";
import { projectStaffActivityRecord } from "@/lib/staff-activity-projection";
import { notificationReviewWorklist } from "@/lib/staff-notification-review";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store", Pragma: "no-cache", "X-Content-Type-Options": "nosniff" } });
type Context = { params: Promise<{ action: string }> };
const readable = new Set(["worklist", "case", "assignees", "dispatch", "reconciliation", "notifications"]);

export async function GET(request: Request, context: Context) {
  const user = await getCurrentStaffUser();
  if (!user) return json({ ok: false, error: "Authentication required." }, 401);
  const { action } = await context.params;
  if (!readable.has(action)) return json({ ok: false, error: "Worklist endpoint not found." }, 404);
  const params = new URL(request.url).searchParams;
  try {
    if (action === "worklist") return json(automationWorklist(user, params));
    if (action === "case") return json({ ok: true, role: user.role, records: automationCaseRecords(user, (params.get("caseId") || "").trim()).map((record) => projectStaffActivityRecord(record, user.role)) });
    if (action === "assignees") {
      if (!["admin", "support"].includes(user.role)) throw new AutomationError(403, "Admin or support access required.");
      return json({ ok: true, assignees: currentStaffUsers().filter((person) => ["admin", "support"].includes(person.role) && (user.role === "admin" || person.email.toLowerCase() === user.email.toLowerCase())).map(({ name, email, role }) => ({ name, email, role })) });
    }
    if (action === "dispatch") return json(dispatchRecommendations(user, (params.get("orderId") || "").trim().slice(0, 160)));
    if (action === "reconciliation") return json(reconciliationWorklist(user, Number(params.get("offset")) || 0));
    if (user.role !== "admin") throw new AutomationError(403, "Notification review requires admin access.");
    return json(notificationReviewWorklist(Number(params.get("offset")) || 0));
  } catch (error) {
    if (error instanceof AutomationError) return json({ ok: false, error: error.message }, error.status);
    return json({ ok: false, error: "Unable to load this worklist. Try again." }, 500);
  }
}

export async function POST(request: Request, context: Context) {
  const guard = staffWriteGuard(request.headers);
  if (guard) return guard;
  const user = await getCurrentStaffUser();
  if (!user) return json({ ok: false, error: "Authentication required." }, 401);
  const { action } = await context.params;
  if (action !== "ownership") return json({ ok: false, error: "This worklist is read-only." }, 405);
  if (!["admin", "support"].includes(user.role)) return json({ ok: false, error: "Only admin and support may manage follow-up ownership." }, 403);
  if (isRateLimited(`browser-work-ownership:${user.email.toLowerCase()}`, 30, 60_000)) return json({ ok: false, error: "Too many changes. Try again shortly." }, 429);
  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 16_384) return json({ ok: false, error: "The ownership command is too large." }, 413);
    body = JSON.parse(raw);
  } catch { return json({ ok: false, error: "Invalid JSON." }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "Invalid ownership command." }, 400);
  try { return json(manageWorkOwnership(user, body as Record<string, unknown>)); }
  catch (error) {
    if (error instanceof AutomationError) return json({ ok: false, error: error.message }, error.status);
    return json({ ok: false, error: "Save could not be confirmed. Retry the same details to check the saved result." }, 500);
  }
}
