import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/services", "/book", "/track", "/early-access", "/privacy", "/terms", "/refund-policy"],
      disallow: ["/api/", "/admin", "/vendors", "/drivers", "/support", "/staff", "/login", "/manage", "/scan"],
    },
    sitemap: "https://bubblewash.co/sitemap.xml",
    host: "https://bubblewash.co",
  };
}
