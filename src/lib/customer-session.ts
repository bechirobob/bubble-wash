import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const customerSessionCookieName = "bubblewash_customer_order_session";
const maxAgeSeconds = 60 * 30;

type CustomerSession = {
  orderId: string;
  contactFingerprint: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

function secret() {
  const value = process.env.BUBBLEWASH_SESSION_SECRET;
  if (value) return value;
  if (process.env.NODE_ENV === "production") throw new Error("BUBBLEWASH_SESSION_SECRET is required in production.");
  return "bubblewash-local-dev-session-secret-change-before-production";
}

function sign(value: string) {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function normalizeCustomerContact(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.includes("@")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  return digits.startsWith("0") && digits.length === 10 ? `233${digits.slice(1)}` : digits;
}

export function customerContactFingerprint(value: string) {
  return createHmac("sha256", secret()).update(`customer-contact:${normalizeCustomerContact(value)}`).digest("base64url");
}

export function customerContactMatches(candidate: string, expectedEmail: string, expectedPhone: string) {
  const candidateFingerprint = customerContactFingerprint(candidate);
  return [expectedEmail, expectedPhone]
    .filter(Boolean)
    .some((value) => safeEqual(candidateFingerprint, customerContactFingerprint(value)));
}

export function encodeCustomerSession(orderId: string, contact: string) {
  const now = Math.floor(Date.now() / 1000);
  const session: CustomerSession = {
    orderId,
    contactFingerprint: customerContactFingerprint(contact),
    issuedAt: now,
    expiresAt: now + maxAgeSeconds,
    nonce: randomUUID(),
  };
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function decodeCustomerSession(value?: string) {
  if (!value) return null;
  try {
    const [payload, signature] = value.split(".");
    if (!payload || !signature || !safeEqual(signature, sign(payload))) return null;
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CustomerSession;
    if (!session.orderId || !session.contactFingerprint || session.expiresAt < Math.floor(Date.now() / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

export function customerSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
