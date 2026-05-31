import { NextRequest, NextResponse } from "next/server";
import { sessionCookieName, sessionCookieOptions } from "@/lib/auth";

function clearStaffSession(response: NextResponse) {
  response.cookies.set({
    name: sessionCookieName,
    value: "",
    ...sessionCookieOptions(),
    maxAge: 0,
    expires: new Date(0),
  });
  response.cookies.delete(sessionCookieName);
  return response;
}

export async function GET(request: NextRequest) {
  return clearStaffSession(NextResponse.redirect(new URL("/login?loggedOut=1", request.url)));
}

export async function POST() {
  return clearStaffSession(NextResponse.json({ ok: true }));
}
