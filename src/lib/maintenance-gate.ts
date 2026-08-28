const operationalPaths = new Set([
  "/api/health",
  "/api/ready",
  "/api/internal/maintenance",
  "/api/internal/metrics",
]);

const publicAssetPaths = new Set([
  "/apple-icon.png",
  "/bubble-wash-icon.jpg",
  "/favicon.ico",
  "/favicon.png",
  "/icon-512.png",
  "/maintenance.css",
  "/site.webmanifest",
]);

export function isMaintenanceBypassPath(pathname: string) {
  return pathname.startsWith("/_next/") || operationalPaths.has(pathname) || publicAssetPaths.has(pathname);
}

export function maintenanceHeaders(contentType: string) {
  return {
    "Cache-Control": "private, no-store, max-age=0, must-revalidate",
    "CDN-Cache-Control": "no-store",
    "Cloudflare-CDN-Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "Retry-After": "3600",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  };
}

export const maintenanceApiBody = JSON.stringify({
  error: "service_unavailable",
  message: "Bubble Wash is temporarily unavailable while the service is under maintenance.",
});

export const maintenanceHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow, noarchive">
    <meta name="theme-color" content="#edf9ff">
    <title>Bubble Wash — Under maintenance</title>
    <link rel="icon" href="/favicon.png">
    <link rel="stylesheet" href="/maintenance.css">
  </head>
  <body>
    <main class="maintenance" data-bubblewash-maintenance>
      <section class="message" aria-labelledby="maintenance-title">
        <img class="brand" src="/bubble-wash-icon.jpg" alt="Bubble Wash">
        <p class="status"><span aria-hidden="true"></span> 503 · Short maintenance break</p>
        <h1 id="maintenance-title">We’re taking a quick wash cycle.</h1>
        <p class="intro">Bubble Wash is temporarily unavailable while we prepare things behind the scenes.</p>
        <p class="return">Please check back soon — we’ll be fresh again shortly.</p>
      </section>
      <div class="laundry-scene" aria-hidden="true">
        <div class="bubbles bubbles-top"><i></i><i></i><i></i></div>
        <div class="washer">
          <div class="washer-controls"><i></i><i></i><i></i></div>
          <div class="washer-door"><div class="linen"></div></div>
        </div>
        <div class="bubbles bubbles-bottom"><i></i><i></i></div>
        <p>PAUSED FOR A CLEAN-UP</p>
      </div>
    </main>
  </body>
</html>`;
