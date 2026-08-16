import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const knownDemoPasswords = [
  "Admin123!",
  "Vendor123!",
  "Driver123!",
  "Support123!",
] as const;

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function createPasswordHash(password: string, salt = encodeBase64Url(randomBytes(16))) {
  const hash = encodeBase64Url(scryptSync(password, salt, 64));
  return `scrypt$${salt}$${hash}`;
}

export function verifyPasswordHash(password: string, passwordHash: string) {
  const [scheme, salt, expectedHash, ...extra] = passwordHash.split("$");
  if (scheme !== "scrypt" || !salt || !expectedHash || extra.length > 0) return false;

  let expected: Uint8Array;
  try {
    expected = decodeBase64Url(expectedHash);
  } catch {
    return false;
  }
  if (expected.length !== 64) return false;

  const actual = scryptSync(password, salt, 64);
  return timingSafeEqual(actual, expected);
}

export function matchesKnownDemoPassword(passwordHash: string) {
  return knownDemoPasswords.some((password) => verifyPasswordHash(password, passwordHash));
}
