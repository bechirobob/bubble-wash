import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observePrefetches } from './browser/prefetch-lifecycle.mjs';

test('navigation guard waits for real RSC completion and a stable period without altering requests', () => {
  const page = new EventEmitter();
  let time = 0;
  const events = [];
  const tracker = observePrefetches(page, event => events.push(event), () => time);
  const rsc = { url: () => 'http://localhost:3100/support?view=orders&_rsc=private-query' };
  const other = { url: () => 'http://localhost:3100/api/orders' };
  page.emit('request', other);
  time = 500; assert.equal(tracker.settled(), true);
  tracker.setPhase('reload');
  page.emit('request', rsc);
  time = 5000; assert.equal(tracker.settled(), false);
  page.emit('requestfinished', rsc);
  time = 5499; assert.equal(tracker.settled(), false);
  time = 5500; assert.equal(tracker.settled(), true);
  page.emit('request', rsc);
  page.emit('requestfailed', rsc);
  assert.equal(tracker.settled(), false);
  time += 500; assert.equal(tracker.settled(), true);
  assert.equal(events.at(-1).event, 'rsc-failed');
  assert.ok(!JSON.stringify(events).includes('private-query'));
  assert.ok(!JSON.stringify(events).includes('view='));
  assert.equal(tracker.phase(), 'reload');
});


test('each navigation guard starts a fresh quiet window and captures delayed hydration prefetch', () => {
  const page = new EventEmitter();
  let time = 0;
  const tracker = observePrefetches(page, () => {}, () => time);
  const request = { url: () => 'http://localhost:3100/vendors?_rsc=synthetic' };
  // Previous document finished long ago. This must not immediately unlock reload.
  time = 5000;
  assert.equal(tracker.settled(), true);
  tracker.arm();
  assert.equal(tracker.settled(), false);
  time += 1;
  page.emit('request', request);
  time += 15000;
  assert.equal(tracker.settled(), false, 'No timeout or arm fabricates request completion');
  tracker.arm();
  assert.equal(tracker.settled(), false, 'Arming never clears an unresolved request');
  page.emit('requestfailed', request);
  time += 499;
  assert.equal(tracker.settled(), false);
  time += 1;
  assert.equal(tracker.settled(), true, 'Actual canceled request event removes it');
  tracker.arm();
  assert.equal(tracker.settled(), false, 'Every next navigation must wait anew');
  time += 500;
  assert.equal(tracker.settled(), true);
});
