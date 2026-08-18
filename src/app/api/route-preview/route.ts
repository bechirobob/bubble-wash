import { NextRequest, NextResponse } from "next/server";
import { buildRoutePreview } from "@/lib/maps";
import { type ZoneKey, zones } from "@/lib/pricing";
import { clientKey, isRateLimited } from "@/lib/rate-limit";

function zoneFrom(value: string | null): ZoneKey {
  return value && value in zones ? (value as ZoneKey) : "core";
}

export async function GET(request: NextRequest) {
  if (isRateLimited(clientKey(request.headers, "route-preview"), 60, 60_000)) {
    return NextResponse.json({ ok: false, error: "Too many route preview requests. Try again shortly." }, { status: 429 });
  }

  const zone = zoneFrom(request.nextUrl.searchParams.get("zone"));
  const area = request.nextUrl.searchParams.get("area")?.trim().slice(0, 160) ?? "";

  return NextResponse.json({ ok: true, route: buildRoutePreview(zone, area) });
}
