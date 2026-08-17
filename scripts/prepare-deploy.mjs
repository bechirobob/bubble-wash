import { readFile, writeFile } from "node:fs/promises";

const generatedConfigPath = new URL("../dist/server/wrangler.json", import.meta.url);
const generatedConfig = JSON.parse(await readFile(generatedConfigPath, "utf8"));
const sourceConfig = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

delete generatedConfig.legacy_env;
delete generatedConfig.configPath;
delete generatedConfig.userConfigPath;
generatedConfig.routes = sourceConfig.routes;
generatedConfig.vars = sourceConfig.vars;
generatedConfig.triggers = sourceConfig.triggers;
generatedConfig.ratelimits = sourceConfig.ratelimits;
generatedConfig.observability = sourceConfig.observability;
generatedConfig.workers_dev = sourceConfig.workers_dev;
generatedConfig.assets = {
  ...generatedConfig.assets,
  ...sourceConfig.assets,
  directory: generatedConfig.assets?.directory ?? "../client",
};

await writeFile(generatedConfigPath, `${JSON.stringify(generatedConfig)}\n`, "utf8");
