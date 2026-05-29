import { NextRequest, NextResponse } from "next/server";
import { sessionCookieName } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/login", request.url));
  response.cookies.set({ name: sessionCookieName, value: "", path: "/", maxAge: 0 });
  return response;
}

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set({ name: sessionCookieName, value: "", path: "/", maxAge: 0 });
  return response;
}
