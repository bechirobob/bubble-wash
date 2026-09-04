import { privateNoStoreHeaders, securityHeaders } from "./src/lib/security-headers.js";

const appHtmlHeaders = [
  ...securityHeaders(),
  { key: "Cache-Control", value: "private, no-cache, no-store, max-age=0, must-revalidate" },
];

const nextConfig = {
  poweredByHeader: false,
  experimental: { cpus: 1 },
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    "*.lhr.life",
    "86d8b14ff63eb9.lhr.life",
    "9ce8c3a9b889e2.lhr.life",
  ],
  images: {
    remotePatterns: [{ protocol: "https", hostname: "images.unsplash.com" }],
  },
  async headers() {
    return [
      {
        source: "/",
        headers: appHtmlHeaders,
      },
      {
        source: "/login",
        headers: appHtmlHeaders,
      },
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
    ];
  },
};

export default nextConfig;
