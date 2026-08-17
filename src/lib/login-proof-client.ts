import { scrypt } from "scrypt-js";

const scryptCost = 16_384;
const scryptBlockSize = 8;
const scryptParallelization = 1;
const derivedKeyLength = 64;

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function createLoginProof(password: string, salt: string, challenge: string) {
  const encoder = new TextEncoder();
  // Existing Bubble Wash hashes pass the stored base64url salt text to scrypt as UTF-8.
  const derivedKey = await scrypt(
    encoder.encode(password),
    encoder.encode(salt),
    scryptCost,
    scryptBlockSize,
    scryptParallelization,
    derivedKeyLength,
  );
  const rawKey = new Uint8Array(derivedKey);
  const key = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const proof = await crypto.subtle.sign("HMAC", key, encoder.encode(challenge));
  return encodeBase64Url(new Uint8Array(proof));
}
