"use client";

import { Children, cloneElement, isValidElement, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactElement, type ReactNode } from "react";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { listWindow } from "@/lib/list-window";

type Props = { label: string; children: ReactNode; className?: string; resetKey?: string; pageSize?: number; noun?: string; header?: ReactNode; loading?: boolean; emptyState?: ReactNode; as?: "div" | "dl" };

/** Pass keyed native row elements. Hidden pages stay mounted so row drafts survive. */
export function BoundedList({ label, children, className = "", resetKey = "", pageSize = 10, noun = "items", header, loading = false, emptyState, as: Content = "div" }: Props) {
  const rows = Children.toArray(children).filter(isValidElement) as ReactElement<HTMLAttributes<HTMLElement>>[];
  const [position, setPosition] = useState({ scope: resetKey, page: 0 });
  const [focusedKey, setFocusedKey] = useState<{ scope: string; key: string } | null>(null);
  const region = useRef<HTMLDivElement>(null);
  const id = useId();
  const focusedIndex = focusedKey?.scope !== resetKey ? -1 : rows.findIndex(row => String(row.key) === focusedKey.key);
  const normalizedSize = listWindow(rows.length, 0, pageSize).pageSize;
  const requestedPage = focusedIndex >= 0 ? Math.floor(focusedIndex / normalizedSize) : position.scope === resetKey ? position.page : 0;
  const window = listWindow(rows.length, requestedPage, pageSize);
  useLayoutEffect(() => {
    const viewport = region.current;
    if (!viewport || !focusedKey) return;
    const active = document.activeElement;
    // A refreshed/filter-removed row must not strand keyboard focus on the body
    // or inside a hidden page. Never take focus back from a filter/control.
    if (active === document.body || (viewport.contains(active) && active?.closest("[hidden]"))) {
      viewport.focus({ preventScroll: true });
      return;
    }
    if (focusedIndex < 0 || !active || !viewport.contains(active)) return;
    const bounds = viewport.getBoundingClientRect(), item = active.getBoundingClientRect();
    if (item.top < bounds.top) viewport.scrollTop += item.top - bounds.top;
    else if (item.bottom > bounds.bottom) viewport.scrollTop += item.bottom - bounds.bottom;
  }, [focusedKey, focusedIndex, resetKey, window.page]);
  function changePage(page: number) {
    setFocusedKey(null);
    setPosition({ scope: resetKey, page });
    if (region.current) { region.current.scrollTop = 0; region.current.focus({ preventScroll: true }); }
  }
  if (loading && !rows.length) return <LoadingSkeleton label={`Loading ${label.toLowerCase()}`} rows={3} />;
  return <div className="boundedList">
    <p className="boundedListRange" id={`${id}-range`} role="status" aria-live="polite">{window.total ? `${window.start + 1}–${window.end} of ${window.total} ${noun} loaded` : `No ${noun} to show`}</p>
    <div className="boundedListViewport" ref={region} role="region" aria-label={label} aria-describedby={`${id}-range ${id}-hint`} tabIndex={window.total ? 0 : -1}
      onFocusCapture={event => { const row = (event.target as HTMLElement).closest<HTMLElement>("[data-list-row-key]"); setFocusedKey(row?.dataset.listRowKey ? { scope: resetKey, key: row.dataset.listRowKey } : null); }}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setPosition({ scope: resetKey, page: window.page }); setFocusedKey(null); } }}>
      {rows.length ? <Content className={className} role={Content === "dl" ? undefined : "list"}>{header}{rows.map((row, index) => cloneElement(row, { role: Content === "dl" ? undefined : "listitem", hidden: index < window.start || index >= window.end, "data-list-row-key": String(row.key) } as HTMLAttributes<HTMLElement>))}</Content> : emptyState}
    </div>
    <small className="boundedListHint" id={`${id}-hint`}>{window.total ? "Scroll within this list. Tab moves to the next control." : ""}</small>
    {window.pages > 1 ? <nav className="boundedListPages" aria-label={`${label} pages`}>
      <button className="button secondary" type="button" aria-label={`Previous page of ${label}`} disabled={window.page === 0} onClick={() => changePage(window.page - 1)}>Previous</button>
      <span>Page {window.page + 1} of {window.pages}</span>
      <button className="button secondary" type="button" aria-label={`Next page of ${label}`} disabled={window.page + 1 === window.pages} onClick={() => changePage(window.page + 1)}>Next</button>
    </nav> : null}
  </div>;
}
