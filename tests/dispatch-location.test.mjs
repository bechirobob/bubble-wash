import test from "node:test";
import assert from "node:assert/strict";
import {
  isActiveMovingDriverAssignment,
  LIVE_LOCATION_EXPIRES_AFTER_MS,
  LIVE_LOCATION_MAX_CAPTURE_AGE_MS,
  LIVE_LOCATION_MAX_FUTURE_SKEW_MS,
  LIVE_LOCATION_OFFLINE_AFTER_MS,
  LIVE_LOCATION_RECENT_AFTER_MS,
  liveLocationState,
  projectDriverLocation,
  validateLiveLocationInput,
} from "../src/lib/dispatch-location.ts";

const now = Date.parse("2026-07-18T12:00:00.000Z");
const valid = {
  orderId: "BW-LIVE-123",
  latitude: 5.6037,
  longitude: -0.187,
  accuracyMeters: 18.5,
  capturedAt: new Date(now - 5_000).toISOString(),
};

test("live location input accepts a fresh, accurate Accra reading", () => {
  const result = validateLiveLocationInput(valid, now);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, valid);
});

test("live location input rejects coerced, non-finite, and out-of-area coordinates", () => {
  for (const update of [
    { ...valid, latitude: "5.6037" },
    { ...valid, longitude: Number.NaN },
    { ...valid, latitude: Number.POSITIVE_INFINITY },
    { ...valid, latitude: 4.9 },
    { ...valid, longitude: 0.5 },
  ]) {
    assert.equal(validateLiveLocationInput(update, now).ok, false);
  }
});

test("live location input requires bounded GPS accuracy", () => {
  assert.equal(validateLiveLocationInput({ ...valid, accuracyMeters: 0 }, now).ok, false);
  assert.equal(validateLiveLocationInput({ ...valid, accuracyMeters: 1_001 }, now).ok, false);
  assert.equal(validateLiveLocationInput({ ...valid, accuracyMeters: "12" }, now).ok, false);
});

test("live location input rejects malformed, old, and future capture times", () => {
  assert.equal(validateLiveLocationInput({ ...valid, capturedAt: "today" }, now).ok, false);
  assert.equal(validateLiveLocationInput({
    ...valid,
    capturedAt: new Date(now - LIVE_LOCATION_MAX_CAPTURE_AGE_MS - 1).toISOString(),
  }, now).ok, false);
  assert.equal(validateLiveLocationInput({
    ...valid,
    capturedAt: new Date(now + LIVE_LOCATION_MAX_FUTURE_SKEW_MS + 1).toISOString(),
  }, now).ok, false);
});

test("location freshness progresses from live to recent, offline, then expired", () => {
  assert.equal(liveLocationState(new Date(now - LIVE_LOCATION_RECENT_AFTER_MS).toISOString(), now), "live");
  assert.equal(liveLocationState(new Date(now - LIVE_LOCATION_RECENT_AFTER_MS - 1).toISOString(), now), "recent");
  assert.equal(liveLocationState(new Date(now - LIVE_LOCATION_OFFLINE_AFTER_MS - 1).toISOString(), now), "offline");
  assert.equal(liveLocationState(new Date(now - LIVE_LOCATION_EXPIRES_AFTER_MS - 1).toISOString(), now), "expired");
});

test("offline projections withhold exact coordinates and accuracy", () => {
  const stored = {
    driverId: "driver-one",
    orderId: valid.orderId,
    latitude: valid.latitude,
    longitude: valid.longitude,
    accuracyMeters: valid.accuracyMeters,
    capturedAt: new Date(now - LIVE_LOCATION_OFFLINE_AFTER_MS - 1).toISOString(),
    receivedAt: new Date(now - LIVE_LOCATION_OFFLINE_AFTER_MS).toISOString(),
  };
  const view = projectDriverLocation(stored, "Kwame Rider", now);
  assert.equal(view?.state, "offline");
  assert.equal(view?.live, false);
  assert.equal(Object.hasOwn(view ?? {}, "latitude"), false);
  assert.equal(Object.hasOwn(view ?? {}, "longitude"), false);
  assert.equal(Object.hasOwn(view ?? {}, "accuracyMeters"), false);

  const recent = projectDriverLocation({ ...stored, capturedAt: new Date(now - 60_000).toISOString() }, "Kwame Rider", now);
  assert.equal(recent?.state, "recent");
  assert.equal(recent?.live, false);
  assert.equal(recent?.latitude, valid.latitude);
  assert.equal(recent?.accuracyMeters, valid.accuracyMeters);
  assert.equal(projectDriverLocation({ ...stored, capturedAt: new Date(now - LIVE_LOCATION_EXPIRES_AFTER_MS - 1).toISOString() }, "Kwame Rider", now), null);
});

test("only an exact rider assignment in a moving route stage can share location", () => {
  for (const key of ["driver-en-route", "picked-up", "out-for-delivery"]) {
    assert.equal(isActiveMovingDriverAssignment({ driverId: "driver-one", workflowStage: { key } }, "DRIVER-ONE"), true);
  }
  assert.equal(isActiveMovingDriverAssignment({ driverId: "driver-two", workflowStage: { key: "driver-en-route" } }, "driver-one"), false);
  assert.equal(isActiveMovingDriverAssignment({ driverId: "driver-one", workflowStage: { key: "ready" } }, "driver-one"), false);
  assert.equal(isActiveMovingDriverAssignment({ driverId: "", workflowStage: { key: "driver-en-route" } }, "driver-one"), false);
});
