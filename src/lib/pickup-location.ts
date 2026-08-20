import type { ZoneKey } from "./pricing.ts";

type LocalityRule = {
  locality: string;
  clusterKey: string;
  zone: ZoneKey;
  patterns: string[];
};

const localityRules: LocalityRule[] = [
  { locality: "Osu", clusterKey: "accra-osu", zone: "core", patterns: ["osu"] },
  { locality: "Labone", clusterKey: "accra-labone", zone: "core", patterns: ["labone"] },
  { locality: "Cantonments", clusterKey: "accra-cantonments", zone: "core", patterns: ["cantonments"] },
  { locality: "Airport Residential", clusterKey: "accra-airport-residential", zone: "core", patterns: ["airport residential", "airport city"] },
  { locality: "East Legon", clusterKey: "accra-east-legon", zone: "core", patterns: ["east legon"] },
  { locality: "Roman Ridge", clusterKey: "accra-roman-ridge", zone: "core", patterns: ["roman ridge"] },
  { locality: "Ridge", clusterKey: "accra-ridge", zone: "near", patterns: ["north ridge", "west ridge", "ridge"] },
  { locality: "Dzorwulu", clusterKey: "accra-dzorwulu", zone: "near", patterns: ["dzorwulu"] },
  { locality: "Spintex", clusterKey: "accra-spintex", zone: "near", patterns: ["spintex"] },
  { locality: "Madina", clusterKey: "accra-madina", zone: "near", patterns: ["madina"] },
  { locality: "Adabraka", clusterKey: "accra-adabraka", zone: "near", patterns: ["adabraka"] },
  { locality: "Kokomlemle", clusterKey: "accra-kokomlemle", zone: "near", patterns: ["kokomlemle"] },
  { locality: "Tesano", clusterKey: "accra-tesano", zone: "near", patterns: ["tesano"] },
  { locality: "Achimota", clusterKey: "accra-achimota", zone: "near", patterns: ["achimota"] },
  { locality: "Dansoman", clusterKey: "accra-dansoman", zone: "near", patterns: ["dansoman"] },
  { locality: "Teshie", clusterKey: "accra-teshie", zone: "near", patterns: ["teshie"] },
  { locality: "Nungua", clusterKey: "accra-nungua", zone: "near", patterns: ["nungua"] },
  { locality: "Tema", clusterKey: "greater-accra-tema", zone: "outer", patterns: ["tema"] },
  { locality: "Sakumono", clusterKey: "greater-accra-sakumono", zone: "outer", patterns: ["sakumono"] },
  { locality: "Lashibi", clusterKey: "greater-accra-lashibi", zone: "outer", patterns: ["lashibi"] },
  { locality: "Ashaiman", clusterKey: "greater-accra-ashaiman", zone: "outer", patterns: ["ashaiman"] },
  { locality: "Adenta", clusterKey: "greater-accra-adenta", zone: "outer", patterns: ["adenta"] },
];

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function classifyPickupLocation(address: string) {
  const normalizedAddress = normalize(address);
  const match = localityRules.find((rule) => rule.patterns.some((pattern) => (
    ` ${normalizedAddress} `.includes(` ${normalize(pattern)} `)
  )));

  if (!match) {
    return {
      locality: "Locality review needed",
      clusterKey: "greater-accra-unmapped",
      zone: "custom" as ZoneKey,
      confidence: "unmapped" as const,
    };
  }

  return {
    locality: match.locality,
    clusterKey: match.clusterKey,
    zone: match.zone,
    confidence: "address-match" as const,
  };
}
