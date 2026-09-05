import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Reuse one production build under different runtime flags: no build-time availability snapshot.
const directory = mkdtempSync(join(tmpdir(), 'bubblewash-public-'));
const origin = 'http://127.0.0.1:3101';
let checks = 0;
try {
  for (const [staffLocked, bookingsDisabled] of [[true, false], [false, true], [false, false]]) {
    const paused = staffLocked || bookingsDisabled;
    const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', '3101'], {
      env: { ...process.env, NODE_ENV: 'production', BUBBLEWASH_STAFF_AUTH_DISABLED: String(staffLocked), BUBBLEWASH_BOOKINGS_DISABLED: String(bookingsDisabled), BUBBLEWASH_DATABASE_PATH: join(directory, 'public.sqlite'), BUBBLEWASH_DISABLE_DEMO_LOGIN: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    server.stdout.on('data', (data) => output += data);
    server.stderr.on('data', (data) => output += data);
    try {
      let ready = false;
      for (let i = 0; i < 60; i++) {
        if (server.exitCode !== null) throw new Error(output);
        try { ready = (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.ok(ready, output);
      for (const path of ['/', '/services', '/book', '/track', '/manage', '/early-access']) {
        const response = await fetch(`${origin}${path}`);
        assert.equal(response.status, 200, path); checks++;
        const html = (await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
        const navigation = html.match(/<nav\b[^>]*aria-label="Main navigation"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
        assert.ok(navigation, `${path} renders navigation`);
        if (paused) {
          assert.doesNotMatch(navigation, /href="\/book"/);
          assert.match(navigation, /View services/);
        } else {
          assert.match(navigation, /href="\/book"/);
          assert.match(navigation, /Request pickup/);
        }
        checks++;
        if (path === '/') {
          assert.match(html, /Laundry pickup/);
          assert.match(html, /laundry-care-hero/);
          assert.match(html, /bubble-wash-icon/);
          if (paused) assert.match(html, /New pickups are paused/);
          else assert.match(html, /Request a pickup/);
          checks++;
        }
        if (path === '/book') {
          if (paused) {
            assert.match(html, /A short pause on new pickups\./);
            assert.doesNotMatch(html, /name="pickupDate"/);
          } else assert.match(html, /name="pickupDate"/);
          checks++;
        }
      }
      const image = await fetch(`${origin}/laundry-care-hero.webp`);
      assert.equal(image.status, 200);
      assert.match(image.headers.get('content-type'), /image\/webp/); checks++;
    } finally {
      if (server.exitCode === null) {
        const exited = new Promise((resolve) => server.once('exit', resolve));
        server.kill('SIGTERM'); await exited;
      }
    }
  }
  console.log(JSON.stringify({ ok: true, checks, scope: 'six public routes, original brand asset, hero image, request-time availability under both locks and open bookings' }));
} finally { rmSync(directory, { recursive: true, force: true }); }
