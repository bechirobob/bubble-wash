import { randomBytes } from "node:crypto";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32(buffer) {
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let output = "";
  for (let offset = 0; offset < bits.length; offset += 5) {
    output += alphabet[Number.parseInt(bits.slice(offset, offset + 5).padEnd(5, "0"), 2)];
  }
  return output;
}

const account = process.argv[2] || "admin@bubblewash.co";
const secret = base32(randomBytes(20));
const label = encodeURIComponent(`Bubble Wash:${account}`);
const issuer = encodeURIComponent("Bubble Wash");

console.log(`BUBBLEWASH_ADMIN_TOTP_SECRET=${secret}`);
console.log(`otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`);
console.log("Store the secret in the production secret manager, then enrol the URI in the admin authenticator app.");
