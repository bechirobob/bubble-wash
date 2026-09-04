import { NextRequest, NextResponse } from "next/server";
import { staffAccessDisabled } from "@/lib/auth";
import { activateStaffAccount } from "@/lib/staff-accounts";
import { sameOriginJsonGuard } from "@/lib/security";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
export async function POST(request: NextRequest) {
  const guard = sameOriginJsonGuard(request.headers, "staff activation"); if (guard) return guard;
  if (staffAccessDisabled()) return NextResponse.json({ ok: false, error: "Login cannot be reached." }, { status: 503 });
  if (isRateLimited(clientKey(request.headers, "staff-activate"), 5, 60000)) return NextResponse.json({ ok: false, error: "Try again shortly." }, { status: 429 });
  try {
    const { token, password } = await request.json();
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token) || typeof password !== "string" || password.length < 14 || password.length > 200) return NextResponse.json({ ok: false, error: "Use the activation link and a password of 14–200 characters." }, { status: 400 });
    const ok = activateStaffAccount(token, password);
    return NextResponse.json({ ok, error: ok ? undefined : "This link is expired or already used." }, { status: ok ? 200 : 400 });
  } catch { return NextResponse.json({ ok: false, error: "Unable to activate access." }, { status: 400 }); }
}
