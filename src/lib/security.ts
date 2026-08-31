import { NextResponse } from "next/server.js";
import type { OrderSummary } from "@/lib/submissions";
import { privateNoStoreHeaders, securityHeaders } from "./security-headers.js";
import { matchesKnownDemoPassword } from "./passwords.ts";
import { validTotpSecret } from "./totp.ts";

export { privateNoStoreHeaders, securityHeaders };
export type SecurityHeader = ReturnType<typeof securityHeaders>[number];

export function adminMfaRequired(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env) {
  return env.BUBBLEWASH_ADMIN_MFA_REQUIRED === "true";
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
  let backupKeyValid = false;
  try {
    backupKeyValid = Buffer.from(env.BUBBLEWASH_BACKUP_ENCRYPTION_KEY ?? "", "base64").length === 32;
  } catch {
    backupKeyValid = false;
  }
  if (!backupKeyValid) errors.push("Set BUBBLEWASH_BACKUP_ENCRYPTION_KEY to a base64-encoded 32-byte key.");
  let mfaKeyValid = false;
  try {
    mfaKeyValid = Buffer.from(env.BUBBLEWASH_MFA_ENCRYPTION_KEY ?? "", "base64").length === 32;
  } catch {
    mfaKeyValid = false;
  }
  if (!mfaKeyValid) errors.push("Set BUBBLEWASH_MFA_ENCRYPTION_KEY to a base64-encoded 32-byte key.");
  for (const name of ["BUBBLEWASH_BACKUP_PRIMARY_DIR", "BUBBLEWASH_BACKUP_OFFSITE_DIR", "BUBBLEWASH_BACKUP_STATUS_PATH"]) {
    if (!env[name]?.startsWith("/")) errors.push(`Set ${name} to an absolute path.`);
  }
  if (env.BUBBLEWASH_BACKUP_PRIMARY_DIR && env.BUBBLEWASH_BACKUP_PRIMARY_DIR === env.BUBBLEWASH_BACKUP_OFFSITE_DIR) {
    errors.push("Primary and off-site backup directories must be different mounted destinations.");
  }
  if (!env.BUBBLEWASH_DATABASE_PATH || !env.BUBBLEWASH_DATABASE_PATH.startsWith("/")) {
    errors.push("Set BUBBLEWASH_DATABASE_PATH to an absolute path on the mounted persistent volume.");
  }
  if (env.BUBBLEWASH_DATABASE_DRIVER !== "sqlite") {
    errors.push("Set BUBBLEWASH_DATABASE_DRIVER=sqlite for the supported single-replica pilot topology.");
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
    const passwordHash = env[`BUBBLEWASH_${role}_PASSWORD_HASH`];
    if (!passwordHash) {
      errors.push(`Set BUBBLEWASH_${role}_PASSWORD_HASH in production.`);
    } else if (matchesKnownDemoPassword(passwordHash)) {
      errors.push(`Rotate BUBBLEWASH_${role}_PASSWORD_HASH; known demo credentials are prohibited in production.`);
    }
  }
  if (!env.BUBBLEWASH_VENDOR_ENTITY_ID?.trim()) {
    errors.push("Set BUBBLEWASH_VENDOR_ENTITY_ID to the exact approved vendor roster ID in production.");
  }
  if (!env.BUBBLEWASH_DRIVER_ENTITY_ID?.trim()) {
    errors.push("Set BUBBLEWASH_DRIVER_ENTITY_ID to the exact approved driver roster ID in production.");
  }
  const publicWhatsApp = (env.NEXT_PUBLIC_BUBBLEWASH_WHATSAPP ?? "").replace(/\D/g, "");
  if (publicWhatsApp && (publicWhatsApp.length < 8 || publicWhatsApp.length > 15 || /000000/.test(publicWhatsApp))) {
    errors.push("NEXT_PUBLIC_BUBBLEWASH_WHATSAPP must be a real international-format customer WhatsApp number or remain unset.");
  }
  const publicEmail = env.NEXT_PUBLIC_BUBBLEWASH_CONTACT_EMAIL ?? "";
  if (publicEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(publicEmail)) {
    errors.push("NEXT_PUBLIC_BUBBLEWASH_CONTACT_EMAIL must be a valid customer contact email or remain unset.");
  }
  if (env.NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED === "true" && !env.PAYSTACK_SECRET_KEY) {
    errors.push("Set PAYSTACK_SECRET_KEY before enabling online payments.");
  }
  if (env.NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED === "true") {
    if (!env.RESEND_API_KEY) errors.push("Set RESEND_API_KEY before enabling automated updates.");
    if (!env.BUBBLEWASH_EMAIL_FROM) errors.push("Set BUBBLEWASH_EMAIL_FROM before enabling automated updates.");
    if (!env.BUBBLEWASH_OPERATIONS_EMAIL) errors.push("Set BUBBLEWASH_OPERATIONS_EMAIL before enabling automated updates.");
    if (!env.WHATSAPP_ACCESS_TOKEN) errors.push("Set WHATSAPP_ACCESS_TOKEN before enabling automated updates.");
    if (!env.WHATSAPP_PHONE_NUMBER_ID) errors.push("Set WHATSAPP_PHONE_NUMBER_ID before enabling automated updates.");
    if (!env.BUBBLEWASH_OPERATIONS_WHATSAPP) errors.push("Set BUBBLEWASH_OPERATIONS_WHATSAPP before enabling automated updates.");
    if (!env.WHATSAPP_BOOKING_TEMPLATE) errors.push("Set WHATSAPP_BOOKING_TEMPLATE before enabling automated updates.");
    if (!env.WHATSAPP_OPERATIONS_TEMPLATE) errors.push("Set WHATSAPP_OPERATIONS_TEMPLATE before enabling automated updates.");
  }
  if (adminMfaRequired(env) !== (env.NEXT_PUBLIC_BUBBLEWASH_ADMIN_MFA_REQUIRED === "true")) {
    errors.push("Keep BUBBLEWASH_ADMIN_MFA_REQUIRED and NEXT_PUBLIC_BUBBLEWASH_ADMIN_MFA_REQUIRED aligned.");
  }
  const trustEdgeHeaders = env.BUBBLEWASH_TRUST_EDGE_HEADERS === "true";
  const trustProxyHeaders = env.BUBBLEWASH_TRUST_PROXY_HEADERS === "true";
  if (trustEdgeHeaders === trustProxyHeaders) {
    errors.push("Enable exactly one trusted client-IP mode for the deployment edge.");
  }
  return errors;
}

export function productionReadinessWarnings(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env) {
  if (env.NODE_ENV !== "production") return [];
  const warnings: string[] = [];
  if (env.BUBBLEWASH_STAFF_AUTH_DISABLED === "true") {
    warnings.push("All Bubble Wash staff sign-ins are disabled.");
  }
  if (!env.NEXT_PUBLIC_BUBBLEWASH_WHATSAPP) {
    warnings.push("The optional public WhatsApp contact link is intentionally hidden.");
  }
  if (!env.NEXT_PUBLIC_BUBBLEWASH_CONTACT_EMAIL) {
    warnings.push("The optional public email contact link is intentionally hidden.");
  }
  if (env.NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED !== "true") {
    warnings.push("Pilot payment mode is active: bank transfer and approved invoicing only; online checkout is disabled.");
  }
  if (env.NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED !== "true") {
    warnings.push("Pilot communication mode is active: operations must follow up with customers manually; automated email and WhatsApp updates are disabled.");
  }
  if (adminMfaRequired(env) && !validTotpSecret(env.BUBBLEWASH_ADMIN_TOTP_SECRET)) {
    warnings.push("Admin sign-in remains fail-closed until MFA enrollment is completed.");
  }
  if (!env.BUBBLEWASH_MAINTENANCE_TOKEN || env.BUBBLEWASH_MAINTENANCE_TOKEN.length < 32) {
    warnings.push("Automated maintenance remains fail-closed until an operations token is installed.");
  }
  if (!env.BUBBLEWASH_LEGAL_ENTITY_NAME?.trim()) {
    warnings.push("The registered legal entity name has not yet been published.");
  }
  if (!env.BUBBLEWASH_DPC_REGISTRATION_NUMBER?.trim()) {
    warnings.push("A Ghana Data Protection Commission registration number will only be published after it is confirmed.");
  }
  const confirmationSettings = [
    "RESEND_API_KEY",
    "BUBBLEWASH_EMAIL_FROM",
    "WHATSAPP_API_VERSION",
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_EARLY_ACCESS_TEMPLATE",
    "WHATSAPP_PRIVACY_TEMPLATE",
  ];
  if (confirmationSettings.some((name) => !env[name])) {
    warnings.push("Privacy and early-access confirmations require manual operations follow-up until email and WhatsApp providers are configured.");
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
