import { readdirSync, readFileSync } from "node:fs";
import { unstable_splitSqlQuery as splitSqlQuery } from "wrangler";

const files = readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort();
for (const file of files) {
  const sql = readFileSync(`migrations/${file}`, "utf8");
  const statements = splitSqlQuery(sql);
  if (!statements.length) throw new Error(`${file} contains no executable SQL.`);
  for (const statement of statements) {
    if (/CREATE\s+TRIGGER/i.test(statement) && !statement.trimEnd().endsWith(";")) {
      throw new Error(`${file} loses a trigger terminator in Wrangler's D1 statement splitter.`);
    }
  }
}

console.log(`Wrangler D1 migration splitting verified for ${files.length} files.`);
