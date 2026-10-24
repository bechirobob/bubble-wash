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
const generation = store.startDriverLiveLocation(first.driverId, first.orderId);
assert.equal(store.upsertDriverLiveLocation(first, generation), true);
assert.deepEqual(store.readDriverLiveLocation(first.driverId), first);
assert.deepEqual(store.readDriverLiveLocation(first.driverId.toUpperCase()), first);

assert.equal(store.upsertDriverLiveLocation({ ...first, latitude: 5.61 }, generation), false);
assert.equal(store.upsertDriverLiveLocation({ ...first, capturedAt: captured(-11_000) }, generation), false);
assert.equal(store.readDriverLiveLocation(first.driverId)?.latitude, first.latitude);

const latest = {
  ...first,
  latitude: 5.61,
  longitude: -0.18,
  capturedAt: captured(-8_000),
  receivedAt: captured(-7_000),
};
assert.equal(store.upsertDriverLiveLocation(latest, generation), true);
assert.deepEqual(store.readDriverLiveLocation(first.driverId), latest);
assert.equal(store.readDriverLiveLocations().length, 1);

const second = {
  ...first,
  driverId: "driver-live-two",
  orderId: "BW-LIVE-ORDER-2",
  capturedAt: captured(-6_000),
  receivedAt: captured(-5_000),
};
const secondGeneration = store.startDriverLiveLocation(second.driverId, second.orderId);
assert.equal(store.upsertDriverLiveLocation(second, secondGeneration), true);
assert.deepEqual(store.readDriverLiveLocations().map((item) => item.driverId), [second.driverId, first.driverId]);

assert.equal(store.deleteDriverLiveLocation(first.driverId), true);
assert.equal(store.deleteDriverLiveLocation(first.driverId), false);
assert.equal(store.readDriverLiveLocation(first.driverId), null);
assert.equal(store.deleteExpiredDriverLiveLocations(captured(1)), 1);
assert.deepEqual(store.readDriverLiveLocations(), []);
assert.equal(store.databaseReadiness(), true);

// Clock skew never grants permission to keep sharing after a stop.
const ahead = { ...first, capturedAt: captured(20_000) };
assert.equal(store.upsertDriverLiveLocation(ahead, generation), true);
assert.equal(store.stopDriverLiveLocation(first.driverId).cleared, true);
assert.equal(store.readDriverLiveLocation(first.driverId), null);
assert.equal(store.upsertDriverLiveLocation({ ...ahead, capturedAt: captured(21_000) }, generation), false);
assert.equal(store.upsertDriverLiveLocation(ahead), false);
const resumed = store.startDriverLiveLocation(first.driverId, first.orderId);
assert.notEqual(resumed, generation);
assert.equal(store.upsertDriverLiveLocation(first, generation), false);
assert.equal(store.upsertDriverLiveLocation(first, resumed), true);
assert.equal(store.stopDriverLiveLocation(first.driverId, { generation, orderId: first.orderId }).staleGeneration, true);
assert.deepEqual(store.readDriverLiveLocation(first.driverId), first);
assert.equal(store.stopDriverLiveLocation(first.driverId, { generation: resumed, orderId: second.orderId }).staleGeneration, true);
assert.equal(store.upsertDriverLiveLocation({ ...first, orderId: second.orderId, capturedAt: captured(22_000) }, resumed), false);
assert.equal(store.stopDriverLiveLocation(first.driverId, { generation: resumed, orderId: first.orderId }).cleared, true);
assert.equal(store.upsertDriverLiveLocation(ahead, resumed), false);
console.log(JSON.stringify({ ok: true, checks: 32, generationFencing: true }));
