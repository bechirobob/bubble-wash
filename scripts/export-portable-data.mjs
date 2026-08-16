import Database from "better-sqlite3";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const source = process.env.BUBBLEWASH_DATABASE_PATH;
if (!source || !path.isAbsolute(source) || !existsSync(source)) throw new Error("BUBBLEWASH_DATABASE_PATH must point to an existing absolute SQLite file.");
const output = path.resolve(process.argv[2] || `migration-export-${new Date().toISOString().replaceAll(":", "-")}`);
if (existsSync(output)) throw new Error(`Refusing to overwrite an existing export directory: ${output}`);
mkdirSync(output, { recursive: true, mode: 0o700 });

const database = new Database(source, { readonly: true, fileMustExist: true });
try {
  if (database.pragma("quick_check", { simple: true }) !== "ok") throw new Error("Source database integrity check failed.");
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const manifest = { createdAt: new Date().toISOString(), sourceEngine: "sqlite", tables: {} };
  for (const { name } of tables) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe table identifier: ${name}`);
    const rows = database.prepare(`SELECT * FROM "${name}"`).all();
    const content = rows.map((row) => JSON.stringify(row)).join("\n");
    writeFileSync(path.join(output, `${name}.jsonl`), content ? `${content}\n` : "", { flag: "wx", mode: 0o600 });
    manifest.tables[name] = rows.length;
  }
  writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ok: true, output, tables: manifest.tables }));
} finally {
  database.close();
}
