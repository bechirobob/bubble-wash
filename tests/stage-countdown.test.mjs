import test from "node:test";
import assert from "node:assert/strict";
import { stageCountdown } from "../src/lib/stage-countdown.ts";
const start = "2026-10-20T00:00:00.000Z";
const epoch = Date.parse(start);
test("phase countdown ticks to zero and never starts counting up", () => {
  assert.equal(stageCountdown(start, 60, epoch).remainingSeconds, 3600);
  assert.equal(stageCountdown(start, 60, epoch + 3599000).remainingSeconds, 1);
  for (const offset of [3600000, 3601000, 365 * 86400000]) {
    assert.deepEqual(stageCountdown(start, 60, epoch + offset), { state: "overdue", tone: "breached", remainingSeconds: 0 });
  }
});
test("closed and cancelled phases have no running timer", () => {
  assert.deepEqual(stageCountdown(start, 0, epoch + 86400000), { state: "complete", tone: "paused", remainingSeconds: 0 });
});
test("warning begins at twenty minutes remaining", () => {
  assert.equal(stageCountdown(start, 60, epoch + 2399000).tone, "ok");
  assert.equal(stageCountdown(start, 60, epoch + 2400000).tone, "due");
});
test("invalid or future timestamps cannot show misleading active timers", () => {
  for (const args of [["invalid", 60, epoch], [start, NaN, epoch], [start, -1, epoch], [start, 60, NaN], [start, 60, epoch - 1]]) {
    assert.deepEqual(stageCountdown(...args), { state: "unavailable", tone: "paused", remainingSeconds: 0 });
  }
});
test("a new workflow event restarts the timer from its own timestamp", () => {
  const next = new Date(epoch + 7200000).toISOString();
  assert.equal(stageCountdown(start, 60, epoch + 7200000).state, "overdue");
  assert.equal(stageCountdown(next, 45, epoch + 7200000).remainingSeconds, 2700);
});
