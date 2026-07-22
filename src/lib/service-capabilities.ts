export type ServiceCapability = "wash-fold" | "wash-iron-fold" | "ironing" | "express" | "bulk";

const serviceLabels: Record<ServiceCapability, string> = {
  "wash-fold": "Wash + fold",
  "wash-iron-fold": "Wash + iron + fold",
  ironing: "Ironing only",
  express: "Express capable",
  bulk: "Bulk commercial",
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isServiceCapability(value: string): value is ServiceCapability {
  return Object.hasOwn(serviceLabels, value);
}

export function serviceCapability(value: unknown) {
  const normalized = text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.includes("express")) return "express";
  if (normalized.includes("bulk")) return "bulk";
  if (normalized.includes("wash") && normalized.includes("iron")) return "wash-iron-fold";
  if (normalized.includes("wash") && normalized.includes("fold")) return "wash-fold";
  if (normalized.includes("iron")) return "ironing";
  return normalized.replaceAll(" ", "-");
}

export function serviceCapabilityLabel(value: unknown) {
  const capability = serviceCapability(value);
  return isServiceCapability(capability) ? serviceLabels[capability] : text(value);
}

export function parseServiceTypes(value: unknown) {
  const entries = text(value)
    .split(/[,;\n]+/)
    .map(serviceCapabilityLabel)
    .filter(Boolean);
  return [...new Set(entries)];
}
