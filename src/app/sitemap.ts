import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const entries: Array<[string, MetadataRoute.Sitemap[number]["changeFrequency"], number]> = [
    ["", "weekly", 1],
    ["/services", "weekly", 0.9],
    ["/book", "weekly", 0.9],
    ["/early-access", "monthly", 0.8],
    ["/privacy", "yearly", 0.4],
    ["/terms", "yearly", 0.4],
    ["/refund-policy", "yearly", 0.4],
  ];
  return entries.map(([path, changeFrequency, priority]) => ({ url: `https://bubblewash.co${path || "/"}`, changeFrequency, priority }));
}
