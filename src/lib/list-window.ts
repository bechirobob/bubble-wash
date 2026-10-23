/** A bounded window over already-loaded rows; never changes the server query. */
export function listWindow(total: number, requestedPage: number, size = 10) {
  const pageSize = Number.isFinite(size) ? Math.max(1, Math.floor(size)) : 10;
  const count = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const pages = Math.max(1, Math.ceil(count / pageSize));
  const page = Number.isFinite(requestedPage) ? Math.max(0, Math.min(pages - 1, Math.floor(requestedPage))) : 0;
  const start = page * pageSize;
  return { page, pages, pageSize, start, end: Math.min(count, start + pageSize), total: count };
}
