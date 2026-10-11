import { createHash } from "node:crypto";

import type { VisaRulesInput } from "./rules";

/**
 * Bump when the detection changes in a way the packs do not show (segmenting, the negation window, how results are summed up):
 * every job is checked again by the next cycles.
 */
export const VISA_RULES_VERSION = 1;

/** Hash of the packs' visa section, the detection version and the quote limits: a change checks every job again. */
export function visaRulesFingerprint(config: VisaRulesInput): string {
  const limits = config.job_checks.visa;
  const relevant = { version: VISA_RULES_VERSION, pack: config.visa, max_quotes: limits.max_quotes, quote_max_chars: limits.quote_max_chars };
  return createHash("sha256").update(JSON.stringify(relevant)).digest("hex").slice(0, 32);
}
