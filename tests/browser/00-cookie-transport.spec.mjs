import { test, expect } from '@playwright/test';
import http from 'node:http';
import { fixtureEdgeResponseHeaders } from './fixture-edge.mjs';

// Real HTTP rather than route.fulfill: exercise the engine's network cookie jar.
// No authentication token, app endpoint, provider, or production state is involved.
test('native and emulated loopback cookie transport premise', async ({ browser, browserName }) => {
  const server = http.createServer((request, response) => {
    if (request.url === '/native' || request.url === '/adapted') {
      const name = request.url === '/native' ? 'fixture_native' : 'fixture_adapted';
      const headers = { 'set-cookie': `${name}=fixture-only; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=60`, 'content-type': 'text/html' };
      response.writeHead(200, request.url === '/native' ? headers : fixtureEdgeResponseHeaders(headers, 'fixture_adapted'));
      response.end('<!doctype html><title>Cookie transport fixture</title>');
    } else if (request.url === '/probe') {
      response.setHeader('content-type', 'application/json');
      const names = (request.headers.cookie ?? '').split(';').map(value => value.trim().split('=')[0]);
      response.end(JSON.stringify({ nativeSent: names.includes('fixture_native'), adaptedSent: names.includes('fixture_adapted') }));
    } else response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://localhost:${server.address().port}`;
  const context = await browser.newContext();
  context.setDefaultNavigationTimeout(15_000);
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/native`);
    const nativeStored = (await context.cookies(origin)).some(cookie => cookie.name === 'fixture_native');
    await page.goto(`${origin}/probe`);
    const nativeSent = (await page.locator('body').textContent()).includes('"nativeSent":true');
    console.log(`Cookie transport ${browserName}: native Secure stored=${nativeStored}, sent=${nativeSent}`);
    // Fail rather than apply an unsupported WebKit diagnosis.
    // Some engine versions may retain a Secure cookie without transmitting it;
    // the actual HTTP request is the decisive authentication transport evidence.
    expect(nativeSent).toBe(browserName !== 'webkit');
    if (browserName !== 'webkit') expect(nativeStored).toBe(true);
    await page.goto(`${origin}/adapted`);
    const cookie = (await context.cookies(origin)).find(cookie => cookie.name === 'fixture_adapted');
    expect(Boolean(cookie), 'Adapted fixture cookie retained').toBe(true);
    expect({ secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, path: cookie.path }).toEqual({ secure: false, httpOnly: true, sameSite: 'Lax', path: '/' });
    await page.goto(`${origin}/probe`);
    const adaptedSent = (await page.locator('body').textContent()).includes('"adaptedSent":true');
    expect(adaptedSent, 'Adapted fixture cookie sent on real HTTP request').toBe(true);
    console.log(`Cookie transport ${browserName}: adapted sent=${adaptedSent}`);
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
