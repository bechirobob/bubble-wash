import { privateNoStoreHeaders, securityHeaders } from "./src/lib/security-headers.js";

const appHtmlHeaders = [
  ...securityHeaders(),
  { key: "Cache-Control", value: "private, no-cache, no-store, max-age=0, must-revalidate" },
];

const nextConfig = {
  poweredByHeader: false,
  // Keep verified release files immutable; runtime route caches stay in memory.
  experimental: { cpus: 1, isrFlushToDisk: false },
  // Keep local HTTP previews compatible with the development asset server.
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    "terminal.local",
    "*.lhr.life",
    "86d8b14ff63eb9.lhr.life",
    "9ce8c3a9b889e2.lhr.life",
  ],
  images: {
    remotePatterns: [{ protocol: "https", hostname: "images.unsplash.com" }],
  },
  async redirects() {
    return [{ source: "/", has: [{ type: "host", value: "staff.bubblewash.co" }], destination: "/staff", permanent: false }];
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }],
      },
      {
        source: "/",
        headers: appHtmlHeaders,
      },
      {
        source: "/login",
        headers: appHtmlHeaders,
      },
      { source: "/api/staff/:path*", headers: privateNoStoreHeaders() },
      {
        source: "/staff",
        headers: appHtmlHeaders,
      },
      {
        source: "/admin",
        headers: appHtmlHeaders,
      },
      {
        source: "/vendors",
        headers: appHtmlHeaders,
      },
      {
        source: "/drivers",
        headers: appHtmlHeaders,
      },
      {
        source: "/support",
        headers: appHtmlHeaders,
      },
      {
        source: "/api/dispatch/location",
        headers: privateNoStoreHeaders(),
      },
      {
        source: "/(.*)",
        headers: securityHeaders(),
      },
      { source: "/staff/activate", headers: [...appHtmlHeaders, { key: "Referrer-Policy", value: "no-referrer" }] },

    ];
  },
};

export default nextConfig;
