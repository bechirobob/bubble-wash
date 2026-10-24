import type { ReferenceDatabase } from "./booking-references.ts";

export const vendorCodeSchema = `CREATE TABLE vendor_codes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(sequence BETWEEN 1 AND 17576),
  vendor_id TEXT NOT NULL UNIQUE CHECK(length(vendor_id) > 0),
  code TEXT NOT NULL UNIQUE CHECK(length(code) = 3 AND code GLOB '[A-Z][A-Z][A-Z]')
);`;

export function formatVendorCode(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 17576) throw new Error("Vendor code space exhausted or invalid.");
  const n = sequence - 1;
  return String.fromCharCode(65 + Math.floor(n / 676), 65 + Math.floor(n / 26) % 26, 65 + n % 26);
}

export function vendorCodeForId(db: Pick<ReferenceDatabase, "prepare">, vendorId: string): string | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vendor_codes'").get()) return null;
  const row = db.prepare("SELECT code FROM vendor_codes WHERE vendor_id = ?").get(vendorId) as { code: string } | undefined;
  return typeof row?.code === "string" ? row.code : null;
}

/** Name-derived display suggestion, not an identity or authorization credential.
 * Short/non-Latin-only names use the neutral VND prefix, not invented initials.
 */
export function preferredVendorCode(vendorName: string): string {
  const letters = vendorName.normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z]/g, "");
  return letters.length >= 3 ? letters.slice(0, 3) : "VND";
}

/** Stable vendor identity, with allocation in the same immediate roster transaction.
 * Prefer the first three normalized letters. On collision try the same two-letter
 * prefix from A to Z, then subsequent prefixes, wrapping the complete namespace.
 */
export function allocateVendorCode(db: ReferenceDatabase, vendorId: string, vendorName: string): string {
  if (!db.inTransaction) throw new Error("Vendor allocation requires the vendor transaction.");
  if (!vendorId || vendorId.length > 160 || vendorId.trim() !== vendorId) throw new Error("Invalid internal vendor identity.");
  const prior = db.prepare("SELECT code FROM vendor_codes WHERE vendor_id = ?").get(vendorId) as { code: string } | undefined;
  if (prior) return String(prior.code);
  const high = db.prepare("SELECT max(value) AS value FROM (SELECT coalesce(max(sequence), 0) AS value FROM vendor_codes UNION ALL SELECT seq AS value FROM sqlite_sequence WHERE name = 'vendor_codes')").get() as { value: number } | undefined;
  const next = Number(high?.value ?? 0) + 1;
  if (!Number.isInteger(next) || next < 1 || next > 17576) throw new Error("Vendor code space exhausted or invalid.");
  const preferred = preferredVendorCode(vendorName);
  const used = db.prepare("SELECT 1 FROM vendor_codes WHERE code = ?");
  let code = preferred;
  if (used.get(code)) {
    const start = ((preferred.charCodeAt(0) - 65) * 26 + preferred.charCodeAt(1) - 65) * 26;
    let found = false;
    for (let offset = 0; offset < 17576; offset++) {
      const candidate = formatVendorCode((start + offset) % 17576 + 1);
      if (!used.get(candidate)) { code = candidate; found = true; break; }
    }
    if (!found) throw new Error("Vendor code space exhausted or invalid.");
  }
  db.prepare("INSERT INTO vendor_codes (sequence, vendor_id, code) VALUES (?, ?, ?)").run(next, vendorId, code);
  return code;
}
