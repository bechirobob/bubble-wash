import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ ok: true, service: "Bubble Wash pilot app", version: "next-typescript", time: new Date().toISOString() });
}
