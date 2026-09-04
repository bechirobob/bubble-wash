import { NextResponse } from "next/server";

// Liveness confirms the HTTP process is serving; /api/ready checks dependencies.
export async function GET() {
  return NextResponse.json({ ok: true, service: "Bubble Wash", status: "alive", time: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
}
