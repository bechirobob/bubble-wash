// Local synthetic readiness only; this does not replace the full browser gate.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateVersions(config, lock, installed, nodeVersion, pythonVersion, osRelease) {
  const expectedImage = `mcr.microsoft.com/playwright:v${config.playwrightVersion}-noble@sha256:`;
  assert.ok(config.image.startsWith(expectedImage));
  assert.match(config.image.slice(expectedImage.length), /^[a-f0-9]{64}$/);
  for (const name of ['@playwright/test', 'playwright', 'playwright-core']) {
    assert.equal(lock.packages[`node_modules/${name}`].version, config.playwrightVersion);
    assert.equal(installed[name], config.playwrightVersion);
  }
  for (const name of ['better-sqlite3', 'sharp']) {
    assert.equal(installed[name], lock.packages[`node_modules/${name}`].version);
  }
  assert.equal(Number(nodeVersion.split('.')[0]), config.nodeMajor);
  assert.equal(pythonVersion, config.pythonMinor);
  const os = Object.fromEntries(osRelease.trim().split('\n').map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, '')];
  }));
  assert.equal(os.ID, config.osId);
  assert.equal(os.VERSION_ID, config.osVersion);
}

export async function verifyBrowser(engines, checkExecutable = executable => access(executable, constants.X_OK)) {
  const checks = [];
  for (const name of ['chromium', 'webkit']) {
    const executable = engines[name].executablePath();
    assert.ok(resolve(executable).startsWith('/ms-playwright' + sep));
    await checkExecutable(executable);
    const started = performance.now();
    const browser = await engines[name].launch();
    try {
      const page = await browser.newPage();
      await page.setContent('<main>Prepared browser ready</main>');
      assert.equal(await page.locator('main').textContent(), 'Prepared browser ready');
      checks.push({ engine: name, version: browser.version(), readyMs: Math.round(performance.now() - started) });
    } finally {
      await browser.close();
    }
  }
  return checks;
}

export async function verifyBrowserEnvironment() {
  const started = performance.now();
  const require = createRequire(resolve('package.json'));
  const config = JSON.parse(await readFile(new URL('./browser-environment.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const installed = Object.fromEntries(['@playwright/test', 'playwright', 'playwright-core', 'better-sqlite3', 'sharp']
    .map(name => [name, require(`${name}/package.json`).version]));
  const python = execFileSync('python3', ['-c', 'import sys; print("%s.%s" % sys.version_info[:2])'], { encoding: 'utf8' }).trim();
  validateVersions(config, lock, installed, process.versions.node, python, await readFile('/etc/os-release', 'utf8'));
  assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, '/ms-playwright');
  assert.ok(!process.env.BUBBLEWASH_TEST_CHROMIUM_PATH, 'Do not override the prepared Chromium binary');

  // Exercise both native modules under the selected Node ABI, without app data.
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE readiness (value TEXT NOT NULL)');
    db.prepare('INSERT INTO readiness VALUES (?)').run('ready');
    assert.deepEqual(db.prepare('SELECT value FROM readiness').get(), { value: 'ready' });
  } finally {
    db.close();
  }
  const sharp = require('sharp');
  const png = await sharp(Buffer.from([12, 34, 56]), { raw: { width: 1, height: 1, channels: 3 } }).png().toBuffer();
  assert.deepEqual(await sharp(png).removeAlpha().raw().toBuffer(), Buffer.from([12, 34, 56]));
  const checks = await verifyBrowser(require('@playwright/test'));
  console.log(JSON.stringify({ image: config.image, node: process.versions.node, python, installed,
    libvips: sharp.versions.vips, checks, totalReadyMs: Math.round(performance.now() - started) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await verifyBrowserEnvironment();
}
