import { randomInt, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { customerSessionCookieName, decodeCustomerSession } from "@/lib/customer-session";
import { getDatabase, appendSubmissionRecord } from "@/lib/data-store";
import { deliveryCodeHash } from "@/lib/chain-of-custody";
import { sameOriginJsonGuard } from "@/lib/security";
import { isRateLimited } from "@/lib/rate-limit";
export async function POST(request: NextRequest) {
  const guard = sameOriginJsonGuard(request.headers, "delivery code recovery");
  if (guard) return guard;
  const session = decodeCustomerSession(request.cookies.get(customerSessionCookieName)?.value);
  if (!session) return NextResponse.json({ ok: false, error: "Verify your booking details first." }, { status: 401 });
  if (!session.verifiedContact) return NextResponse.json({ ok: false, error: "Use email recovery to verify ownership before replacing your handoff code." }, { status: 403 });
  if (isRateLimited(`delivery-reissue:${session.orderId}`, 3, 3600000)) return NextResponse.json({ ok: false, error: "Too many code requests. Try again in an hour." }, { status: 429 });
  const code = String(randomInt(0, 1000000)).padStart(6, "0");
  const changed = getDatabase().transaction(() => {
    const result = getDatabase().prepare("UPDATE delivery_proofs SET code_hash = ?, created_at = ? WHERE order_id = ? COLLATE NOCASE AND used_at IS NULL").run(deliveryCodeHash(session.orderId, code), new Date().toISOString(), session.orderId);
    if (!result.changes) return false;
    appendSubmissionRecord({ id: `BW-${randomUUID()}`, createdAt: new Date().toISOString(), source: "customer-code-recovery", data: { submissionType: "customer-security-update", orderId: session.orderId, message: "Customer replaced their unused delivery handoff code.", submittedByRole: "customer" } });
    return true;
  }).immediate();
  return changed ? NextResponse.json({ ok: true, deliveryCode: code }, { headers: { "Cache-Control": "no-store" } }) : NextResponse.json({ ok: false, error: "This order has no unused handoff code." }, { status: 409 });
}
