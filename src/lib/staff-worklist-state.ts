/** Keep an unsaved editor visible if refresh removes its item from this filter.
 * The retained row is read-only until an explicit reload checks current access.
 * No drafts or authentication state are persisted to browser storage. */
export function mergeWorklistRefresh<T extends { id: string; canManage: boolean }>(incoming: T[], previous: T[], dirtyIds: ReadonlySet<string>): Array<T & { outOfView?: boolean }> {
  const incomingIds = new Set(incoming.map((item) => item.id));
  return [...incoming, ...previous.filter((item) => dirtyIds.has(item.id) && !incomingIds.has(item.id)).map((item) => ({ ...item, canManage: false, outOfView: true }))];
}

/** Tab-memory only; callers use the authenticated actor as the scope. */
export function createWorklistDraftCache<T>() {
  const scopes = new Map<string, Map<string, T>>();
  return {
    get(scope: string, id: string) { return scopes.get(scope)?.get(id); },
    set(scope: string, id: string, draft: T) { const rows = scopes.get(scope) ?? new Map<string, T>(); rows.set(id, draft); scopes.set(scope, rows); },
    delete(scope: string, id: string) { const rows = scopes.get(scope); rows?.delete(id); if (!rows?.size) scopes.delete(scope); },
    deleteIfUnchanged(scope: string, id: string, expected: T | undefined) {
      const rows = scopes.get(scope); if (rows?.get(id) !== expected) return false;
      rows?.delete(id); if (!rows?.size) scopes.delete(scope); return true;
    },
    entries(scope: string) { return [...(scopes.get(scope)?.entries() ?? [])]; },
  };
}

export function shouldGuardWorklistLink(input: { currentHref: string; nextHref: string; target?: string; download?: boolean; button?: number; defaultPrevented?: boolean; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }) {
  if (input.defaultPrevented || (input.button ?? 0) !== 0 || input.metaKey || input.ctrlKey || input.shiftKey || input.altKey || input.download || input.target && input.target !== "_self") return false;
  const current = new URL(input.currentHref), next = new URL(input.nextHref, current);
  return ["http:", "https:"].includes(next.protocol) && (current.origin !== next.origin || current.pathname !== next.pathname || current.search !== next.search);
}
