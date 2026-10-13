import { createHash } from "node:crypto";

import type { VisaRulesInput } from "./rules";

/**
 * Bump when the detection changes in a way the packs do not show (segmenting, the negation window, how results are summed up):
 * every job is checked again by the next cycles.
 */
export const VISA_RULES_VERSION = 4;

/** Hash of the packs' visa section, the detection version and the limits that shape a result: a change checks every job again. */
export function visaRulesFingerprint(config: VisaRulesInput): string {
  const visa = config.job_checks.visa;
  const limits = {
    max_quotes: visa.max_quotes,
    quote_max_chars: visa.quote_max_chars,
    negation_words_before: visa.negation_words_before,
    negation_words_after: visa.negation_words_after,
    heading_max_chars: visa.heading_max_chars,
  };
  const relevant = { version: VISA_RULES_VERSION, pack: config.visa, limits };
  return createHash("sha256").update(JSON.stringify(relevant)).digest("hex").slice(0, 32);
}
