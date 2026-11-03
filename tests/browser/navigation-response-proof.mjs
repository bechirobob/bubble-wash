// Observe the existing consumer only: no clones, extra reads, retries or replacement responses.
export async function observeNavigationResponse(page, pathname) {
  await page.addInitScript(({ pathname }) => {
    const records = [], streams = new WeakMap(), readers = new WeakMap();
    Object.defineProperty(window, '__bubbleNavigationResponseProof', { value: records });
    const fetch = window.fetch;
    window.fetch = function (input, options) {
      const url = new URL(input instanceof Request ? input.url : input, location.href);
      const headers = new Headers(options?.headers ?? (input instanceof Request ? input.headers : undefined));
      const match = url.origin === 'http://localhost:3100' && url.pathname === pathname && url.searchParams.has('_rsc') && headers.get('rsc') === '1' && !headers.has('next-router-prefetch') && (options?.method ?? (input instanceof Request ? input.method : 'GET')) === 'GET';
      const record = match && records.length < 16 ? { url: url.href, status: 0, bytes: 0, complete: false, failed: false, cancelled: false } : null;
      if (record) records.push(record);
      const result = fetch.apply(this, arguments);
      if (record) result.then(response => {
        record.status = response.status;
        if (response.body) streams.set(response.body, record);
        else record.failed = true;
      }, () => { record.failed = true; });
      return result;
    };
    const getReader = ReadableStream.prototype.getReader;
    ReadableStream.prototype.getReader = function () {
      const reader = getReader.apply(this, arguments), record = streams.get(this);
      if (record) readers.set(reader, record);
      return reader;
    };
    const read = ReadableStreamDefaultReader.prototype.read;
    ReadableStreamDefaultReader.prototype.read = function () {
      const record = readers.get(this), result = read.apply(this, arguments);
      if (record) result.then(chunk => {
        if (chunk.done) record.complete = true;
        else record.bytes += chunk.value.byteLength;
      }, () => { record.failed = true; });
      return result;
    };
    for (const [prototype, map] of [[ReadableStream.prototype, streams], [ReadableStreamDefaultReader.prototype, readers]]) {
      const cancel = prototype.cancel;
      prototype.cancel = function () {
        const record = map.get(this);
        if (record) record.cancelled = true;
        return cancel.apply(this, arguments);
      };
    }
  }, { pathname });
}

export function provesCompletedNavigation(event, receipt, requestCount) {
  return event.kind === 'requestfailed' && event.failure === 'net::ERR_ABORTED' &&
    event.method === 'GET' && event.resource === 'fetch' && !event.external && !event.navigation &&
    event.rscQuery === true && event.rscHeader === '1' && event.prefetchHeader === '' &&
    requestCount === 1 && receipt?.status === 200 && receipt.complete === true &&
    receipt.bytes > 0 && receipt.failed === false && receipt.cancelled === false;
}
