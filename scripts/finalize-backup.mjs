import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

const result = { ...candidate, offsiteStoredAt: new Date().toISOString() };
mkdirSync(path.dirname(statusPath), { recursive: true });
const temporaryStatus = `${statusPath}.${process.pid}.tmp`;
writeFileSync(temporaryStatus, JSON.stringify(result), { flag: "wx", mode: 0o600 });
renameSync(temporaryStatus, statusPath);
unlinkSync(candidatePath);
console.log(JSON.stringify(result));
