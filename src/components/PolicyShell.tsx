import type { ReactNode } from "react";
import { PageIntro, PublicChrome } from "@/components/PublicChrome";

export function PolicyShell({ eyebrow, title, summary, children }: { eyebrow: string; title: string; summary: string; children: ReactNode }) {
  const legalEntity = process.env.BUBBLEWASH_LEGAL_ENTITY_NAME?.trim() || "Bubble Wash";
  const registration = process.env.BUBBLEWASH_DPC_REGISTRATION_NUMBER?.trim();
  summary = `${summary} ${legalEntity} operates Bubble Wash.${registration ? ` Ghana Data Protection Commission registration: ${registration}.` : ""}`;
  return <PublicChrome skipTo="policy-content"><PageIntro eyebrow={eyebrow} title={title} summary={summary} icon="policy" /><div className="policyEffective pageShell"><small>Effective 16 August 2026 · Version 1.0</small></div><article className="policyContent pageShell" id="policy-content">{children}</article></PublicChrome>;
}
