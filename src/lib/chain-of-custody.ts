import "server-only";

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { storeDeliveryCode } from "@/lib/data-store";

type LabelToken = {
  orderId: string;
  bagTag: string;
  issuedAt: number;
  expiresAt: number;
};

function secret() {
  const value = process.env.BUBBLEWASH_SESSION_SECRET;
  if (value) return value;
  if (process.env.NODE_ENV === "production") throw new Error("BUBBLEWASH_SESSION_SECRET is required in production.");
  return "bubblewash-local-dev-session-secret-change-before-production";
}

function hmac(value: string) {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

function equal(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function deliveryCodeHash(orderId: string, code: string) {
  return hmac(`delivery:${orderId.toUpperCase()}:${code}`);
}

export async function createDeliveryCode(orderId: string) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const stored = await storeDeliveryCode(orderId, deliveryCodeHash(orderId, code));
  return stored ? code : "";
}

export function createBagLabelToken(orderId: string, bagTag = `${orderId}-BAG`) {
  const now = Math.floor(Date.now() / 1000);
  const payload: LabelToken = { orderId, bagTag, issuedAt: now, expiresAt: now + 60 * 60 * 24 * 30 };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${hmac(`bag-label:${encoded}`)}`;
}

export function verifyBagLabelToken(value?: string) {
  if (!value) return null;
  try {
    const [payload, signature] = value.split(".");
    if (!payload || !signature || !equal(signature, hmac(`bag-label:${payload}`))) return null;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as LabelToken;
    if (!/^BW-[A-Z0-9]{8,32}$/.test(decoded.orderId) || !decoded.bagTag || decoded.expiresAt < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch {
    return null;
  }
}
