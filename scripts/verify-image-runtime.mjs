import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";
import sharp from "sharp";

const expectedSharpVersion = "0.35.3";
const minimumLibvipsVersion = [8, 18, 3];
const startupTimeoutMs = 30_000;

function versionAtLeast(actual, minimum) {
  const parts = actual.split(".").map((part) => Number.parseInt(part, 10));
  assert.equal(parts.length >= minimum.length, true, `Invalid version: ${actual}`);
  for (let index = 0; index < minimum.length; index += 1) {
    if (parts[index] > minimum[index]) return true;
    if (parts[index] < minimum[index]) return false;
  }
  return true;
}

async function reservePort() {
  const server = createServer();
  server.unref();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Next.js exited before image verification.\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, { cache: "no-store" });
      if (response.ok) return;
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Next.js did not become ready within ${startupTimeoutMs}ms.\n${output()}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = once(child, "exit");
  const timeout = new Promise((resolve) => setTimeout(resolve, 5_000, "timeout"));
  if (await Promise.race([exited, timeout]) === "timeout" && child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

assert.equal(sharp.versions.sharp, expectedSharpVersion);
assert.equal(
  versionAtLeast(sharp.versions.vips, minimumLibvipsVersion),
  true,
  `libvips ${sharp.versions.vips} is older than ${minimumLibvipsVersion.join(".")}`,
);

const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: process.cwd(),
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
const collectOutput = (chunk) => {
  serverOutput = `${serverOutput}${chunk}`.slice(-8_000);
};
child.stdout.on("data", collectOutput);
child.stderr.on("data", collectOutput);

try {
  await waitForServer(baseUrl, child, () => serverOutput);
  const imageUrl = `${baseUrl}/_next/image?url=%2Fbubble-wash-icon.jpg&w=64&q=75`;
  const requestOptions = { headers: { accept: "image/webp,*/*" }, cache: "no-store" };
  const response = await fetch(imageUrl, requestOptions);
  const body = Buffer.from(await response.arrayBuffer());

  assert.equal(response.status, 200, `Image optimizer returned ${response.status}: ${body.toString("utf8")}`);
  assert.equal(response.headers.get("content-type"), "image/webp");
  assert.equal(body.length > 0, true);

  const metadata = await sharp(body).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 64);
  assert.equal(metadata.height, 64);

  const cachedResponse = await fetch(imageUrl, requestOptions);
  const cachedBody = Buffer.from(await cachedResponse.arrayBuffer());
  assert.equal(cachedResponse.status, 200);
  assert.equal(cachedResponse.headers.get("content-type"), "image/webp");
  assert.deepEqual(cachedBody, body);

  console.log(JSON.stringify({
    ok: true,
    sharp: sharp.versions.sharp,
    libvips: sharp.versions.vips,
    nextImageStatus: response.status,
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    cachePathStatus: cachedResponse.status,
    cacheHeader: cachedResponse.headers.get("x-nextjs-cache"),
  }));
} finally {
  await stopServer(child);
}
