const cspDirectives = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https://images.unsplash.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https://api.paystack.co",
  "frame-src https://checkout.paystack.com",
  "upgrade-insecure-requests",
];

export function securityHeaders() {
  return [
    { key: "Content-Security-Policy", value: cspDirectives.join("; ") },
    { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self), payment=(self), usb=(), accelerometer=(), gyroscope=(), magnetometer=(), fullscreen=(self)" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  ];
}

export function privateNoStoreHeaders() {
  return [
    { key: "Cache-Control", value: "private, no-store, max-age=0, must-revalidate" },
    { key: "Pragma", value: "no-cache" },
  ];
}
