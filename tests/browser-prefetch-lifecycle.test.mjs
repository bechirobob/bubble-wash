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

test('dispatch GET blocks navigation through body completion while other origins and writes are excluded', () => {
  const page = new EventEmitter(); let time = 0; const events = [];
  const tracker = observePrefetches(page, event => events.push(event), () => time);
  const request = (origin, method) => ({ url: () => origin + '/api/dispatch/location?private=omitted', method: () => method });
  page.emit('request', request('https://outside.invalid', 'GET'));
  page.emit('request', request('http://localhost:3100', 'POST'));
  time = 500; assert.equal(tracker.settled(), true);
  const read = request('http://localhost:3100', 'GET'); page.emit('request', read);
  page.emit('response', { request: () => read, status: () => 200 });
  time = 5000; assert.equal(tracker.settled(), false, 'Headers alone do not finish a read');
  tracker.arm(); assert.equal(tracker.settled(), false);
  page.emit('requestfinished', read);
  time += 499; assert.equal(tracker.settled(), false);
  time++; assert.equal(tracker.settled(), true);
  assert.equal(tracker.dispatchFailures(), 0);
  assert.deepEqual(events.filter(e => e.event.startsWith('dispatch')).map(e => e.event), ['dispatch-start', 'dispatch-response', 'dispatch-finished']);
  assert.ok(!JSON.stringify(events).includes('private'));
});

test('failed or HTTP-error dispatch reads are not success and remain counted beyond bounded diagnostics', () => {
  const page = new EventEmitter(); let time = 0; const events = [];
  const tracker = observePrefetches(page, event => events.push(event), () => time);
  for (let i = 0; i < 25; i++) {
    const read = { url: () => 'http://localhost:3100/api/dispatch/location', method: () => 'GET' };
    page.emit('request', read);
    if (i === 24) page.emit('requestfailed', read);
    else { page.emit('response', { request: () => read, status: () => i === 23 ? 503 : 200 }); page.emit('requestfinished', read); }
  }
  time = 500;
  assert.equal(tracker.settled(), true, 'Idle is separate from successful');
  assert.equal(tracker.dispatchFailures(), 2);
  assert.equal(events.length, 40);
  tracker.arm(); assert.equal(tracker.dispatchFailures(), 2, 'Guard arming cannot erase failures');
});
