import { randomBytes, createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getDatabase, enqueueNotification, readSubmissionRecordsForOrder } from "@/lib/data-store";
import { customerSessionCookieName, customerSessionCookieOptions, encodeCustomerSession } from "@/lib/customer-session";
import { customerOrderView } from "@/lib/customer-orders";
import { buildOrderSummaries } from "@/lib/submissions";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
import { sameOriginJsonGuard } from "@/lib/security";
export async function POST(request: NextRequest) {
  const guard = sameOriginJsonGuard(request.headers, "customer recovery"); if (guard) return guard;
  if (isRateLimited(clientKey(request.headers, "customer-recovery"), 5, 3600000)) return NextResponse.json({ ok: false, error: "Too many recovery requests. Try again later." }, { status: 429 });
  const db = getDatabase();
  db.exec("CREATE TABLE IF NOT EXISTS customer_recovery (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT)");
  try {
    const body = await request.json();
    if (body.token) {
      if (typeof body.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) throw new Error("Recovery link invalid.");
      const recovered = db.transaction(() => {
        const recovery = db.prepare("UPDATE customer_recovery SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email").get(new Date().toISOString(), createHash("sha256").update(body.token).digest("hex"), new Date().toISOString()) as { email: string } | undefined;
        if (!recovery) return null;
        const references = db.prepare("SELECT id AS orderId, created_at AS createdAt FROM submissions WHERE json_extract(data, '$.submissionType') = 'pickup-booking' AND lower(json_extract(data, '$.email')) = ? ORDER BY created_at DESC LIMIT 100").all(recovery.email) as { orderId: string; createdAt: string }[];
        if (!references[0]) return null;
        const records = readSubmissionRecordsForOrder(references[0].orderId);
        const order = buildOrderSummaries(records)[0];
        return { email: recovery.email, order: customerOrderView(order, records), references };
      }).immediate();
      if (!recovered) return NextResponse.json({ ok: false, error: "This recovery link expired or was already used. Request a new link." }, { status: 400 });
      const response = NextResponse.json({ ok: true, order: recovered.order, references: recovered.references }, { headers: { "Cache-Control": "no-store" } });
      response.cookies.set(customerSessionCookieName, encodeCustomerSession(recovered.order.orderId, recovered.email, true), customerSessionCookieOptions());
      return response;
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 160) throw new Error("Enter your booking email.");
    if (!process.env.RESEND_API_KEY) return NextResponse.json({ ok: false, error: "Email recovery is temporarily unavailable. Use your booking reference and contact details, or contact operations for identity review." }, { status: 503 });
    if (isRateLimited(`recovery-email:${createHash('sha256').update(email).digest('hex')}`, 3, 3600000)) return NextResponse.json({ ok: true, message: "If that email has bookings, a recovery link will be sent shortly." });
    const found = db.prepare("SELECT 1 FROM submissions WHERE json_extract(data, '$.submissionType') = 'pickup-booking' AND lower(json_extract(data, '$.email')) = ? LIMIT 1").get(email);
    if (found) db.transaction(() => {
      const token = randomBytes(32).toString("base64url"); const id = randomUUID();
      db.prepare("INSERT INTO customer_recovery VALUES (?, ?, ?, NULL)").run(createHash("sha256").update(token).digest("hex"), email, new Date(Date.now() + 30 * 60000).toISOString());
      enqueueNotification({ id: `NQ-${id}`, dedupeKey: `customer-recovery:${id}`, channel: "email", target: "customer", payload: { toEmail: email, subject: "Recover your Bubble Wash order", text: `Open ${(process.env.BUBBLEWASH_PUBLIC_URL || 'https://bubblewash.co')}/manage#recovery=${token} to recover your order references and replace a lost handoff code. This single-use link expires in 30 minutes. If you did not request this, ignore this email.`, purpose: "privacy" } });
    }).immediate();
    return NextResponse.json({ ok: true, message: "If that email has bookings, a recovery link will be sent shortly." });
  } catch (error) { return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to recover the order." }, { status: 400 }); }
}
