import { createHmac, timingSafeEqual } from "node:crypto";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function normalizeBase32(value: string) {
  return value.toUpperCase().replace(/[\s=-]/g, "");
}

function decodeBase32(value: string) {
  const normalized = normalizeBase32(value);
  let bits = "";
  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid base32 secret.");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

export function validTotpSecret(value?: string) {
  if (!value) return false;
  try {
    return decodeBase32(value).length >= 20;
  } catch {
    return false;
  }
}

export function totpCode(secret: string, timestep = Math.floor(Date.now() / 30_000)) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(timestep));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  );
  return String(binary % 1_000_000).padStart(6, "0");
}

function equalCode(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyTotp(code: string, secret: string, now = Date.now(), window = 1) {
  if (!/^\d{6}$/.test(code) || !validTotpSecret(secret)) return null;
  const currentTimestep = Math.floor(now / 30_000);
  for (let drift = -window; drift <= window; drift += 1) {
    const timestep = currentTimestep + drift;
    if (equalCode(code, totpCode(secret, timestep))) return timestep;
  }
  return null;
}
