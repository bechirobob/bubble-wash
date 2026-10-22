/** A phase deadline is fixed by its workflow event; expiry never starts a count-up. */
export function stageCountdown(updatedAt: string, targetMinutes: number, now = Date.now()) {
  if (targetMinutes === 0) return { state: "complete" as const, tone: "paused" as const, remainingSeconds: 0 };
  const startedAt = Date.parse(updatedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(now) || !Number.isFinite(targetMinutes) || targetMinutes < 0 || startedAt > now) {
    return { state: "unavailable" as const, tone: "paused" as const, remainingSeconds: 0 };
  }
  const remainingSeconds = Math.max(0, Math.ceil((startedAt + targetMinutes * 60_000 - now) / 1000));
  if (remainingSeconds === 0) return { state: "overdue" as const, tone: "breached" as const, remainingSeconds };
  return { state: "running" as const, tone: remainingSeconds <= 20 * 60 ? "due" as const : "ok" as const, remainingSeconds };
}
