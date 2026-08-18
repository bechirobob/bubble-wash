import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const knownDemoPasswords = [
  "Admin123!",
  "Vendor123!",
  "Driver123!",
  "Support123!",
] as const;

export function createPasswordHash(password: string, salt = randomBytes(16).toString("base64url")) {
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPasswordHash(password: string, passwordHash: string) {
  const [scheme, salt, expectedHash, ...extra] = passwordHash.split("$");
  if (scheme !== "scrypt" || !salt || !expectedHash || extra.length > 0) return false;

  const expected = Buffer.from(expectedHash, "base64url");
  if (expected.length !== 64) return false;

  const actual = scryptSync(password, salt, 64);
  return timingSafeEqual(actual, expected);
}

export function matchesKnownDemoPassword(passwordHash: string) {
  return knownDemoPasswords.some((password) => verifyPasswordHash(password, passwordHash));
}
