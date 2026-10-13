// @vitest-environment node
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { VISA_RULES_VERSION, visaRulesFingerprint } from "@/lib/visa/fingerprint";

import { shippedPipeline } from "../pipeline/helpers";

/** The fingerprint as the code computes it, for a given detection version. */
function fingerprintAt(version: number): string {
  const config = shippedPipeline();
  const visa = config.job_checks.visa;
  const limits = {
    max_quotes: visa.max_quotes,
    quote_max_chars: visa.quote_max_chars,
    negation_words_before: visa.negation_words_before,
    negation_words_after: visa.negation_words_after,
    heading_max_chars: visa.heading_max_chars,
  };
  return createHash("sha256").update(JSON.stringify({ version, pack: config.visa, limits })).digest("hex").slice(0, 32);
}

describe("visaRulesFingerprint", () => {
  it("hashes the detection version with the packs and limits", () => {
    expect(visaRulesFingerprint(shippedPipeline())).toBe(fingerprintAt(VISA_RULES_VERSION));
  });

  // the clause breaks are matched over the whole segment now: a result a pack's break could change is checked again
  it("is no longer the fingerprint of the version before the negation index", () => {
    expect(VISA_RULES_VERSION).not.toBe(3);
    expect(visaRulesFingerprint(shippedPipeline())).not.toBe(fingerprintAt(3));
  });
});
