import { NextResponse } from "next/server";
import { getCurrentStaffUser } from "@/lib/auth";
import { staffWriteGuard } from "@/lib/security";
import { vendorCapacityCommand } from "@/lib/vendor-capacity-command";

// Cookie-authenticated bound-vendor command; no native authentication surface.
async function handle(request: Request, body: Record<string, unknown>) {
  const user = await getCurrentStaffUser();
  if (!user) return NextResponse.json({ ok: false, error: "Authentication required." }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  if (user.role !== "vendor" || !user.entityId?.trim()) return NextResponse.json({ ok: false, error: "A bound vendor identity is required." }, { status: 403, headers: { "Cache-Control": "private, no-store" } });
  return vendorCapacityCommand(request, user, body);
}
export async function GET(request: Request) { return handle(request, {}); }
export async function POST(request: Request) {
  const guard = staffWriteGuard(request.headers);
  if (guard) return guard;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ ok: false, error: "Invalid capacity command." }, { status: 400 });
  return handle(request, body as Record<string, unknown>);
}
