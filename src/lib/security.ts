import { NextResponse } from "next/server.js";
import type { OrderSummary } from "@/lib/submissions";
import { securityHeaders } from "./security-headers.js";

export { securityHeaders };
export type SecurityHeader = ReturnType<typeof securityHeaders>[number];

export function clientScopeKey(headers: Headers, scope: string) {
  const trustEdgeHeaders = process.env.BUBBLEWASH_TRUST_EDGE_HEADERS === "true";
  const cloudflareIp = trustEdgeHeaders ? headers.get("cf-connecting-ip")?.trim() : "";
  const renderIp = trustEdgeHeaders ? headers.get("fly-client-ip")?.trim() || headers.get("true-client-ip")?.trim() : "";
  const explicitTrustedProxy = process.env.BUBBLEWASH_TRUST_PROXY_HEADERS === "true";
  const forwarded = explicitTrustedProxy ? headers.get("x-forwarded-for")?.split(",")[0]?.trim() : "";
  const realIp = explicitTrustedProxy ? headers.get("x-real-ip")?.trim() : "";
  return `${scope}:${cloudflareIp || renderIp || forwarded || realIp || "local"}`;
}

export function sameOriginAllowed(headers: Headers) {
  const origin = headers.get("origin");
  const host = headers.get("host");
  if (!origin) return process.env.NODE_ENV !== "production";
  if (!host) return false;
  try {
    const originUrl = new URL(origin);
    return originUrl.host === host && (originUrl.protocol === "https:" || process.env.NODE_ENV !== "production");
  } catch {
    return false;
  }
}

export function sameOriginJsonGuard(headers: Headers, actionLabel = "request") {
  const contentType = headers.get("content-type") ?? "";
  const contentLength = Number(headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
    return NextResponse.json({ ok: false, error: `The ${actionLabel} is too large.` }, { status: 413 });
  }
  if (!contentType.toLowerCase().includes("application/json")) {
    return NextResponse.json({ ok: false, error: `Use application/json for this ${actionLabel}.` }, { status: 415 });
  }
  if (!sameOriginAllowed(headers)) {
    return NextResponse.json({ ok: false, error: `Same-origin ${actionLabel} required.` }, { status: 403 });
  }
  return null;
}

export function staffWriteGuard(headers: Headers) {
  return sameOriginJsonGuard(headers, "staff action");
}

export function productionReadinessErrors(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env) {
  const errors: string[] = [];
  if (env.NODE_ENV !== "production") return errors;
  if (env.BUBBLEWASH_ENABLE_DEMO_LOGIN === "true") {
    errors.push("Remove BUBBLEWASH_ENABLE_DEMO_LOGIN from production; demo login cannot be enabled in production.");
  }
  if (env.BUBBLEWASH_DISABLE_DEMO_LOGIN !== "true") {
    errors.push("Set BUBBLEWASH_DISABLE_DEMO_LOGIN=true in production.");
  }
  if (!env.BUBBLEWASH_SESSION_SECRET || env.BUBBLEWASH_SESSION_SECRET.length < 32) {
    errors.push("Set BUBBLEWASH_SESSION_SECRET to a strong 32+ character value in production.");
  }
  if (!env.BUBBLEWASH_DATABASE_PATH || !env.BUBBLEWASH_DATABASE_PATH.startsWith("/")) {
    errors.push("Set BUBBLEWASH_DATABASE_PATH to an absolute path on the mounted persistent volume.");
  }
  try {
    const publicUrl = new URL(env.BUBBLEWASH_PUBLIC_URL ?? "");
    if (publicUrl.protocol !== "https:" || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
      errors.push("Set BUBBLEWASH_PUBLIC_URL to the HTTPS site origin without a path, query, or fragment.");
    }
  } catch {
    errors.push("Set BUBBLEWASH_PUBLIC_URL to the public HTTPS site origin.");
  }
  for (const role of ["ADMIN", "VENDOR", "DRIVER", "SUPPORT"]) {
    if (!env[`BUBBLEWASH_${role}_EMAIL`]) errors.push(`Set BUBBLEWASH_${role}_EMAIL in production.`);
    if (!env[`BUBBLEWASH_${role}_PASSWORD_HASH`]) errors.push(`Set BUBBLEWASH_${role}_PASSWORD_HASH in production.`);
  }
  const publicWhatsApp = (env.NEXT_PUBLIC_BUBBLEWASH_WHATSAPP ?? "").replace(/\D/g, "");
  if (publicWhatsApp.length < 8 || publicWhatsApp.length > 15 || /000000/.test(publicWhatsApp)) {
    errors.push("Set NEXT_PUBLIC_BUBBLEWASH_WHATSAPP to the real international-format customer WhatsApp number.");
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(env.NEXT_PUBLIC_BUBBLEWASH_CONTACT_EMAIL ?? "")) {
    errors.push("Set NEXT_PUBLIC_BUBBLEWASH_CONTACT_EMAIL to the monitored customer contact email.");
  }
  return errors;
}

export function productionReadinessWarnings(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env) {
  if (env.NODE_ENV !== "production") return [];
  const warnings: string[] = [];
  if (!env.PAYSTACK_SECRET_KEY) warnings.push("Online Paystack checkout is unavailable.");
  if (!env.RESEND_API_KEY || !env.BUBBLEWASH_EMAIL_FROM || !env.BUBBLEWASH_OPERATIONS_EMAIL) {
    warnings.push("Transactional email is not fully configured.");
  }
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID || !env.BUBBLEWASH_OPERATIONS_WHATSAPP) {
    warnings.push("WhatsApp notifications are not fully configured.");
  }
  if (env.BUBBLEWASH_TRUST_EDGE_HEADERS !== "true" && env.BUBBLEWASH_TRUST_PROXY_HEADERS !== "true") {
    warnings.push("Per-client rate limits are using the shared local fallback; configure the trusted proxy mode for the deployment edge.");
  }
  return warnings;
}

function publicCustomerLabel(value: string) {
  const first = value.trim().split(/\s+/)[0];
  return first || "Bubble Wash customer";
}

export function publicTrackingView(order: Pick<OrderSummary, "orderId" | "createdAt" | "updatedAt" | "lastEventType" | "customer" | "status" | "nextStep" | "area" | "routeWindow" | "eventCount" | "route">) {
  return {
    id: order.orderId,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    type: order.lastEventType,
    customer: publicCustomerLabel(order.customer),
    status: order.status,
    nextStep: order.nextStep,
    area: order.area,
    routeWindow: order.routeWindow,
    eventCount: order.eventCount,
    route: order.route ? {
      zoneLabel: order.route.zoneLabel,
      zoneNote: order.route.zoneNote,
    } : undefined,
  };
}
