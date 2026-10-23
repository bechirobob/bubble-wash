"use client";

import Link from "next/link";
import { BoundedList } from "./BoundedList";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { StaffRole } from "@/lib/auth";
import type { dispatchRecommendations } from "@/lib/operations-automation";
import { PortalShell } from "./StaffWorkspaces";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { createWorklistDraftCache, mergeWorklistRefresh, shouldGuardWorklistLink } from "@/lib/staff-worklist-state";
import { notificationStatusLabel } from "@/lib/notification-presentation";
import styles from "./StaffWorklistWorkspace.module.css";

type User = { email: string; name: string; role: StaffRole; allStaffAccess?: boolean };
type WorkItem = { outOfView?: boolean; id: string; kind: string; targetId: string; title: string; detail: string; priority: string; dueAt: string; operationalDueAt?: string; signalVersion: string; ownerEmail: string; ownerActive?: boolean; note: string; revision: number; updatedAt: string; overdue: boolean; canManage: boolean };
type OwnershipDraft = { snapshot: WorkItem; owner: string; due: string; note: string; command: { fingerprint: string; body: Record<string, unknown> } | null };
const draftCache = createWorklistDraftCache<OwnershipDraft>();
const actorScope = (user: User) => `${user.email.toLowerCase()}:${user.role}`;
type Assignee = { name: string; email: string; role: string };
type Worklist = { items: WorkItem[]; nextOffset: number | null; scope: string; generatedAt: string };
type Reconciliation = { items: { orderId: string; invoiceId: string; balanceMinor: number | null; currency: string; reasons: string[] }[]; nextOffset: number | null; scope: string };
type Notifications = { items: { id: string; channel: string; target: string; state: string; attempts: number; createdAt: string; updatedAt: string }[]; nextOffset: number | null; summary: Record<string, number>; policy: string };
type Dispatch = ReturnType<typeof dispatchRecommendations>;
class RequestError extends Error { constructor(message: string, public status: number) { super(message); } }
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new RequestError(data.error || "Unable to load. Try again.", response.status);
  return data as T;
}
const dateLabel = (value: string) => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "No deadline set";
const localDate = (value: string) => { if (!value || !Number.isFinite(Date.parse(value))) return ""; const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
const home = (role: StaffRole) => ({ admin: "/admin", support: "/support", vendor: "/vendors", driver: "/drivers" })[role];
function recordHref(item: WorkItem, role: StaffRole) {
  if (item.kind === "vendor-capacity") return role === "admin" ? "/admin?view=people" : "/vendors?view=capacity";
  if (item.kind === "case-followup") return `${home(role)}?view=cases&case=${encodeURIComponent(item.targetId)}`;
  return `${home(role)}?view=${role === "vendor" ? "jobs" : role === "driver" ? "route" : "orders"}&order=${encodeURIComponent(item.targetId)}`;
}

function OwnershipEditor({ item, user, assignees, onSaved, onDirty }: { item: WorkItem; user: User; assignees: Assignee[]; onSaved: () => void; onDirty: (id: string, dirty: boolean) => void }) {
  const scope = actorScope(user);
  const cached = draftCache.get(scope, item.id);
  const [snapshot, setSnapshot] = useState(cached?.snapshot ?? item);
  const [owner, setOwner] = useState(cached?.owner ?? item.ownerEmail);
  const [due, setDue] = useState(cached?.due ?? localDate(item.dueAt));
  const [note, setNote] = useState(cached?.note ?? item.note);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [conflict, setConflict] = useState(false);
  const [inactive, setInactive] = useState(false);
  const command = useRef<OwnershipDraft["command"]>(cached?.command ?? null);
  const saving = useRef(false);
  const dirty = owner !== snapshot.ownerEmail || due !== localDate(snapshot.dueAt) || note !== snapshot.note;
  const stale = conflict || item.revision !== snapshot.revision || item.signalVersion !== snapshot.signalVersion;
  useEffect(() => {
    if (dirty) draftCache.set(scope, item.id, { snapshot, owner, due, note, command: command.current });
    else draftCache.delete(scope, item.id);
    onDirty(item.id, dirty); return () => onDirty(item.id, false);
  }, [dirty, item.id, onDirty, scope, snapshot, owner, due, note]);
  async function reload() {
    const reloadDraft = draftCache.get(scope, item.id);
    setPending(true);
    try {
      const result = await request<Worklist>(`/api/staff/automation/worklist?itemId=${encodeURIComponent(item.id)}`);
      const latest = result.items[0];
      if (!latest) { setInactive(true); setStatus("This item is no longer active. Open the record to review its current state."); onDirty(item.id, false); draftCache.deleteIfUnchanged(scope, item.id, reloadDraft); return; }
      setSnapshot(latest); setOwner(latest.ownerEmail); setDue(localDate(latest.dueAt)); setNote(latest.note); setConflict(false); command.current = null;
      draftCache.deleteIfUnchanged(scope, item.id, reloadDraft); setStatus("Latest values loaded."); onSaved();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Unable to refresh."); }
    finally { setPending(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (saving.current || stale || inactive || !dirty) return;
    const timestamp = new Date(due);
    if (!Number.isFinite(timestamp.getTime())) { setStatus("Choose a valid follow-up deadline."); return; }
    const payload = { itemId: item.id, ownerEmail: owner, dueAt: timestamp.toISOString(), note, expectedRevision: snapshot.revision, signalVersion: snapshot.signalVersion };
    const fingerprint = JSON.stringify(payload);
    if (!command.current || command.current.fingerprint !== fingerprint) command.current = { fingerprint, body: { ...payload, idempotencyKey: crypto.randomUUID() } };
    const submittedDraft = { snapshot, owner, due, note, command: command.current };
    draftCache.set(scope, item.id, submittedDraft);
    saving.current = true; setPending(true); setStatus("Saving owner and deadline…");
    try {
      const result = await request<{ revision: number; message: string }>("/api/staff/automation/ownership", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command.current.body) });
      setSnapshot({ ...snapshot, ownerEmail: owner, dueAt: payload.dueAt, note, revision: result.revision });
      setStatus(result.message); command.current = null; draftCache.deleteIfUnchanged(scope, item.id, submittedDraft); onDirty(item.id, false); onSaved();
    } catch (error) {
      if (error instanceof RequestError && error.status === 409) setConflict(true);
      setStatus(error instanceof RequestError ? error.message : "Save could not be confirmed. Retry the same details; duplicate saves are protected.");
    } finally { saving.current = false; setPending(false); }
  }
  const forbidden = !item.canManage;
  return <form className={styles.editor} onSubmit={save} aria-label={`Owner and deadline for ${item.targetId}`}>
    {forbidden ? <p className="status warning">{item.outOfView ? "This item left the current worklist. Your draft stays visible. Open the record or load latest values before continuing." : "Another staff member is responsible for this task. Your draft is still here. Ask an admin to reassign it."}</p> : null}<div className="two"><label>Owner<select value={owner} onChange={(event) => setOwner(event.target.value)} disabled={pending || inactive || forbidden}><option value="">Unassigned</option>{owner && !assignees.some((person) => person.email.toLowerCase() === owner) ? <option value={owner}>{owner} (not available)</option> : null}{assignees.map((person) => <option key={person.email} value={person.email.toLowerCase()}>{person.name} · {person.email}</option>)}</select></label><label>Follow-up deadline<input type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} required disabled={pending || inactive || forbidden} /><small>Local time: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Within 30 days.</small></label></div>
    <label>Next step<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={600} required disabled={pending || inactive || forbidden} /></label>
    {stale ? <p className="status warning" role="status">This item changed. Your draft is still here. Load the latest values before saving.</p> : null}
    <div className={styles.actions}><button className="button primary" disabled={pending || stale || inactive || forbidden || !dirty} type="submit">{pending ? "Working…" : "Save owner and deadline"}</button><button className="button" type="button" disabled={pending} onClick={reload}>Load latest values{dirty ? " (discard draft)" : ""}</button></div>
    {status ? <p className="status" role="status">{status}</p> : null}
  </form>;
}

function PageLinks({ view, filter, offset, nextOffset }: { view: string; filter: string; offset: number; nextOffset: number | null }) {
  const url = (value: number) => `/staff/worklist?view=${view}&filter=${filter}&offset=${value}`;
  return <nav className={styles.pagination} aria-label="More worklist records">{offset > 0 ? <Link href={url(Math.max(0, offset - (view === "notifications" ? 50 : 100)))}>Newer records</Link> : <span>Newest records</span>}{nextOffset !== null ? <Link href={url(nextOffset)}>Older records</Link> : <span>No older records</span>}</nav>;
}

export function StaffWorklistWorkspace({ user, view, filter, offset, orderId }: { user: User; view: string; filter: string; offset: number; orderId: string }) {
  const [worklist, setWorklist] = useState<Worklist | null>(null);
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);
  const [notifications, setNotifications] = useState<Notifications | null>(null);
  const [dispatch, setDispatch] = useState<Dispatch | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [assigneeError, setAssigneeError] = useState("");
  const [pending, setPending] = useState(!(view === "dispatch" && !orderId));
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  const dirtyItems = useRef(new Set<string>());
  const onDirty = useCallback((id: string, dirty: boolean) => { if (dirty) dirtyItems.current.add(id); else dirtyItems.current.delete(id); }, []);
  const refresh = useCallback(() => { if (view === "dispatch" && !orderId) return; setPending(true); setGeneration((value) => value + 1); }, [view, orderId]);
  const endpoint = `/api/staff/automation/${view}?offset=${offset}&filter=${filter}${view === "dispatch" ? `&orderId=${encodeURIComponent(orderId)}` : ""}`;
  useEffect(() => {
    // Navigation asks before leaving an unsaved draft; refresh never clears it.
    function beforeUnload(event: BeforeUnloadEvent) { if (dirtyItems.current.size || draftCache.entries(actorScope(user)).length) { event.preventDefault(); event.returnValue = ""; } }
    function beforeNavigate(event: MouseEvent) {
      const target = event.target instanceof Element ? event.target.closest("a") : null;
      if (!target || !shouldGuardWorklistLink({ currentHref: window.location.href, nextHref: target.href, target: target.target, download: target.hasAttribute("download"), button: event.button, defaultPrevented: event.defaultPrevented, metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey }) || !(dirtyItems.current.size || draftCache.entries(actorScope(user)).length)) return;
      if (!window.confirm("Leave this worklist and discard unsaved owner/deadline changes?")) { event.preventDefault(); event.stopPropagation(); }
      else { for (const [id] of draftCache.entries(actorScope(user))) draftCache.delete(actorScope(user), id); dirtyItems.current.clear(); }
    }
    window.addEventListener("beforeunload", beforeUnload); document.addEventListener("click", beforeNavigate, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", beforeNavigate, true); };
  }, [user]);
  useEffect(() => {
    const controller = new AbortController();
    if (view === "dispatch" && !orderId) return () => controller.abort();
    request<Worklist & Reconciliation & Notifications & Dispatch>(endpoint, { signal: controller.signal }).then((data) => {
      if (controller.signal.aborted) return;
      setError("");
      if (view === "worklist") setWorklist((previous) => ({ ...data, items: mergeWorklistRefresh<WorkItem>(data.items, [...(previous?.items || []), ...draftCache.entries(actorScope(user)).filter(([id]) => !previous?.items.some((item) => item.id === id)).map(([, draft]) => draft.snapshot)], new Set([...dirtyItems.current, ...draftCache.entries(actorScope(user)).map(([id]) => id)])) })); else if (view === "reconciliation") setReconciliation(data); else if (view === "notifications") setNotifications(data); else setDispatch(data);
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load. Try again."); }).finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [endpoint, generation, view, orderId, user]);
  useEffect(() => {
    if (!["admin", "support"].includes(user.role)) return;
    const controller = new AbortController();
    request<{ assignees: Assignee[] }>("/api/staff/automation/assignees", { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) { setAssignees(data.assignees); setAssigneeError(""); } }).catch(() => { if (!controller.signal.aborted) setAssigneeError("Unable to load owner choices. Refresh to retry."); });
    return () => controller.abort();
  }, [user.role, generation]);
  const navigation = [{ href: home(user.role), label: "Workspace", view: "home" }, { href: "/staff/worklist", label: "Worklist", view: "worklist" }, ...(user.role === "admin" ? [{ href: "/staff/worklist?view=dispatch", label: "Assignment options", view: "dispatch" }, { href: "/staff/worklist?view=reconciliation", label: "Payment review", view: "reconciliation" }, { href: "/staff/worklist?view=notifications", label: "Message review", view: "notifications" }] : [])];
  const hasData = view === "worklist" ? worklist : view === "dispatch" ? dispatch : view === "notifications" ? notifications : reconciliation;
  return <PortalShell heading={view === "dispatch" ? { eyebrow: "Dispatch review", title: "Available assignment options", subtitle: "Check service areas, available slots, and when capacity was last confirmed." } : undefined} role={user.role} allStaffAccess={user.allStaffAccess} userName={user.name} title="Staff worklist" currentView={view} navigation={navigation}>
    <section className={`staffContentSection ${styles.workspace}`}>
      <div className={styles.toolbar}><h2>{view === "worklist" ? "Tasks and follow-ups" : view === "dispatch" ? "Assignment options" : view === "reconciliation" ? "Payments to check" : "Messages needing review"}</h2><button className="button" type="button" onClick={refresh} disabled={pending}>{pending ? "Refreshing…" : "Refresh"}</button></div>
      {view === "worklist" ? <nav className={styles.filters} aria-label="Worklist filters">{[...[{ value: "action", label: "Needs action" }, { value: "all", label: "All" }, { value: "overdue", label: "Overdue" }], ...(["admin", "support"].includes(user.role) ? [{ value: "mine", label: "Mine" }, { value: "unassigned", label: "Unassigned" }, { value: "followups", label: "Follow-ups" }] : [])].map(({ value, label }) => <Link key={value} href={`/staff/worklist?filter=${value}`} aria-current={filter === value ? "page" : undefined}>{label}</Link>)}</nav> : null}
      {view === "dispatch" ? <form action="/staff/worklist" className={styles.lookup}><input type="hidden" name="view" value="dispatch" /><label>Order reference<input name="order" defaultValue={orderId} placeholder="BW-…" required maxLength={160} /></label><button className="button primary" type="submit">Show available options</button></form> : null}
      {assigneeError && view === "worklist" ? <p className="status warning" role="status">{assigneeError}</p> : null}
      {error ? <p className="status error" role="alert">{error} <button type="button" onClick={refresh}>Retry</button></p> : null}
      {pending && !hasData ? <LoadingSkeleton label="Loading operational worklist" /> : null}
      {hasData && pending ? <p className="formHint" role="status">Refreshing. Your list and unsaved changes stay visible.</p> : null}
      {view === "worklist" && worklist ? <><p className="formHint">{worklist.scope}. Updated {dateLabel(worklist.generatedAt)}.</p><BoundedList label="Worklist" noun="tasks" className={styles.rows} resetKey={`${filter}:${offset}:${orderId}`}>{worklist.items.map((item) => <article className={styles.row} key={item.id}><div className={styles.rowHeader}><div><strong>{item.title}</strong><p>{item.targetId}</p></div><span className={item.overdue ? "status warning" : "formHint"}>{item.overdue ? "Overdue · " : ""}{dateLabel(item.dueAt)}</span></div><p>{item.detail}</p>{["admin", "support"].includes(user.role) ? <p className="formHint">Owner: {item.ownerEmail || "Unassigned"}{item.ownerActive === false ? " · no longer active" : ""}{item.operationalDueAt && item.operationalDueAt !== item.dueAt ? ` · Order deadline: ${dateLabel(item.operationalDueAt)}` : ""}</p> : null}<div className={styles.actions}><Link href={recordHref(item, user.role)}>Open {item.kind === "case-followup" ? "case" : item.kind === "vendor-capacity" ? "capacity" : "order"}</Link>{user.role === "admin" && item.kind === "order-unassigned" ? <Link href={`/staff/worklist?view=dispatch&order=${encodeURIComponent(item.targetId)}`}>Review assignment options</Link> : null}</div>{["admin", "support"].includes(user.role) ? <details className={styles.details} open={draftCache.get(actorScope(user), item.id) ? true : undefined}><summary>Owner and follow-up deadline</summary><OwnershipEditor item={item} user={user} assignees={assignees} onSaved={refresh} onDirty={onDirty} /></details> : null}</article>)}</BoundedList>{!worklist.items.length ? <p className={styles.empty}>No matching work on this page.{worklist.nextOffset !== null ? " Continue to the next page for older records." : ""}</p> : null}<PageLinks view={view} filter={filter} offset={offset} nextOffset={worklist.nextOffset} /></> : null}
      {view === "dispatch" && dispatch ? <><p className="formHint">{dispatch.policy}</p><p>Order {dispatch.orderId} · Checked {dateLabel(dispatch.generatedAt)}. {dispatch.assignmentAvailable ? "Review and confirm in the existing order action." : "Assignment is not available at this order stage."}</p><Link href={`/admin?view=orders&order=${encodeURIComponent(dispatch.orderId)}`}>Open order and assignment action</Link><h3>Vendors</h3><BoundedList label="Vendor options" noun="vendors" className={styles.rows} resetKey={`${filter}:${offset}:${orderId}`}>{dispatch.vendors.map((vendor) => <article className={styles.row} key={vendor.vendorId}><div className={styles.rowHeader}><strong>{vendor.name}</strong><span>{vendor.recommended ? "Available · capacity confirmed" : vendor.eligible ? "Available · confirm capacity first" : "Not available"}</span></div><p>{vendor.capacityRemaining} remaining slots · Capacity {vendor.freshness.fresh ? "recently confirmed" : vendor.freshness.confirmedAt ? "needs an update" : "not confirmed"}{vendor.freshness.confirmedAt ? ` ${dateLabel(vendor.freshness.confirmedAt)}` : ""}</p>{vendor.reasons.length ? <ul>{vendor.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}</article>)}</BoundedList>{!dispatch.vendors.length ? <p className={styles.empty}>No matching vendors. Check approved service areas and services in People.</p> : null}<h3>Drivers</h3><BoundedList label="Rider options" noun="riders" className={styles.rows} resetKey={`${filter}:${offset}:${orderId}`}>{dispatch.drivers.map((driver) => <article className={styles.row} key={driver.driverId}><div className={styles.rowHeader}><strong>{driver.name}</strong><span>{driver.eligible ? "Available" : "Not available"}</span></div><p>{driver.capacityRemaining} remaining slots</p>{driver.reasons.length ? <ul>{driver.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}</article>)}</BoundedList>{!dispatch.drivers.length ? <p className={styles.empty}>No matching riders. Check approved service areas in People.</p> : null}</> : null}
      {view === "reconciliation" && reconciliation ? <><p className="formHint">{reconciliation.scope} Check the invoice and related case before deciding what to do.</p><BoundedList label="Payment review" noun="orders" className={styles.rows} resetKey={`${filter}:${offset}:${orderId}`}>{reconciliation.items.map((item) => <article className={styles.row} key={item.orderId}><div className={styles.rowHeader}><strong>{item.orderId}</strong><span>{item.balanceMinor === null ? "No invoice" : new Intl.NumberFormat(undefined, { style: "currency", currency: item.currency }).format(item.balanceMinor / 100)}</span></div>{item.invoiceId ? <p>Invoice {item.invoiceId}</p> : null}<ul>{item.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><Link href={`/admin?view=orders&order=${encodeURIComponent(item.orderId)}`}>Open order and invoice</Link></article>)}</BoundedList>{!reconciliation.items.length ? <p className={styles.empty}>No payment issues in these records.{reconciliation.nextOffset !== null ? " Continue for older orders." : ""}</p> : null}<PageLinks view={view} filter={filter} offset={offset} nextOffset={reconciliation.nextOffset} /></> : null}
      {view === "notifications" && notifications ? <><p className="formHint">{notifications.policy}</p><dl className={styles.metrics}>{[["Needs review", notifications.summary.manualFollowUp], ["Accepted by delivery service", notifications.summary.accepted], ["Delivery confirmed", notifications.summary.delivered], ["Waiting / trying again", notifications.summary.queued + notifications.summary.retrying]].map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl><BoundedList label="Message review" noun="messages" className={styles.rows} resetKey={`${filter}:${offset}:${orderId}`}>{notifications.items.map((item) => <article className={styles.row} key={item.id}><div className={styles.rowHeader}><strong>{notificationStatusLabel(item.state)}</strong><span>{item.channel} · {item.target}</span></div><p>{item.id}</p><p className="formHint">{item.attempts} attempts to send · Updated {dateLabel(item.updatedAt)}</p><p>{item.state === "manual_review" ? "Outcome is uncertain. Check the delivery service records before considering another send." : item.state === "exhausted" ? "Automatic retries have ended. Check the delivery service records and the original update." : "Not sent. Check the original update and message settings."}</p></article>)}</BoundedList>{!notifications.items.length ? <p className={styles.empty}>No messages currently need manual review.</p> : null}<PageLinks view={view} filter={filter} offset={offset} nextOffset={notifications.nextOffset} /></> : null}
    </section>
  </PortalShell>;
}
