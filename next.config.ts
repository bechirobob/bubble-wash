import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/security";

const nextConfig: NextConfig = {
  poweredByHeader: false,
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
        source: "/(.*)",
        headers: securityHeaders(),
      },
    ];
  },
};

export default nextConfig;
