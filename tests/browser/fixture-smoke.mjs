import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const server = spawn(process.execPath, ['--conditions=react-server', '--experimental-strip-types', '--experimental-loader=./tests/alias-loader.mjs', 'tests/browser/start-fixture.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });
const base = 'http://localhost:3100';
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch {}
    if (ready) break;
    if (server.exitCode !== null) throw new Error('Synthetic fixture exited before ready');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, 'Synthetic fixture health');
  const html = await (await fetch(`${base}/login`)).text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scripts.length > 0, 'Login must expose its script assets');
  for (const script of scripts) {
    const url = new URL(script.replaceAll('&amp;', '&'), base);
    assert.equal(url.origin, base);
    assert.equal((await fetch(url)).status, 200, 'Local script must load without forced Origin');
  }
  for (const [index, role] of ['admin', 'vendor', 'driver', 'support'].entries()) {
    const body = JSON.stringify({ email: `${role}@example.invalid`, password: `synthetic-${role}-password-123` });
    const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${80 + index}` }, body });
    assert.equal(response.status, 200, `${role} native-origin edge login`);
    const login = await response.json();
    assert.equal(login.user.role, role);
    const path = { admin: '/admin', vendor: '/vendors', driver: '/drivers', support: '/support' }[role];
    assert.equal(login.next, path);
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const workspace = await fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(workspace.status, 200, `${role} cookie-backed workspace`);
    const anonymous = await fetch(`${base}${path}`, { redirect: 'manual' });
    if (anonymous.status === 307) {
      assert.equal(new URL(anonymous.headers.get('location'), base).pathname, '/login');
    } else {
      // Next.js streams a meta redirect when the response has already started.
      assert.equal(anonymous.status, 200);
      const anonymousHtml = await anonymous.text();
      assert.ok(/<meta[^>]+http-equiv="refresh"[^>]+content="[01];url=\/login\?next=/.test(anonymousHtml), `${role} streamed anonymous login redirect`);
    }
    const orders = await fetch(`${base}/api/orders`, { headers: { cookie } });
    assert.equal(orders.status, 200, `${role} session cookie survives edge`);
    const denied = await fetch(`${base}/api/login`, { method: 'POST', headers: { origin: 'https://example.invalid', 'content-type': 'application/json' }, body });
    assert.equal(denied.status, 403, 'Production cross-origin protection stays active');
  }
  console.log(JSON.stringify({ ok: true, roles: 4, scripts: scripts.length, checks: 'native-origin login, cookie-backed workspace and redirect, script assets, cross-origin rejection through synthetic edge' }));
} catch (error) {
  // Server startup output does not contain request bodies or credentials.
  console.error(output.slice(-1500));
  throw error;
} finally {
  if (server.exitCode === null) {
    const ended = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await ended;
  }
}
