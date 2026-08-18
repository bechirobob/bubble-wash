import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";

process.env.BUBBLEWASH_DATABASE_PATH = path.join(process.cwd(), "data", `dispatch-location-${randomUUID()}.sqlite`);

const store = await import("../src/lib/data-store.ts");
store.resetDataStoreForTests();

const now = Date.now();
const captured = (offsetMs) => new Date(now + offsetMs).toISOString();

const first = {
  driverId: "driver-live-one",
  orderId: "BW-LIVE-ORDER-1",
  latitude: 5.6037,
  longitude: -0.187,
  accuracyMeters: 12,
  capturedAt: captured(-10_000),
  receivedAt: captured(-9_000),
};
assert.equal(store.upsertDriverLiveLocation(first), true);
assert.deepEqual(store.readDriverLiveLocation(first.driverId), first);
assert.deepEqual(store.readDriverLiveLocation(first.driverId.toUpperCase()), first);

assert.equal(store.upsertDriverLiveLocation({ ...first, latitude: 5.61 }), false);
assert.equal(store.upsertDriverLiveLocation({ ...first, capturedAt: captured(-11_000) }), false);
assert.equal(store.readDriverLiveLocation(first.driverId)?.latitude, first.latitude);

const latest = {
  ...first,
  latitude: 5.61,
  longitude: -0.18,
  capturedAt: captured(-8_000),
  receivedAt: captured(-7_000),
};
assert.equal(store.upsertDriverLiveLocation(latest), true);
assert.deepEqual(store.readDriverLiveLocation(first.driverId), latest);
assert.equal(store.readDriverLiveLocations().length, 1);

const second = {
  ...first,
  driverId: "driver-live-two",
  orderId: "BW-LIVE-ORDER-2",
  capturedAt: captured(-6_000),
  receivedAt: captured(-5_000),
};
assert.equal(store.upsertDriverLiveLocation(second), true);
assert.deepEqual(store.readDriverLiveLocations().map((item) => item.driverId), [second.driverId, first.driverId]);

assert.equal(store.deleteDriverLiveLocation(first.driverId), true);
assert.equal(store.deleteDriverLiveLocation(first.driverId), false);
assert.equal(store.readDriverLiveLocation(first.driverId), null);
assert.equal(store.deleteExpiredDriverLiveLocations(captured(1)), 1);
assert.deepEqual(store.readDriverLiveLocations(), []);
assert.equal(store.databaseReadiness(), true);

console.log(JSON.stringify({ ok: true, checks: 17 }));
