// Observe actual Next RSC requests without changing, cancelling, or suppressing them.
export function observePrefetches(page, report, now = Date.now) {
  const pending = new Set();
  let changedAt = now();
  let phase = 'initial';
  const relevant = request => {
    const url = new URL(request.url());
    return url.origin === 'http://localhost:3100' && url.searchParams.has('_rsc');
  };
  page.on('request', request => {
    if (!relevant(request)) return;
    pending.add(request); changedAt = now();
    report({ event: 'rsc-start', path: new URL(request.url()).pathname, phase, pending: pending.size });
  });
  const finish = (request, event) => {
    if (!pending.delete(request)) return;
    changedAt = now();
    report({ event, path: new URL(request.url()).pathname, phase, pending: pending.size });
  };
  page.on('requestfinished', request => finish(request, 'rsc-finished'));
  page.on('requestfailed', request => finish(request, 'rsc-failed'));
  return {
    settled: () => pending.size === 0 && now() - changedAt >= 500,
    phase: () => phase,
    // Start a fresh quiet window at every guard entry. Historical idle time from
    // the previous document must not let hydration's new prefetches race a reload.
    arm() { changedAt = now(); },
    setPhase(value) { phase = value; report({ event: 'phase', phase, pending: pending.size }); },
  };
}
