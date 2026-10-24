/* Bubble Wash: network-only navigation, with no response or submission storage. */
const offlinePage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>You're offline · Bubble Wash</title><style>body{margin:0;padding:32px 24px;background:#fff;color:#102a38;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:420px;margin:12vh auto}h1{font-size:28px;line-height:1.2}p{color:#526573}a{display:inline-flex;align-items:center;min-height:44px;color:#0b4960}a:focus-visible{outline:3px solid #102a38;outline-offset:4px}</style></head><body><main><p>Bubble Wash</p><h1>You're offline.</h1><p>Reconnect to open this page. Orders and survey responses cannot be sent offline.</p><a href="">Try again</a></main></body></html>`;

// Updates activate after existing app windows close. Never reload an active form.
self.addEventListener("activate", event => { event.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || request.mode !== "navigate" || url.origin !== self.location.origin || url.pathname === "/api" || url.pathname.startsWith("/api/")) return;
  event.respondWith(fetch(request, { cache: "no-store" }).catch(() => new Response(offlinePage, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" },
  })));
});
