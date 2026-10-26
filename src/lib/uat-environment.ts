import "server-only";
import path from "node:path";
import { existsSync, realpathSync } from "node:fs";

type Environment = Record<string, string | undefined>;

/** No network provider is enabled by the temporary-access preparation. */
export function uatModeEnabled(env: Environment = process.env) {
  return env.BUBBLEWASH_UAT_ENABLED === "true";
}

export function assertUatProviderTrafficDisabled(env: Environment = process.env) {
  if (uatModeEnabled(env)) throw new Error("External provider traffic is disabled in UAT.");
}

/** Deployment assertions supplement, never replace, an operator's isolation check. */
export function assertUatEnvironment(env: Environment = process.env) {
  const reject = () => { throw new Error("An approved isolated UAT environment is required."); };
  if (!uatModeEnabled(env) || env.BUBBLEWASH_UAT_ISOLATION_CONFIRMED !== "true") reject();
  let url: URL;
  try { url = new URL(env.BUBBLEWASH_PUBLIC_URL || ""); } catch { return reject(); }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(host);
  if ((!loopback && url.protocol !== "https:") || (loopback && !["http:", "https:"].includes(url.protocol)) ||
      ["bubblewash.co", "www.bubblewash.co", "staff.bubblewash.co"].includes(host) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") reject();
  const database = env.BUBBLEWASH_DATABASE_PATH || "";
  const root = env.BUBBLEWASH_UAT_DATA_ROOT || "";
  if (!path.isAbsolute(database) || !path.isAbsolute(root) || root === path.parse(root).root ||
      !existsSync(root) || !existsSync(path.dirname(database))) reject();
  // Check the real target when paths exist: a symlink cannot point at live data.
  const resolvedRoot = existsSync(root) ? realpathSync(root) : path.resolve(root);
  const resolvedDatabase = existsSync(database) ? realpathSync(database)
    : path.join(existsSync(path.dirname(database)) ? realpathSync(path.dirname(database)) : path.resolve(path.dirname(database)), path.basename(database));
  const relative = path.relative(resolvedRoot, resolvedDatabase);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) ||
      resolvedDatabase === "/var/lib/bubblewash/bubblewash.sqlite" ||
      resolvedRoot === "/var/lib/bubblewash" || resolvedRoot.startsWith("/var/lib/bubblewash/")) reject();
  if (env.NEXT_PUBLIC_BUBBLEWASH_ONLINE_PAYMENTS_ENABLED !== "false" ||
      env.NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED !== "false" ||
      env.BUBBLEWASH_RESEARCH_EMAIL_ENABLED !== "false" ||
      env.BUBBLEWASH_DISABLE_DEMO_LOGIN !== "true") reject();
  for (const key of ["PAYSTACK_SECRET_KEY", "RESEND_API_KEY", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID",
    "BUBBLEWASH_RESEARCH_RESEND_KEY", "BUBBLEWASH_OWNER_RESEND_KEY",
    "NEXT_PUBLIC_BUBBLEWASH_WHATSAPP", "NEXT_PUBLIC_BUBBLEWASH_CONTACT_EMAIL"]) {
    if (env[key]?.trim()) reject();
  }
}
