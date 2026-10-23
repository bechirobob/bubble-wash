export const LIVE_LOCATION_RECENT_AFTER_MS = 45_000;
export const LIVE_LOCATION_OFFLINE_AFTER_MS = 2 * 60_000;
export const LIVE_LOCATION_EXPIRES_AFTER_MS = 15 * 60_000;
export const LIVE_LOCATION_MAX_CAPTURE_AGE_MS = 2 * 60_000;
export const LIVE_LOCATION_MAX_FUTURE_SKEW_MS = 30_000;
export const LIVE_LOCATION_MAX_ACCURACY_METERS = 1_000;

// Pilot service boundary: Greater Accra from western Accra through Tema.
export const LIVE_LOCATION_BOUNDS = {
  minLatitude: 5.45,
  maxLatitude: 5.95,
  minLongitude: -0.45,
  maxLongitude: 0.2,
} as const;

export type LiveLocationState = "live" | "recent" | "offline";

export type StoredDriverLocation = {
  driverId: string;
  orderId: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAt: string;
  receivedAt: string;
};

export type DriverLocationView = {
  driverId: string;
  driverName: string;
  orderId: string;
  latitude?: number;
  longitude?: number;
  accuracyMeters?: number;
  capturedAt: string;
  receivedAt: string;
  state: LiveLocationState;
  live: boolean;
};

export type ValidLiveLocationInput = Pick<StoredDriverLocation, "orderId" | "latitude" | "longitude" | "accuracyMeters" | "capturedAt">;

type ValidationResult =
  | { ok: true; value: ValidLiveLocationInput }
  | { ok: false; error: string };

const movingRouteStages = new Set(["driver-en-route", "picked-up", "out-for-delivery"]);
const utcTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateLiveLocationInput(body: unknown, now = Date.now()): ValidationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "A location update is required." };
  }

  const input = body as Record<string, unknown>;
  const orderId = typeof input.orderId === "string" ? input.orderId.trim() : "";
  const capturedAt = typeof input.capturedAt === "string" ? input.capturedAt.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,119}$/.test(orderId)) {
    return { ok: false, error: "A valid active order ID is required." };
  }
  if (!finiteNumber(input.latitude) || !finiteNumber(input.longitude)) {
    return { ok: false, error: "Latitude and longitude must be finite numbers." };
  }
  if (
    input.latitude < LIVE_LOCATION_BOUNDS.minLatitude
    || input.latitude > LIVE_LOCATION_BOUNDS.maxLatitude
    || input.longitude < LIVE_LOCATION_BOUNDS.minLongitude
    || input.longitude > LIVE_LOCATION_BOUNDS.maxLongitude
  ) {
    return { ok: false, error: "Location is outside the Accra and Tema pilot service area." };
  }
  if (!finiteNumber(input.accuracyMeters) || input.accuracyMeters <= 0 || input.accuracyMeters > LIVE_LOCATION_MAX_ACCURACY_METERS) {
    return { ok: false, error: `Location accuracy must be greater than 0 and no more than ${LIVE_LOCATION_MAX_ACCURACY_METERS} metres.` };
  }
  if (!utcTimestamp.test(capturedAt)) {
    return { ok: false, error: "capturedAt must be a UTC ISO timestamp." };
  }

  const capturedTime = Date.parse(capturedAt);
  if (!Number.isFinite(capturedTime)) {
    return { ok: false, error: "capturedAt must be a valid timestamp." };
  }
  if (capturedTime > now + LIVE_LOCATION_MAX_FUTURE_SKEW_MS) {
    return { ok: false, error: "The location timestamp is too far in the future." };
  }
  if (capturedTime < now - LIVE_LOCATION_MAX_CAPTURE_AGE_MS) {
    return { ok: false, error: "The location update is too old. Request a fresh GPS position." };
  }

  return {
    ok: true,
    value: {
      orderId,
      latitude: input.latitude,
      longitude: input.longitude,
      accuracyMeters: input.accuracyMeters,
      capturedAt: new Date(capturedTime).toISOString(),
    },
  };
}

export function liveLocationState(capturedAt: string, now = Date.now()): LiveLocationState | "expired" {
  const age = Math.max(0, now - Date.parse(capturedAt));
  if (!Number.isFinite(age) || age > LIVE_LOCATION_EXPIRES_AFTER_MS) return "expired";
  if (age > LIVE_LOCATION_OFFLINE_AFTER_MS) return "offline";
  if (age > LIVE_LOCATION_RECENT_AFTER_MS) return "recent";
  return "live";
}

export function projectDriverLocation(
  location: StoredDriverLocation,
  driverName: string,
  now = Date.now(),
): DriverLocationView | null {
  const state = liveLocationState(location.capturedAt, now);
  if (state === "expired") return null;
  const base = {
    driverId: location.driverId,
    driverName,
    orderId: location.orderId,
    capturedAt: location.capturedAt,
    receivedAt: location.receivedAt,
    state,
    live: state === "live",
  };
  if (state === "offline") return base;
  return {
    ...base,
    latitude: location.latitude,
    longitude: location.longitude,
    accuracyMeters: location.accuracyMeters,
  };
}

export function isActiveMovingDriverAssignment(
  order: { driverId: string; workflowStage: { key: string } },
  driverId: string,
) {
  const expected = driverId.trim().toLowerCase();
  return Boolean(expected)
    && order.driverId.trim().toLowerCase() === expected
    && movingRouteStages.has(order.workflowStage.key);
}
