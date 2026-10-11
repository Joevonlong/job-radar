// @vitest-environment node
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { buildBreakdownPrompt } from "@/lib/ai/prompts/breakdown";
import { buildScorePrompt, criteriaFingerprint, scoreOutputSchemaFor, scorePromptFor, summariesOfAnswer, NO_CRITERIA, REFERENCE_OUTPUT, SCORE_PROMPT_VERSION } from "@/lib/ai/prompts/score";
import { buildSuggestPrompt, suggestOutputSchemaFor } from "@/lib/ai/prompts/suggest";
import { suggestionPayloadSchema } from "@/lib/interests/suggestion";

import { scoreLanguageOf } from "@/lib/scoring/score-task";

import { shippedPipeline } from "../pipeline/helpers";
import { fixedMe, fixedPreferences } from "../traps/helpers";

// the German market as shipped (the rendering every score before the language settings was made with)
const GERMAN = scoreLanguageOf(shippedPipeline());
const job = { title: "ML Engineer", company: "Acme", locations: ["Berlin"], workplace: "hybrid", seniority: "senior", contract: "permanent", salary: null, description: "Build RAG systems." };
const score = (extra: Partial<Parameters<typeof buildScorePrompt>[0]> = {}) =>
  buildScorePrompt({ me: fixedMe(), preferences: fixedPreferences(), job, jdMaxChars: 4000, jdHeadShare: 0.7, glossary: { RAG: "RAG" }, language: GERMAN, currency: "EUR", ...extra });
const keys = (schema: z.ZodType) => Object.keys((z.toJSONSchema(schema) as { properties: Record<string, unknown> }).properties);

describe("score prompt in the AI output language", () => {
  it("renders the reference (Chinese + English summary) when nothing is given, and the version stays score-v1", () => {
    expect(score().system).toBe(score({ output: REFERENCE_OUTPUT, criteria: NO_CRITERIA }).system);
    expect(scorePromptFor(GERMAN, { output: REFERENCE_OUTPUT }).version).toBe(SCORE_PROMPT_VERSION);
  });

  it("writes English reasons and one English summary when ai.output is en", () => {
    const prompt = score({ output: { language: "en", also: [] } });
    expect(prompt.system).not.toMatch(/Chinese/);
    expect(prompt.system).toContain('"fit_reasons": at most 4 short sentences in English');
    expect(prompt.system).toContain('"summary_en": one English sentence saying what the role is.');
    expect(prompt.user).toContain("render these terms exactly like this in English text");
    expect(keys(scoreOutputSchemaFor({ language: "en", also: [] }))).toEqual(["score", "fit_reasons", "gaps", "german_level_required", "summary_en"]);
  });

  it("asks for one summary per summary language and reads them back by language", () => {
    const output = { language: "fr", also: ["en", "pt-BR"] };
    expect(score({ output }).system).toContain('"summary_fr": one French sentence saying what the role is. "summary_en": the same in one English sentence. "summary_pt_br": the same in one Brazilian Portuguese sentence.');
    expect(keys(scoreOutputSchemaFor(output)).slice(4)).toEqual(["summary_fr", "summary_en", "summary_pt_br"]);
    expect(summariesOfAnswer({ summary_fr: " Un poste. ", summary_en: "A role.", summary_pt_br: "" }, output)).toEqual({ fr: "Un poste.", en: "A role." });
  });

  it("does not change the version with the output language (no re-scoring on a language change)", () => {
    expect(scorePromptFor(GERMAN, { output: { language: "en", also: [] } }).version).toBe(SCORE_PROMPT_VERSION);
    expect(scorePromptFor(GERMAN, { output: { language: "fr", also: ["zh"] } }).version).toBe(SCORE_PROMPT_VERSION);
  });
});

describe("scoring criteria", () => {
  const criteria = { priorities: ["Applied ML over research"], dealbreakers: ["Unpaid overtime"], nice_to_have: ["A learning budget"] };

  it("puts the criteria into a fixed section of the prompt and versions them", () => {
    const system = score({ criteria }).system;
    expect(system).toContain("The candidate's own scoring criteria");
    expect(system).toContain('- Dealbreakers: if the posting clearly has one of these, the score is 0-29:\n  - "Unpaid overtime"');
    expect(scorePromptFor(GERMAN, { criteria }).version).toMatch(/^score-v1\+c[0-9a-f]{8}$/);
  });

  it("keeps the version stable over whitespace and empty entries; no criteria = score-v1", () => {
    const spaced = { priorities: ["  Applied   ML over research "], dealbreakers: ["Unpaid overtime", " "], nice_to_have: ["A learning budget"] };
    expect(criteriaFingerprint(spaced)).toBe(criteriaFingerprint(criteria));
    expect(criteriaFingerprint({ ...criteria, nice_to_have: [] })).not.toBe(criteriaFingerprint(criteria));
    expect(criteriaFingerprint(NO_CRITERIA)).toBeNull();
    expect(criteriaFingerprint({ priorities: [" "], dealbreakers: [], nice_to_have: [] })).toBeNull();
    expect(scorePromptFor(GERMAN, { criteria: NO_CRITERIA }).version).toBe(SCORE_PROMPT_VERSION);
  });

  it("keeps the market part of a version when there are criteria", () => {
    const other = scorePromptFor({ name: "French", examples: "x" }, { criteria }).version;
    expect(other).toMatch(/^score-v1\+m[0-9a-f]{8}\+c[0-9a-f]{8}$/);
  });
});

describe("breakdown and suggestion prompts in the AI output language", () => {
  const breakdown = (outputLanguage?: string) => buildBreakdownPrompt({ title: "T", company: "C", description: "Build.", jdMaxChars: 1000, jdHeadShare: 0.7, ...(outputLanguage ? { outputLanguage } : {}) }).system;

  it("counts characters for wide scripts and about twice as many for others", () => {
    expect(breakdown()).toContain("one short phrase in Simplified Chinese, at most 40 Chinese characters");
    expect(breakdown("en")).toContain("one short phrase in English, at most 80 characters");
    expect(breakdown("ja")).toContain("one short phrase in Japanese, at most 40 characters");
  });

  it("asks for the reasons in the output languages", () => {
    const input = { categories: [], current: { watchedCompanies: [] }, preferences: { targetTitles: [], locations: [], excludeKeywords: [], excludeCompanies: [] }, liked: [], ignored: [], quoteMaxChars: 200, maxTermChars: 40, minEvidence: { signalWord: 2, watchedCompany: 2, filter: 2 } };
    expect(buildSuggestPrompt(input).system).toContain('- "reason_zh": one short sentence in Simplified Chinese saying why; "reason_en": the same in English. "confidence"');
    expect(buildSuggestPrompt({ ...input, output: { language: "de", also: [] } }).system).toContain('- "reason_de": one short sentence in German saying why. "confidence"');
    const schema = z.toJSONSchema(suggestOutputSchemaFor({ language: "de", also: [] })) as unknown as { properties: { companies: { items: { properties: Record<string, unknown> } } } };
    expect(Object.keys(schema.properties.companies.items.properties)).toEqual(["company", "reason_de", "confidence", "evidence_job_ids"]);
  });

  it("reads a suggestion stored before the language settings (reasonZh / reasonEn) as per-language reasons", () => {
    const old = { kind: "watched_company", company: "Acme", reasonZh: "常被申请", reasonEn: "", confidence: 0.7, evidence: [{ jobId: 1, title: "t", company: "Acme" }] };
    expect(suggestionPayloadSchema.parse(old)).toMatchObject({ reasons: { zh: "常被申请" } });
    expect(suggestionPayloadSchema.safeParse({ ...old, reasonZh: "", reasonEn: " " }).success).toBe(false);
    const current: Record<string, unknown> = { ...old };
    delete current.reasonZh;
    delete current.reasonEn;
    expect(suggestionPayloadSchema.parse({ ...current, reasons: { de: "Oft beworben" } })).toMatchObject({ reasons: { de: "Oft beworben" } });
  });
});
