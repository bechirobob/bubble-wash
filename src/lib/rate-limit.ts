import "server-only";

import { consumeRateLimit } from "@/lib/data-store";

export function clientKey(headers: Headers, scope: string) {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = headers.get("x-real-ip")?.trim();
  return `${scope}:${forwarded || realIp || "local"}`;
}

export function isRateLimited(key: string, limit: number, windowMs: number) {
  return consumeRateLimit(key, limit, windowMs).limited;
}
