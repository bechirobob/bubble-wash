import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const source = process.env.BUBBLEWASH_DATABASE_PATH;
if (!source || !path.isAbsolute(source)) {
  throw new Error("BUBBLEWASH_DATABASE_PATH must be an absolute path before running a backup.");
}
if (!existsSync(source)) throw new Error(`Database does not exist: ${source}`);

const stamp = new Date().toISOString().replaceAll(":", "-");
const defaultDestination = path.join(path.dirname(source), "backups", `bubblewash-${stamp}.sqlite`);
const destination = path.resolve(process.argv[2] || defaultDestination);
if (destination === path.resolve(source)) throw new Error("Backup destination must be different from the live database.");
if (existsSync(destination)) throw new Error(`Refusing to overwrite an existing backup: ${destination}`);

mkdirSync(path.dirname(destination), { recursive: true });
const database = new Database(source, { readonly: true, fileMustExist: true });
try {
  await database.backup(destination);
} finally {
  database.close();
}

const verification = new Database(destination, { readonly: true, fileMustExist: true });
try {
  const result = verification.pragma("quick_check", { simple: true });
  if (result !== "ok") throw new Error("Backup integrity check failed.");
} finally {
  verification.close();
}

console.log(JSON.stringify({ ok: true, destination, createdAt: new Date().toISOString() }));
