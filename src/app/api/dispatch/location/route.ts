import { NextRequest, NextResponse } from "next/server";
import { getCurrentStaffUser } from "@/lib/auth";
import {
  deleteDriverLiveLocation,
  deleteExpiredDriverLiveLocations,
  readDriverLiveLocation,
  readDriverLiveLocations,
  readSubmissionRecordsForOrder,
  upsertDriverLiveLocation,
} from "@/lib/data-store";
import {
  isActiveMovingDriverAssignment,
  LIVE_LOCATION_EXPIRES_AFTER_MS,
  projectDriverLocation,
  type DriverLocationView,
  type StoredDriverLocation,
  validateLiveLocationInput,
} from "@/lib/dispatch-location";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
import { privateNoStoreHeaders, sameOriginJsonGuard } from "@/lib/security";
import { buildOrderSummaries } from "@/lib/submissions";

const privateNoStore = Object.fromEntries(privateNoStoreHeaders().map(({ key, value }) => [key, value]));

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: privateNoStore });
}

function privateGuardResponse(response: NextResponse) {
  for (const [key, value] of Object.entries(privateNoStore)) response.headers.set(key, value);
  return response;
}

async function assignedMovingOrder(orderId: string, driverId: string) {
  const order = buildOrderSummaries(await readSubmissionRecordsForOrder(orderId))
    .find((item) => item.orderId.toLowerCase() === orderId.toLowerCase());
  if (!order || !isActiveMovingDriverAssignment(order, driverId)) return null;
  return order;
}

async function activeLocationView(location: StoredDriverLocation, now: number) {
  const order = await assignedMovingOrder(location.orderId, location.driverId);
  if (!order) {
    await deleteDriverLiveLocation(location.driverId);
    return null;
  }
  const view = projectDriverLocation(
    location,
    order.driver === "Unassigned" ? "Assigned rider" : order.driver,
    now,
  );
  if (!view) await deleteDriverLiveLocation(location.driverId);
  return view;
}

export async function GET() {
  const user = await getCurrentStaffUser();
  if (!user) return json({ ok: false, error: "Authentication required." }, 401);
  if (user.role !== "admin" && user.role !== "driver") {
    return json({ ok: false, error: "Live dispatch location is restricted to admins and riders." }, 403);
  }
  if (user.role === "driver" && !user.entityId?.trim()) {
    return json({ ok: false, error: "A bound rider identity is required for live location." }, 403);
  }

  try {
    const now = Date.now();
    await deleteExpiredDriverLiveLocations(new Date(now - LIVE_LOCATION_EXPIRES_AFTER_MS).toISOString());
    const stored = user.role === "admin"
      ? await readDriverLiveLocations()
      : [await readDriverLiveLocation(user.entityId ?? "")].filter((item): item is StoredDriverLocation => Boolean(item));
    const locations: DriverLocationView[] = [];
    for (const location of stored) {
      const view = await activeLocationView(location, now);
      if (view) locations.push(view);
    }
    return json({
      ok: true,
      locations,
      ...(user.role === "driver" ? { location: locations[0] ?? null } : {}),
    });
  } catch (error) {
    console.error("Bubble Wash live location read failed", {
      message: error instanceof Error ? error.message : "Unknown error",
      role: user.role,
    });
    return json({ ok: false, error: "Unable to load live dispatch location." }, 500);
  }
}

export async function POST(request: NextRequest) {
  const user = await getCurrentStaffUser();
  if (!user) return json({ ok: false, error: "Authentication required." }, 401);
  if (user.role !== "driver") {
    return json({ ok: false, error: "Only a rider can share live location." }, 403);
  }
  const driverId = user.entityId?.trim();
  if (!driverId) return json({ ok: false, error: "A bound rider identity is required for live location." }, 403);

  const guardError = sameOriginJsonGuard(request.headers, "live location update");
  if (guardError) return privateGuardResponse(guardError);
  if (await isRateLimited(clientKey(request.headers, `dispatch-location:${driverId.toLowerCase()}`), 90, 60_000)) {
    return json({ ok: false, error: "Too many location updates. Wait briefly and try again." }, 429);
  }

  try {
    const now = Date.now();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Live location update must contain valid JSON." }, 400);
    }
    const validation = validateLiveLocationInput(body, now);
    if (!validation.ok) return json({ ok: false, error: validation.error }, 422);

    const order = await assignedMovingOrder(validation.value.orderId, driverId);
    if (!order) {
      return json({ ok: false, error: "Live location requires an active moving route assigned to this rider." }, 409);
    }

    const stored: StoredDriverLocation = {
      driverId,
      ...validation.value,
      receivedAt: new Date(now).toISOString(),
    };
    if (!await upsertDriverLiveLocation(stored)) {
      return json({ ok: false, error: "This GPS reading is older than or equal to the latest accepted update." }, 409);
    }

    const location = projectDriverLocation(
      stored,
      order.driver === "Unassigned" ? user.name : order.driver,
      now,
    );
    return json({ ok: true, location });
  } catch (error) {
    console.error("Bubble Wash live location update failed", {
      message: error instanceof Error ? error.message : "Unknown error",
      driverId,
    });
    return json({ ok: false, error: "Unable to save live dispatch location." }, 500);
  }
}

export async function DELETE(request: NextRequest) {
  const user = await getCurrentStaffUser();
  if (!user) return json({ ok: false, error: "Authentication required." }, 401);
  if (user.role !== "driver") {
    return json({ ok: false, error: "Only a rider can clear live location." }, 403);
  }
  const driverId = user.entityId?.trim();
  if (!driverId) return json({ ok: false, error: "A bound rider identity is required for live location." }, 403);

  const guardError = sameOriginJsonGuard(request.headers, "live location clear");
  if (guardError) return privateGuardResponse(guardError);
  if (await isRateLimited(clientKey(request.headers, `dispatch-location-clear:${driverId.toLowerCase()}`), 20, 60_000)) {
    return json({ ok: false, error: "Too many location clear requests. Wait briefly and try again." }, 429);
  }

  try {
    const cleared = await deleteDriverLiveLocation(driverId);
    return json({ ok: true, cleared, location: null });
  } catch (error) {
    console.error("Bubble Wash live location clear failed", {
      message: error instanceof Error ? error.message : "Unknown error",
      driverId,
    });
    return json({ ok: false, error: "Unable to clear live dispatch location." }, 500);
  }
}
