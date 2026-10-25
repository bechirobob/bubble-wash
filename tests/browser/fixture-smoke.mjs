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
  const loginPage = await fetch(`${base}/login`);
  assert.equal(loginPage.headers.has('strict-transport-security'), false, 'HTTP fixture omits HSTS only at the edge');
  const csp = loginPage.headers.get('content-security-policy');
  assert.ok(csp && !csp.includes('upgrade-insecure-requests'));
  for (const directive of ["default-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'"]) assert.ok(csp.includes(directive), 'Other CSP directives remain intact');
  assert.equal(loginPage.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(loginPage.headers.get('x-frame-options'), 'DENY');
  const html = await loginPage.text();
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
    // Verify the actual production-mode upstream still emits transport security.
    // Only attribute names/values are compared; session values never leave memory.
    const upstream = await fetch('http://localhost:3101/api/login', { method: 'POST', headers: { origin: 'https://localhost:3101', 'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${90 + index}` }, body });
    assert.equal(upstream.status, 200, `${role} production-mode upstream login`);
    const attributes = header => header.split(';').slice(1).map(value => value.trim().toLowerCase()).filter(value => !value.startsWith('expires=')).sort();
    const upstreamCookie = upstream.headers.getSetCookie().find(value => value.startsWith('bubblewash_staff_session='));
    assert.ok(upstreamCookie, 'Upstream sets the staff session');
    const upstreamAttributes = attributes(upstreamCookie);
    for (const attribute of ['secure', 'httponly', 'samesite=lax', 'path=/']) assert.ok(upstreamAttributes.includes(attribute), `Upstream retains ${attribute}`);
    const setCookies = response.headers.getSetCookie();
    const edgeCookie = setCookies.find(value => value.startsWith('bubblewash_staff_session='));
    assert.ok(edgeCookie, 'Edge sets the staff session');
    assert.deepEqual(attributes(edgeCookie), upstreamAttributes.filter(value => value !== 'secure'), 'Edge preserves upstream cookie attributes except Secure');
    const expiry = header => header.split(';').slice(1).map(value => value.trim()).find(value => /^expires=/i.test(value));
    assert.equal(Boolean(expiry(edgeCookie)), Boolean(expiry(upstreamCookie)), 'Expiry presence retained');
    if (expiry(upstreamCookie)) assert.ok(Math.abs(Date.parse(expiry(edgeCookie).slice(8)) - Date.parse(expiry(upstreamCookie).slice(8))) <= 2000, 'Independent login expiries differ only by request timing');
    assert.ok(setCookies.length > 0);
    for (const header of setCookies) {
      assert.ok(!/;\s*Secure(?:;|$)/i.test(header), 'Local HTTP cookie has no Secure transport flag');
      assert.ok(/;\s*HttpOnly(?:;|$)/i.test(header), 'HttpOnly retained');
      assert.ok(/;\s*SameSite=Lax(?:;|$)/i.test(header), 'SameSite retained');
      assert.ok(/;\s*Path=\/(?:;|$)/i.test(header), 'Path retained');
    }
    const cookie = setCookies.map(value => value.split(';')[0]).join('; ');
    // Reuse the same cookie across repeated fresh document requests, never renew it.
    for (const origin of [base, 'http://localhost:3102']) {
      for (const entry of ['/staff', '/staff', '/login?next=/admin', '/login?next=/drivers', '/login?next=https://example.invalid', '/login?next=/admin&next=/drivers']) {
        const reopened = await fetch(`${origin}${entry}`, { headers: { cookie }, redirect: 'manual' });
        assert.equal(reopened.headers.has('set-cookie'), false, 'Reopen must not renew session');
        if (reopened.status === 307) {
          assert.equal(new URL(reopened.headers.get('location'), origin).pathname, path, `${role} role-safe reopen`);
        } else {
          assert.equal(reopened.status, 200);
          const html = await reopened.text();
          assert.ok(html.includes(`content="0;url=${path}"`) || html.includes(`content="1;url=${path}"`), `${role} streamed reopen redirect`);
        }
      }
    }
    const workspace = await fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(workspace.status, 200, `${role} cookie-backed workspace`);
    assert.equal(workspace.headers.get('x-fixture-staff-cookie-received'), 'true', 'Edge observes workspace cookie');
    const anonymous = await fetch(`${base}${path}`, { redirect: 'manual' });
    assert.equal(anonymous.headers.get('x-fixture-staff-cookie-received'), 'false', 'Edge observes anonymous workspace without cookie');
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
  console.log(JSON.stringify({ ok: true, roles: 4, scripts: scripts.length, checks: 'repeated role-safe session reopen on both hosts without renewal, native-origin login, cookie-backed workspace and redirect, script assets, cross-origin rejection through synthetic edge' }));
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
