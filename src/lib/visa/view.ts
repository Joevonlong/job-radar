/** The visa line of the job detail page, from the stored result (`getVisaOfJob`) and whether the user needs sponsorship. */
import type { VisaDetail } from "@/lib/db/repos/visa";

import type { VisaEvidence, VisaKind, VisaStatus } from "./types";

export type VisaCheckTone = "good" | "bad" | "dim";

export interface VisaCheckView {
  /** `not_checked`: no stored result yet (or no `job_visa` table). */
  state: VisaStatus | "not_checked";
  kind: VisaKind;
  /** Only a user who needs sponsorship gets colours: green for support, red for a refusal; everything else (and every user who does not need it) is neutral. */
  tone: VisaCheckTone;
  evidence: VisaEvidence[];
}

export function buildVisaCheckView(detail: VisaDetail | null, needsSponsorship: boolean): VisaCheckView {
  if (detail === null) return { state: "not_checked", kind: null, tone: "dim", evidence: [] };
  const tone: VisaCheckTone = !needsSponsorship ? "dim" : detail.status === "offered" ? "good" : detail.status === "not_offered" ? "bad" : "dim";
  return { state: detail.status, kind: detail.kind, tone, evidence: detail.evidence };
}

/**
 * The text the JD panel marks for a quote: its first line (a heading + next line quote spans a line break, and the JD panel
 * marks within one line).
 */
export function visaMarkText(quote: string): string {
  return (quote.split("\n")[0] ?? quote).trim();
}
