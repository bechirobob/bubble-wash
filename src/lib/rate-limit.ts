import "server-only";

import { env } from "cloudflare:workers";
import { consumeRateLimit } from "@/lib/data-store";
import { clientScopeKey } from "@/lib/security";

export function clientKey(headers: Headers, scope: string) {
  return clientScopeKey(headers, scope);
}

function edgeLimiter(key: string): RateLimit {
  if (key.startsWith("login:")) return env.LOGIN_RATE_LIMITER;
  if (key.startsWith("payments-")) return env.PAYMENT_RATE_LIMITER;
  if (key.startsWith("dispatch-location:")) return env.DISPATCH_RATE_LIMITER;
  if (key.startsWith("track:") || key.startsWith("route-preview:")) return env.PUBLIC_READ_RATE_LIMITER;
  return env.PUBLIC_WRITE_RATE_LIMITER;
}

export async function isRateLimited(key: string, limit: number, windowMs: number) {
  const edge = await edgeLimiter(key).limit({ key });
  if (!edge.success) return true;
  return (await consumeRateLimit(key, limit, windowMs)).limited;
}
