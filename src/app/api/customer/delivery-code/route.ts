import { uatRequestGuard } from "@/lib/uat-request-guard";
import { randomInt, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { customerSessionCookieName, decodeCustomerSession } from "@/lib/customer-session";
import { getDatabase, appendSubmissionRecord } from "@/lib/data-store";
import { deliveryCodeHash } from "@/lib/chain-of-custody";
import { sameOriginJsonGuard } from "@/lib/security";
import { isRateLimited } from "@/lib/rate-limit";
export async function POST(request: NextRequest) {
  const uatGuard = await uatRequestGuard();
  if (uatGuard) return uatGuard;
  const guard = sameOriginJsonGuard(request.headers, "delivery code recovery");
  if (guard) return guard;
  const session = decodeCustomerSession(request.cookies.get(customerSessionCookieName)?.value);
  if (!session) return NextResponse.json({ ok: false, error: "Verify your booking details first." }, { status: 401 });
  if (!session.verifiedContact) return NextResponse.json({ ok: false, error: "Use email recovery to verify ownership before replacing your handoff code." }, { status: 403 });
  if (isRateLimited(`delivery-reissue:${session.orderId}`, 3, 3600000)) return NextResponse.json({ ok: false, error: "Too many code requests. Try again in an hour." }, { status: 429 });
  const replacement = getDatabase().transaction(() => {
    const previous = getDatabase().prepare("SELECT code_hash FROM delivery_proofs WHERE order_id = ? COLLATE NOCASE AND used_at IS NULL").get(session.orderId) as { code_hash: string } | undefined;
    if (!previous) return { status: 409 as const };
    // A replacement must invalidate the current code, even if randomness repeats.
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = String(randomInt(0, 1000000)).padStart(6, "0");
      const hash = deliveryCodeHash(session.orderId, code);
      if (hash === previous.code_hash) continue;
      const result = getDatabase().prepare("UPDATE delivery_proofs SET code_hash = ?, created_at = ? WHERE order_id = ? COLLATE NOCASE AND used_at IS NULL").run(hash, new Date().toISOString(), session.orderId);
      if (!result.changes) return { status: 409 as const };
      appendSubmissionRecord({ id: `BW-${randomUUID()}`, createdAt: new Date().toISOString(), source: "customer-code-recovery", data: { submissionType: "customer-security-update", orderId: session.orderId, message: "Customer replaced their unused delivery handoff code.", submittedByRole: "customer" } });
      return { status: 200 as const, code };
    }
    return { status: 503 as const };
  }).immediate();
  if (replacement.status === 200) return NextResponse.json({ ok: true, deliveryCode: replacement.code }, { headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({ ok: false, error: replacement.status === 503 ? "Unable to generate a different handoff code. Please try again." : "This order has no unused handoff code." }, { status: replacement.status });
}
