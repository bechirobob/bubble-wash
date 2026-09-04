import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { verifyPaymentReference } from "@/lib/payment-reconciliation";
export async function POST(request: NextRequest) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return NextResponse.json({ ok: false }, { status: 503 });
  const raw = await request.text();
  if (raw.length > 100000) return NextResponse.json({ ok: false }, { status: 413 });
  const signature = request.headers.get("x-paystack-signature") || "";
  const expected = createHmac("sha512", secret).update(raw).digest("hex");
  if (!/^[a-f0-9]{128}$/i.test(signature) || !timingSafeEqual(Buffer.from(signature.toLowerCase()), Buffer.from(expected))) return NextResponse.json({ ok: false }, { status: 401 });
  try {
    const event = JSON.parse(raw);
    if (event.event !== "charge.success") return NextResponse.json({ ok: true, ignored: true });
    const reference = event.data?.reference;
    if (typeof reference !== "string" || !/^BW-PAY-[A-Z0-9]{18}$/.test(reference)) return NextResponse.json({ ok: true, ignored: true });
    return verifyPaymentReference(reference);
  } catch { return NextResponse.json({ ok: false }, { status: 400 }); }
}
