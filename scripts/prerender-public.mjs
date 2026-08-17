import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { securityHeaders } from "../src/lib/security-headers.js";

const origin = "http://127.0.0.1:18787";
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const publicRoutes = [
  "/",
  "/services",
  "/book",
  "/track",
  "/manage",
  "/early-access",
  "/privacy",
  "/terms",
  "/refund-policy",
  "/staff",
  "/login",
];
const publicDocuments = [
  ["/robots.txt", "robots.txt"],
  ["/sitemap.xml", "sitemap.xml"],
];

function htmlPath(route) {
  return route === "/" ? "dist/client/index.html" : `dist/client${route}/index.html`;
}

async function fetchRequired(path, expectedType) {
  const response = await fetch(`${origin}${path}`, {
    headers: { Accept: expectedType, "User-Agent": "BubbleWash-Prerender/1.0" },
    redirect: "follow",
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${body.slice(0, 300)}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (expectedType === "xml" ? !contentType.includes("xml") : !contentType.includes(expectedType)) {
    throw new Error(`${path} did not return ${expectedType}.`);
  }
  return body;
}

async function waitUntilReady(child, logs) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${origin}/`, { headers: { Accept: "text/html" } });
      if (response.ok) return;
    } catch {
      // The local Worker is still starting.
    }
    await delay(250);
  }
  throw new Error(`Local Worker did not start.\n${logs.slice(-30).join("\n")}`);
}

const logs = [];
const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["wrangler", "dev", "--config", "dist/server/wrangler.json", "--local", "--ip", "127.0.0.1", "--port", "18787"],
  { cwd: projectRoot, env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] },
);
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => logs.push(...chunk.split(/\r?\n/u).filter(Boolean)));
}

try {
  await waitUntilReady(child, logs);
  for (const route of publicRoutes) {
    const html = await fetchRequired(route, "text/html");
    if (!/^<!doctype html>/iu.test(html.trimStart())) throw new Error(`${route} did not produce a complete HTML document.`);
    const destination = resolve(projectRoot, htmlPath(route));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, html, "utf8");
  }
  for (const [route, filename] of publicDocuments) {
    const expectedType = filename.endsWith(".xml") ? "xml" : "text/plain";
    const body = await fetchRequired(route, expectedType);
    await writeFile(resolve(projectRoot, "dist/client", filename), body, "utf8");
  }

  const generatedHeaders = await readFile(new URL("../dist/client/_headers", import.meta.url), "utf8");
  const assetHeaders = [
    "/*",
    ...securityHeaders().map(({ key, value }) => `  ${key}: ${value}`),
    "  Cache-Control: public, max-age=0, must-revalidate",
    "  X-BubbleWash-Render: asset",
    "",
    generatedHeaders.trim(),
    "",
  ].join("\n");
  await writeFile(new URL("../dist/client/_headers", import.meta.url), assetHeaders, "utf8");
  console.log(`Prerendered ${publicRoutes.length} public HTML routes and ${publicDocuments.length} public documents.`);
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(5_000)]);
}
