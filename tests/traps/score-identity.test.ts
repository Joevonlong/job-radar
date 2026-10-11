// @vitest-environment node
import { describe, expect, it } from "vitest";

import { BREAKDOWN_PROMPT_VERSION } from "@/lib/ai/prompts/breakdown";
import { buildScorePrompt, SCORE_PROMPT_VERSION } from "@/lib/ai/prompts/score";
import { LEGACY_SIGNALS_PROMPT_VERSION } from "@/lib/ai/prompts/signals";
import { signalsPrompt } from "@/lib/signals/fingerprint";

import { shippedPipeline } from "../pipeline/helpers";
import { shippedInterests } from "../signals/helpers";
import { SUGGEST_PROMPT_VERSION } from "@/lib/ai/prompts/suggest";
import { TRANSLATE_PROMPT_VERSION } from "@/lib/ai/prompts/translate";
import { jdForAi } from "@/lib/traps/ai-input";
import { scoreLanguageOf } from "@/lib/scoring/score-task";

import { fixedMe, fixedPreferences, trapFixture } from "./helpers";

/**
 * Contract: the trap feature never changes an existing prompt. The scoring prompt of a job without traps equals the one
 * stored before trap detection (tests/fixtures/traps/score-prompt-no-traps.txt; the remote scope was renamed `eu_hire_in_de` to
 * `home_country` in the user part, the system part is unchanged), and the five prompt versions keep their values, so no
 * score, signal review, translation, breakdown or suggestion goes stale.
 */
describe("existing prompts are untouched", () => {
  it("the scoring prompt of a job without traps is byte-identical to the stored snapshot", () => {
    const description = "Quillfeather Labs is hiring a Forward Deployed Engineer.\n## What you will do\n- Build RAG systems with Python.\n## What we offer\n- Salary range: EUR 85,000 to 105,000 per year.\nWe expect good written English.";
    const forAi = jdForAi(description, [], { hidden: "[h]", instruction: "[i]" });
    expect(forAi).toBe(description);
    const prompt = buildScorePrompt({
      me: fixedMe(),
      preferences: fixedPreferences(),
      job: { title: "Forward Deployed Engineer", company: "Quillfeather Labs", locations: ["Berlin, Germany"], workplace: "hybrid", seniority: "senior", contract: "permanent", salary: "EUR 85,000 to 105,000 per year", description: forAi },
      jdMaxChars: 12000,
      jdHeadShare: 0.7,
      glossary: { RAG: "RAG" },
      // The German market of the fixture configuration
      language: scoreLanguageOf(shippedPipeline()),
      currency: "EUR",
    });
    expect(`${prompt.system}\n=====\n${prompt.user}`).toBe(trapFixture("score-prompt-no-traps.txt"));
  });

  // The translation prompt names its configurable target language (translate-v3); its version is only logged, translations are
  // keyed by the description hash, so no stored translation goes stale
  // suggest-v3 stores the reasons per language (suggestions only log the version; nothing goes stale)
  it("keeps the five prompt versions (the signals version of the default categories; the suggestion prompt became suggest-v2 with the categories)", () => {
    expect(signalsPrompt(shippedInterests())?.version).toBe(LEGACY_SIGNALS_PROMPT_VERSION);
    expect([SCORE_PROMPT_VERSION, LEGACY_SIGNALS_PROMPT_VERSION, TRANSLATE_PROMPT_VERSION, BREAKDOWN_PROMPT_VERSION, SUGGEST_PROMPT_VERSION]).toEqual(["score-v1", "signals-v1", "translate-v3", "breakdown-v1", "suggest-v3"]);
  });
});
