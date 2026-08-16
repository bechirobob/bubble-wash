import "server-only";

type LogLevel = "info" | "warn" | "error";

function clean(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 300);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(clean);
  if (typeof value === "object" && value) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/email|phone|address|name|contact|token|secret|password|payload|message/i.test(key))
      .slice(0, 30)
      .map(([key, item]) => [key, clean(item)]));
  }
  return undefined;
}

export function logEvent(level: LogLevel, event: string, context: Record<string, unknown> = {}) {
  const record = JSON.stringify({ time: new Date().toISOString(), service: "bubble-wash", level, event, ...clean(context) as Record<string, unknown> });
  if (level === "error") console.error(record);
  else if (level === "warn") console.warn(record);
  else console.info(record);
}
