// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildScorePrompt, REFERENCE_OUTPUT, SCORE_PROMPT_VERSION, scoreOutputSchema, scoreOutputSchemaFor, scorePromptFor, type ScorePromptJob } from "@/lib/ai/prompts/score";
import { toJsonSchema } from "@/lib/ai/schema-to-json";
import { scoreLanguageOf } from "@/lib/scoring/score-task";

import { fixtureMarket, shippedPipeline } from "../pipeline/helpers";
import { examplePreferences, exampleMe } from "./helpers";

/** Reason sources in the scoring prompt: an addition at the very end that never changes the version (nothing is re-scored). */
const GERMAN = scoreLanguageOf(shippedPipeline());
const NO_STEP = scoreLanguageOf(shippedPipeline(fixtureMarket({ pack: "generic", country: "US", currency: "USD", home_language: "en" })));
const CRITERIA = { priorities: ["Remote first"], dealbreakers: [], nice_to_have: [] };

const job: ScorePromptJob = {
  title: "Forward Deployed Engineer",
  company: "Quillfeather Labs",
  locations: ["Berlin"],
  workplace: "hybrid",
  seniority: "senior",
  contract: "permanent",
  salary: null,
  description: "Build retrieval pipelines for customers.",
};

const build = (extra: { evidence?: boolean; quoteMaxChars?: number } = {}) =>
  buildScorePrompt({ me: exampleMe(), preferences: examplePreferences(), job, jdMaxChars: 6000, jdHeadShare: 0.7, language: GERMAN, currency: "EUR", ...extra });

describe("reason sources in the prompt", () => {
  it("evidence off (or absent) renders byte-identical system and user texts", () => {
    const plain = build();
    expect(build({ evidence: false })).toEqual(plain);
    expect(build({ evidence: false, quoteMaxChars: 80 })).toEqual(plain);
    expect(plain.system).not.toContain("Reason sources");
  });

  it("evidence on appends the instructions at the very end and leaves the rest and the user text alone", () => {
    const plain = build();
    const on = build({ evidence: true, quoteMaxChars: 120 });
    expect(on.user).toBe(plain.user);
    expect(on.system.startsWith(plain.system)).toBe(true);
    const added = on.system.slice(plain.system.length);
    expect(added).toContain('"basis": "jd"');
    expect(added).toContain('"unstated"');
    expect(added).toContain("at most 120 characters");
    expect(added).toMatch(/word for word in the posting's own language: never translated/);
    expect(added).toContain('use "inferred"');
  });

  it("keeps score-v1 for the German market with evidence on", () => {
    expect(scorePromptFor(GERMAN).version).toBe(SCORE_PROMPT_VERSION);
    expect(scorePromptFor(GERMAN, { evidence: true }).version).toBe("score-v1");
    expect(scorePromptFor(GERMAN, { evidence: true, quoteMaxChars: 40, output: { language: "en", also: [] } }).version).toBe("score-v1");
  });

  it("keeps the version string of a market other than Germany", () => {
    const off = scorePromptFor(NO_STEP).version;
    expect(off).toMatch(/^score-v1\+m[0-9a-f]{8}$/);
    expect(scorePromptFor(NO_STEP, { evidence: true }).version).toBe(off);
    const fr = { name: "French", examples: "courant = C1" };
    expect(scorePromptFor(fr, { evidence: true }).version).toBe(scorePromptFor(fr).version);
  });

  it("keeps the +c rule of the criteria", () => {
    const withCriteria = scorePromptFor(GERMAN, { criteria: CRITERIA }).version;
    expect(withCriteria).toMatch(/^score-v1\+c[0-9a-f]{8}$/);
    expect(scorePromptFor(GERMAN, { criteria: CRITERIA, evidence: true }).version).toBe(withCriteria);
    expect(scorePromptFor(GERMAN, { criteria: CRITERIA, evidence: true }).system.endsWith(".")).toBe(true);
  });

  it("evidence off sends the old answer schema", () => {
    expect(toJsonSchema(scoreOutputSchemaFor(REFERENCE_OUTPUT))).toEqual(toJsonSchema(scoreOutputSchema));
    expect(toJsonSchema(scoreOutputSchemaFor(REFERENCE_OUTPUT, { evidence: false }))).toEqual(toJsonSchema(scoreOutputSchema));
  });
});
