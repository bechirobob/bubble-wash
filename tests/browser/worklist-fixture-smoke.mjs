import './block-egress.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// The graphical suite uses this exact synthetic fixture and cookie transport.
// No browser, real identity, provider connection or persistent credential is used.
const fixture = spawn(process.execPath, ['--conditions=react-server', '--experimental-strip-types', '--experimental-loader=./tests/alias-loader.mjs', 'tests/browser/start-worklist-fixture.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
for (const stream of [fixture.stdout, fixture.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-4000); });
const base = 'http://localhost:3195';
let checks = 0;
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks++; };
try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch {}
    if (ready) break;
    if (fixture.exitCode !== null) throw new Error('Synthetic worklist fixture exited before ready');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  equal(ready, true, 'Synthetic worklist fixture becomes healthy');
  equal((await fetch(`${base}/api/staff/automation/worklist`)).status, 401, 'Anonymous worklist denied');
  for (const [index, role] of ['admin', 'support', 'vendor', 'driver'].entries()) {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${101 + index}` }, body: JSON.stringify({ email: `${role}@example.invalid`, password: `synthetic-${role}-password-123` }) });
    equal(login.status, 200, `${role} synthetic login`);
    const cookieHeader = login.headers.getSetCookie().find(header => header.startsWith('bubblewash_staff_session='));
    assert.ok(cookieHeader && /;\s*HttpOnly(?:;|$)/i.test(cookieHeader) && /;\s*SameSite=Lax(?:;|$)/i.test(cookieHeader)); checks++;
    const headers = { cookie: cookieHeader.split(';')[0] };
    const page = await fetch(`${base}/staff/worklist`, { headers });
    equal(page.status, 200, `${role} staff worklist page`);
    const html = await page.text();
    assert.ok(html.includes('Worklist')); checks++;
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
    assert.ok(scripts.length); checks++;
    for (const script of scripts) equal((await fetch(new URL(script.replaceAll('&amp;', '&'), base))).status, 200, 'Worklist script asset');
    const response = await fetch(`${base}/api/staff/automation/worklist?filter=all`, { headers });
    equal(response.status, 200, `${role} scoped worklist API`);
    const data = await response.json();
    const hasCase = data.items.some(item => item.id === 'case-followup:BW-WORKLISTCASE');
    equal(hasCase, ['admin', 'support'].includes(role), `${role} exact case visibility`);
    equal((await fetch(`${base}/api/staff/automation/case?caseId=CASE-WORKLIST-REFERENCE`, { headers })).status, ['admin', 'support'].includes(role) ? 200 : 403, `${role} exact case authorization`);
    equal((await fetch(`${base}/api/staff/automation/notifications`, { headers })).status, role === 'admin' ? 200 : 403, `${role} message review authorization`);
    equal((await fetch(`${base}/api/staff/automation/ownership`, { method: 'POST', headers: { ...headers, origin: 'https://example.invalid', 'content-type': 'application/json' }, body: '{}' })).status, 403, 'Cross-origin worklist mutation denied');
  }
  console.log(JSON.stringify({ ok: true, checks, roles: 4, syntheticOnly: true, graphicalExecution: false }));
} catch (error) {
  console.error(output.slice(-1500));
  throw error;
} finally {
  if (fixture.exitCode === null) {
    const ended = new Promise(resolve => fixture.once('exit', resolve));
    fixture.kill('SIGTERM');
    await ended;
  }
}
