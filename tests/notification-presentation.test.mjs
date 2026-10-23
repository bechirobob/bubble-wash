import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notificationStatusLabel } from '../src/lib/notification-presentation.ts';
test('provider acceptance is never represented as delivered',()=>{
  for(const status of ['accepted','sent']) assert.equal(notificationStatusLabel(status),'Provider accepted; delivery unverified');
  assert.equal(notificationStatusLabel('delivered'),'Delivery confirmed');
});
test('queued, uncertain, skipped and missing outcomes stay distinct',()=>{
  assert.match(notificationStatusLabel('queued'),/queued/);
  assert.match(notificationStatusLabel('retrying'),/Retry pending/);
  assert.match(notificationStatusLabel('manual_review'),/uncertain/);
  assert.match(notificationStatusLabel('skipped'),/Not sent/);
  assert.match(notificationStatusLabel(undefined),/Not sent/);
  assert.equal(notificationStatusLabel('not_requested'),'Not requested');
});
