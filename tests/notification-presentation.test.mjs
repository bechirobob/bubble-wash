import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notificationStatusLabel } from '../src/lib/notification-presentation.ts';
test('provider acceptance is never represented as delivered',()=>{
  for(const status of ['accepted','sent']) assert.equal(notificationStatusLabel(status),'Delivery service accepted; delivery not confirmed');
  assert.equal(notificationStatusLabel('delivered'),'Delivery confirmed');
});
test('queued, uncertain, skipped and missing outcomes stay distinct',()=>{
  assert.match(notificationStatusLabel('queued'),/Waiting to send; not delivered yet/);
  assert.match(notificationStatusLabel('retrying'),/Waiting to try again/);
  assert.match(notificationStatusLabel('manual_review'),/uncertain/);
  assert.match(notificationStatusLabel('skipped'),/Not sent/);
  assert.match(notificationStatusLabel(undefined),/Not sent/);
  assert.equal(notificationStatusLabel('not_requested'),'Not requested');
});
