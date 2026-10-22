import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const statusPath = process.env.BUBBLEWASH_BACKUP_STATUS_PATH;
const stagingDir = process.env.BUBBLEWASH_BACKUP_OFFSITE_DIR;
const filename = process.argv[2];

for (const [name, value] of Object.entries({
  BUBBLEWASH_BACKUP_STATUS_PATH: statusPath,
  BUBBLEWASH_BACKUP_OFFSITE_DIR: stagingDir,
})) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
}
if (!/^bubblewash-\d{4}-\d{2}-\d{2}T.*\.sqlite\.enc$/.test(filename ?? "")) {
  throw new Error("A valid encrypted-backup filename is required.");
}

const candidatePath = `${statusPath}.${filename}.pending`;
if (!existsSync(candidatePath)) throw new Error(`Pending backup proof does not exist: ${filename}`);

const stagedPath = path.join(stagingDir, filename);
if (!existsSync(stagedPath)) throw new Error(`Staged encrypted backup does not exist: ${filename}`);

const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
if (!candidate.ok || candidate.filename !== filename || typeof candidate.sha256 !== "string") {
  throw new Error("The pending backup proof is invalid.");
}

const stagedHash = createHash("sha256").update(readFileSync(stagedPath)).digest("hex");
if (stagedHash !== candidate.sha256) throw new Error("The off-host artifact source no longer matches its restore proof.");

// The existing private transport writes this receipt after independent download
// verification. A caller claiming success is not sufficient evidence.
const receiptPath = process.argv[3];
if (process.argv.length !== 4 || !path.isAbsolute(receiptPath ?? "")) throw new Error("An explicit absolute durable private-store receipt path is required.");
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
const createdAt = Date.parse(candidate.createdAt);
const restoredAt = Date.parse(candidate.restoreVerifiedAt);
const verifiedAt = Date.parse(receipt.verifiedAt);
if (receipt.schema !== "becore-encrypted-backup-release/v2" ||
    receipt.repository !== "bechirobob/bubble-wash" || receipt.storageRepository !== "bechirobob/becore-backups" ||
    receipt.storage !== "private-github-release" || receipt.encrypted !== true || receipt.restoreTested !== true || receipt.downloadVerified !== true ||
    receipt.filename !== filename || receipt.sha256 !== stagedHash || receipt.size !== statSync(stagedPath).size ||
    !Number.isSafeInteger(receipt.storageRepositoryId) || receipt.storageRepositoryId <= 0 ||
    !/^[a-f0-9]{40}$/.test(receipt.storageSha ?? "") || !/^[a-f0-9]{40}$/.test(receipt.sourceSha ?? "") ||
    !Number.isFinite(createdAt) || !Number.isFinite(restoredAt) || !Number.isFinite(verifiedAt) ||
    restoredAt < createdAt || restoredAt > Date.now() || verifiedAt + 1000 < restoredAt || verifiedAt > Date.now() + 1000) {
  throw new Error("The durable private-store receipt does not match the restore-tested backup.");
}
const result = { ...candidate, offsiteStoredAt: new Date().toISOString() };
mkdirSync(path.dirname(statusPath), { recursive: true });
const temporaryStatus = `${statusPath}.${process.pid}.tmp`;
writeFileSync(temporaryStatus, JSON.stringify(result), { flag: "wx", mode: 0o600 });
renameSync(temporaryStatus, statusPath);
unlinkSync(candidatePath);
console.log(JSON.stringify(result));
