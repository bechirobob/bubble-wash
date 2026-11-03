// Observe actual RSC and dispatch GET lifecycles without changing requests.
export function observePrefetches(page, report, now = Date.now) {
  const pending = new Map();
  let changedAt = now();
  let phase = 'initial';
  let dispatchFailures = 0;
  let dispatchEvents = 0;
  let dispatchSequence = 0;
  const kind = request => {
    const url = new URL(request.url());
    if (url.origin !== 'http://localhost:3100') return null;
    if (url.pathname === '/api/dispatch/location' && request.method() === 'GET') return 'dispatch';
    return url.searchParams.has('_rsc') ? 'rsc' : null;
  };
  function emit(request, detail, event, extra = {}) {
    // Count every failure, but bound diagnostic output and omit query/body data.
    if (detail.kind === 'dispatch' && dispatchEvents++ >= 40) return;
    report({ event, path: new URL(request.url()).pathname, phase, pending: pending.size,
      ...(detail.kind === 'dispatch' ? { request: detail.id, method: 'GET' } : {}), ...extra });
  }
  page.on('request', request => {
    const type = kind(request);
    if (!type) return;
    const detail = { kind: type, id: type === 'dispatch' ? ++dispatchSequence : 0 };
    pending.set(request, detail); changedAt = now();
    emit(request, detail, type + '-start');
  });
  page.on('response', response => {
    const request = response.request(), detail = pending.get(request);
    if (detail?.kind !== 'dispatch') return;
    const status = response.status();
    if (status >= 400) dispatchFailures++;
    emit(request, detail, 'dispatch-response', { status });
  });
  const finish = (request, outcome) => {
    const detail = pending.get(request);
    if (!detail) return;
    pending.delete(request);
    changedAt = now();
    if (detail.kind === 'dispatch' && outcome === 'failed') dispatchFailures++;
    emit(request, detail, detail.kind + '-' + outcome);
  };
  page.on('requestfinished', request => finish(request, 'finished'));
  page.on('requestfailed', request => finish(request, 'failed'));
  return {
    // Settled means transport idle, never proof that its responses succeeded.
    settled: () => pending.size === 0 && now() - changedAt >= 500,
    dispatchFailures: () => dispatchFailures,
    phase: () => phase,
    arm() { changedAt = now(); },
    setPhase(value) { phase = value; report({ event: 'phase', phase, pending: pending.size }); },
  };
}
