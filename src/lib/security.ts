import { NextResponse } from "next/server.js";
import type { OrderSummary } from "@/lib/submissions";

export type SecurityHeader = { key: string; value: string };

const cspDirectives = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https://images.unsplash.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https://api.paystack.co https://api.resend.com https://graph.facebook.com https://wa.me https://api.whatsapp.com https://www.google.com https://maps.google.com",
  "frame-src https://checkout.paystack.com",
  "upgrade-insecure-requests",
];

export function securityHeaders(): SecurityHeader[] {
  return [
    { key: "Content-Security-Policy", value: cspDirectives.join("; ") },
    { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(self), usb=(), accelerometer=(), gyroscope=(), magnetometer=(), fullscreen=(self)" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  ];
}

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

export function staffWriteGuard(headers: Headers) {
  const contentType = headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return NextResponse.json({ ok: false, error: "Use application/json for this staff action." }, { status: 415 });
  }
  if (!sameOriginAllowed(headers)) {
    return NextResponse.json({ ok: false, error: "Same-origin staff action required." }, { status: 403 });
  }
  return null;
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
  for (const role of ["ADMIN", "VENDOR", "DRIVER", "SUPPORT"]) {
    if (!env[`BUBBLEWASH_${role}_EMAIL`]) errors.push(`Set BUBBLEWASH_${role}_EMAIL in production.`);
    if (!env[`BUBBLEWASH_${role}_PASSWORD_HASH`]) errors.push(`Set BUBBLEWASH_${role}_PASSWORD_HASH in production.`);
  }
  return errors;
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
