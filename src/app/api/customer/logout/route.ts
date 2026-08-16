import { NextRequest, NextResponse } from "next/server";
import { customerSessionCookieName, customerSessionCookieOptions } from "@/lib/customer-session";
import { sameOriginJsonGuard } from "@/lib/security";

export async function POST(request: NextRequest) {
  const guard = sameOriginJsonGuard(request.headers, "customer sign out");
  if (guard) return guard;
  const response = NextResponse.json({ ok: true });
  response.cookies.set({ name: customerSessionCookieName, value: "", ...customerSessionCookieOptions(), maxAge: 0, expires: new Date(0) });
  response.cookies.delete(customerSessionCookieName);
  return response;
}
