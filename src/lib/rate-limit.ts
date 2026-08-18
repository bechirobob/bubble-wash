import "server-only";

import { consumeRateLimit } from "@/lib/data-store";
import { clientScopeKey } from "@/lib/security";

export function clientKey(headers: Headers, scope: string) {
  return clientScopeKey(headers, scope);
}

export function isRateLimited(key: string, limit: number, windowMs: number) {
  return consumeRateLimit(key, limit, windowMs).limited;
}
