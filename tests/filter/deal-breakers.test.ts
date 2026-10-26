import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import type { MeConfig, PipelineConfig } from "@/lib/config";
import { DEAL_BREAKER_DEFAULTS } from "@/lib/config/schemas/pipeline";
import { dealBreakerSchema, type DealBreaker } from "@/lib/config/schemas/preferences";
import type { GermanLevel } from "@/lib/domain/types";
import { compileFilter, evaluateJob, vmTimeBox, type CompiledFilter, type FilterJob, type FilterOverride } from "@/lib/filter";
import {
  compileDealBreakers,
  dealBreakerLimitProblems,
  dealBreakerVetoes,
  explainDealBreaker as explainWith,
  startDealBreakerRun,
  userLocalRank,
  type CompiledDealBreakers,
  type DealBreakerContext,
  type DealBreakerJob,
} from "@/lib/filter/deal-breakers";
import { orderedReasons } from "@/lib/filter/reasons";
import { toFilterJob } from "@/lib/filter";
import { extractGermanLevel } from "@/lib/pipeline/language";
import { userLanguageRank } from "@/lib/scoring/german";
import { visaRulesFor } from "@/lib/visa/rules";

import { shippedPipeline } from "../pipeline/helpers";
import { job, prefs } from "./helpers";

type Level = MeConfig["languages"][number][string];

const pipeline: PipelineConfig = shippedPipeline();

interface Snippet {
  lang?: string;
  veto?: boolean;
  level?: GermanLevel;
  text: string;
}
const fixtures = parse(fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/filter/deal-breakers/postings.yaml"), "utf8")) as Record<"travel" | "onsite" | "german", Snippet[]>;

const rule = (raw: Record<string, unknown>): DealBreaker => dealBreakerSchema.parse(raw);
const gate = (extra: Record<string, unknown> = {}): DealBreaker => rule({ id: "gate", label: "German above my level", type: "language_gate", ...extra });
const phrase = (extra: Record<string, unknown>): DealBreaker => rule({ id: "phrase", label: "Phrase", type: "phrase", ...extra });

/** me.yaml with English C1 and, when given, the local language (German) at `de`. */
const me = (de?: Level): Pick<MeConfig, "languages"> => ({ languages: de === undefined ? [{ en: "C1" }] : [{ en: "C1" }, { de }] });
const context = (over: Partial<DealBreakerContext> = {}): DealBreakerContext => ({ language: "de", me: me("B1"), limits: DEAL_BREAKER_DEFAULTS, ...over });
const posting = (over: Partial<DealBreakerJob> = {}): DealBreakerJob => ({ title: "AI Engineer", description: "Build things.", germanLevel: "unknown", ...over });
const check = (subject: DealBreakerJob, compiled: CompiledDealBreakers): string[] => dealBreakerVetoes(startDealBreakerRun(compiled, vmTimeBox), [subject]).vetoes[0] ?? [];
const vetoes = (rules: DealBreaker[], subject: DealBreakerJob, ctx: DealBreakerContext = context()): string[] => check(subject, compileDealBreakers(rules, ctx));
const explainDealBreaker = (subject: DealBreakerJob, r: DealBreaker, ctx: DealBreakerContext, p: PipelineConfig) => explainWith(subject, r, ctx, p, vmTimeBox);

describe("language gate", () => {
  it("reads the user's level exactly as scoring does", () => {
    const levels = ["A1", "A2", "B1", "B2", "C1", "C2", "native"] as const;
    const cases: Pick<MeConfig, "languages">[] = [{ languages: [] }, { languages: [{ en: "native" }] }, ...levels.map((level): Pick<MeConfig, "languages"> => ({ languages: [{ en: "C1" }, { de: level }] }))];
    for (const me of cases) expect(userLocalRank(me, "de")).toBe(userLanguageRank(me, "de"));
  });

  it("vetoes a required level above the user's level in me.yaml", () => {
    expect(vetoes([gate()], posting({ germanLevel: "C1" }))).toEqual(["gate"]);
    expect(vetoes([gate()], posting({ germanLevel: "B2" }))).toEqual(["gate"]);
  });

  it("keeps a required level at or below the user's level", () => {
    for (const level of ["A1", "A2", "B1"] as const) expect(vetoes([gate()], posting({ germanLevel: level }))).toEqual([]);
  });

  it("treats a language me.yaml does not list as none at all: any stated level vetoes", () => {
    expect(vetoes([gate()], posting({ germanLevel: "A2" }), context({ me: me() }))).toEqual(["gate"]);
  });

  it("never vetoes a native speaker", () => {
    expect(vetoes([gate()], posting({ germanLevel: "C2" }), context({ me: me("native") }))).toEqual([]);
  });

  it("with at_least compares with that level and does not read me.yaml", () => {
    const fixed = gate({ at_least: "C1" });
    expect(vetoes([fixed], posting({ germanLevel: "B2" }), context({ me: me() }))).toEqual([]);
    expect(vetoes([fixed], posting({ germanLevel: "C1" }), context({ me: me("native") }))).toEqual(["gate"]);
    expect(vetoes([fixed], posting({ germanLevel: "C2" }), context({ me: null }))).toEqual(["gate"]);
  });

  it("never vetoes preferred, none or unknown (C3)", () => {
    for (const level of ["preferred", "none", "unknown"] as const) {
      expect(vetoes([gate()], posting({ germanLevel: level }), context({ me: me() }))).toEqual([]);
      expect(vetoes([gate({ at_least: "A1" })], posting({ germanLevel: level }))).toEqual([]);
    }
  });

  it("does nothing, with a warning, when the market has no language step", () => {
    const compiled = compileDealBreakers([gate()], context({ language: null }));
    expect(check(posting({ germanLevel: "C2" }), compiled)).toEqual([]);
    expect(compiled.warnings).toEqual([{ id: "gate", code: "no_language_step" }]);
  });

  it("does nothing without at_least when me.yaml cannot be read; the other rules go on", () => {
    const compiled = compileDealBreakers([gate(), phrase({ terms: ["Rust"] })], context({ me: null }));
    expect(compiled.warnings).toEqual([{ id: "gate", code: "me_unreadable" }]);
    expect(check(posting({ title: "Rust Engineer", germanLevel: "C2" }), compiled)).toEqual(["phrase"]);
  });

  it("reads only the rule column: the filter job carries jobs.german_level_required, nothing of the AI", () => {
    const candidate = {
      id: 1,
      title: "AI Engineer",
      description: "Sehr gute Deutschkenntnisse (C1) sind erforderlich.",
      workplace: "hybrid" as const,
      seniority: "senior",
      contract: "permanent",
      locationsJson: [],
      salaryJson: null,
      companyName: "Example",
      companyNameNorm: "example",
      companyAliases: [],
      companyBlacklisted: false,
      companyWatched: false,
      // the stored rule reading wins over the text: the gate reads the column, it does not parse the description again
      germanLevel: "B1",
    };
    expect(toFilterJob(candidate).germanLevel).toBe("B1");
    expect(vetoes([gate()], toFilterJob(candidate))).toEqual([]);
    expect(vetoes([gate()], toFilterJob({ ...candidate, germanLevel: "C1" }))).toEqual(["gate"]);
    expect(toFilterJob({ ...candidate, germanLevel: "garbage" }).germanLevel).toBe("unknown");
  });

  it("follows the pipeline's reading of the fixture postings", () => {
    for (const snippet of fixtures.german) expect(extractGermanLevel(`AI Engineer\n${snippet.text}`, pipeline)).toBe(snippet.level);
  });

  it("is skipped when switched off", () => {
    expect(vetoes([gate({ enabled: false })], posting({ germanLevel: "C2" }))).toEqual([]);
  });
});

describe("phrase", () => {
  it("matches terms as whole words only", () => {
    const rust = phrase({ terms: ["Rust"] });
    expect(vetoes([rust], posting({ title: "Senior Rust Engineer" }))).toEqual(["phrase"]);
    expect(vetoes([rust], posting({ description: "We trust our engineers. Rusty skills welcome." }))).toEqual([]);
    expect(vetoes([rust], posting({ description: "Backend in Go and rust." }))).toEqual(["phrase"]);
  });

  it("ignores case and accents in terms, and ß / ss", () => {
    expect(vetoes([phrase({ terms: ["Munchen"] })], posting({ description: "Standort: MÜNCHEN, Bayern." }))).toEqual(["phrase"]);
    expect(vetoes([phrase({ terms: ["München"] })], posting({ description: "Office in Munchen." }))).toEqual(["phrase"]);
    expect(vetoes([phrase({ terms: ["Strasse"] })], posting({ description: "Büro in der Hauptstraße." }))).toEqual([]);
    expect(vetoes([phrase({ terms: ["Hauptstrasse"] })], posting({ description: "Büro in der Hauptstraße." }))).toEqual(["phrase"]);
    expect(vetoes([phrase({ terms: ["on call"] })], posting({ description: "Part of the on\ncall rotation." }))).toEqual(["phrase"]);
  });

  it("looks only where scope says", () => {
    const subject = posting({ title: "Sales Engineer", description: "No cold calling." });
    expect(vetoes([phrase({ terms: ["sales"], scope: "title" })], subject)).toEqual(["phrase"]);
    expect(vetoes([phrase({ terms: ["sales"], scope: "description" })], subject)).toEqual([]);
    expect(vetoes([phrase({ terms: ["cold calling"], scope: "title" })], subject)).toEqual([]);
    expect(vetoes([phrase({ terms: ["cold calling"], scope: "description" })], subject)).toEqual(["phrase"]);
    expect(vetoes([phrase({ terms: ["cold calling"] })], subject)).toEqual(["phrase"]);
  });

  it("does not count a hit in a sentence that matches unless", () => {
    const travel = phrase({ terms: ["travel"], unless: ["\\bno travel\\b", "travel (?:is )?not required"] });
    expect(vetoes([travel], posting({ description: "No travel required. Great team." }))).toEqual([]);
    expect(vetoes([travel], posting({ description: "Travel is not required." }))).toEqual([]);
    expect(vetoes([travel], posting({ description: "Frequent travel to clients." }))).toEqual(["phrase"]);
    // the excused sentence does not excuse a later one
    expect(vetoes([travel], posting({ description: "No travel in the first month. After that, weekly travel to clients." }))).toEqual(["phrase"]);
  });

  it("runs regular expressions over title and description", () => {
    const pattern = phrase({ patterns: ["\\bon-?call\\b"] });
    expect(vetoes([pattern], posting({ description: "Weekly on-call duty." }))).toEqual(["phrase"]);
    expect(vetoes([pattern], posting({ title: "Oncall Engineer" }))).toEqual(["phrase"]);
    expect(vetoes([pattern], posting({ description: "Call center experience." }))).toEqual([]);
  });

  it("keeps word boundaries, case folding and Unicode classes in patterns", () => {
    const java = phrase({ patterns: ["\\bjava\\b"] });
    expect(vetoes([java], posting({ description: "Frontend in JavaScript." }))).toEqual([]);
    expect(vetoes([java], posting({ description: "Backend in JAVA 21." }))).toEqual(["phrase"]);
    // non-ASCII letters fold case with a word boundary in the pattern too
    expect(vetoes([phrase({ patterns: ["\\bbezahlte überstunden\\b"] })], posting({ description: "BEZAHLTE ÜBERSTUNDEN." }))).toEqual(["phrase"]);
    expect(vetoes([phrase({ patterns: ["\\p{Lu}{6,}!"] })], posting({ description: "ROCKSTAR! wanted" }))).toEqual(["phrase"]);
    expect(vetoes([phrase({ patterns: ["\\p{Lu}{6,}!"] })], posting({ description: "pXXXXXX wanted" }))).toEqual([]);
  });

  it.each(["travel", "onsite"] as const)("the guide's %s example: 2 vetoes and 2 keeps in English and in German", (group) => {
    const rules = {
      travel: phrase({ patterns: ["Reisetätigkeit.{0,30}(?:[5-9]\\d|100)\\s?%", "travel.{0,30}(?:[5-9]\\d|100)\\s?%"] }),
      onsite: phrase({ patterns: ["100\\s?%\\s*(?:on-?site|vor Ort)"], scope: "description" }),
    };
    const snippets = fixtures[group];
    for (const lang of ["en", "de"]) {
      expect(snippets.filter((s) => s.lang === lang && s.veto).length).toBeGreaterThanOrEqual(group === "travel" ? 2 : 1);
      expect(snippets.filter((s) => s.lang === lang && !s.veto).length).toBeGreaterThanOrEqual(group === "travel" ? 2 : 1);
    }
    for (const snippet of snippets) expect({ text: snippet.text, veto: vetoes([rules[group]], posting({ description: snippet.text })).length > 0 }).toEqual({ text: snippet.text, veto: snippet.veto });
  });

  it("reads only the first match_text_max_chars characters of the description", () => {
    const description = `${"Lorem ipsum dolor. ".repeat(10)}Blockchain.`;
    const limits = { ...DEAL_BREAKER_DEFAULTS, match_text_max_chars: 100 };
    expect(vetoes([phrase({ terms: ["blockchain"] })], posting({ description }), context({ limits }))).toEqual([]);
    expect(vetoes([phrase({ terms: ["blockchain"] })], posting({ description }))).toEqual(["phrase"]);
  });

  it("returns every vetoing rule in the order of the file", () => {
    const rules = [phrase({ id: "b", terms: ["sales"] }), gate({ id: "a" }), phrase({ id: "c", terms: ["java"] })];
    expect(vetoes(rules, posting({ title: "Java Sales Engineer", germanLevel: "C1" }))).toEqual(["b", "a", "c"]);
  });
});

describe("limits of pipeline.yaml", () => {
  it("leaves out rules past max_rules, with a warning", () => {
    const limits = { ...DEAL_BREAKER_DEFAULTS, max_rules: 1 };
    const compiled = compileDealBreakers([phrase({ id: "one", terms: ["sales"] }), phrase({ id: "two", terms: ["java"] })], context({ limits }));
    expect(compiled.warnings).toEqual([{ id: "two", code: "too_many_rules" }]);
    expect(check(posting({ title: "Java Sales" }), compiled)).toEqual(["one"]);
    expect(dealBreakerLimitProblems([phrase({ id: "one", terms: ["a"] }), phrase({ id: "two", terms: ["b"] })], limits)).toEqual([{ path: [], kind: "too_many_rules", max: 1 }]);
  });

  it("leaves out a rule with a pattern longer than max_pattern_chars, with a warning", () => {
    const limits = { ...DEAL_BREAKER_DEFAULTS, max_pattern_chars: 5 };
    const long = phrase({ id: "long", terms: ["ok"], unless: ["abcdef"] });
    const compiled = compileDealBreakers([long], context({ limits }));
    expect(compiled.warnings).toEqual([{ id: "long", code: "pattern_too_long" }]);
    expect(dealBreakerLimitProblems([long], limits)).toEqual([{ path: [0, "unless", 0], kind: "pattern_too_long", max: 5 }]);
  });
});

describe("in the hard filter", () => {
  const withRules = (rules: unknown[]) => compileFilter(prefs((raw) => void (raw.deal_breakers = rules)), pipeline, { me: me("B1") });
  const judge = (subject: FilterJob, compiled: CompiledFilter, override: FilterOverride | null = null) =>
    evaluateJob(subject, compiled, override, dealBreakerVetoes(startDealBreakerRun(compiled.dealBreakers, vmTimeBox), [subject]).vetoes[0]);

  it("filters the job out with deal_breaker:<id> after the other reasons", () => {
    const compiled = withRules([{ id: "gate", label: "German above my level", type: "language_gate" }]);
    const verdict = judge(job({ germanLevel: "C1", companyBlacklisted: true }), compiled);
    expect(verdict.result).toBe("filtered_out");
    expect(verdict.reasons.at(-1)).toBe("deal_breaker:gate");
    // shown first: overrides, then deal-breakers, then the rest
    expect(orderedReasons(["override_keep", ...verdict.reasons])[1]).toBe("deal_breaker:gate");
    expect(judge(job({ germanLevel: "B1" }), compiled).result).toBe("passed");
  });

  it("keeps the reason under a keep override", () => {
    const verdict = judge(job({ germanLevel: "C1" }), withRules([{ id: "gate", label: "Gate", type: "language_gate" }]), "keep");
    expect(verdict).toEqual({ result: "passed", reasons: ["override_keep", "deal_breaker:gate"] });
  });

  it("never runs the rules without a time box: vetoes must come from dealBreakerVetoes", () => {
    expect(() => evaluateJob(job({ germanLevel: "C1" }), withRules([{ id: "gate", label: "Gate", type: "language_gate" }]))).toThrow(/dealBreakerVetoes/);
  });

  it("changes nothing without deal_breakers", () => {
    expect(evaluateJob(job({ germanLevel: "C2", title: "Rust Engineer" }), compileFilter(prefs(), pipeline)).result).toBe("passed");
  });
});

describe("explanations", () => {
  it("quotes the sentence the rules read a level from, verbatim, with both levels", () => {
    const description = "We build things. Sehr gute Deutschkenntnisse (C1) sind erforderlich. Englisch ist ein Plus.";
    const subject = posting({ description, germanLevel: "C1" });
    const explained = explainDealBreaker(subject, gate(), context(), pipeline);
    expect(explained).toMatchObject({ id: "gate", type: "language_gate", field: "description", required: "C1", userLevel: "B1" });
    expect(explained?.quote).toContain("Deutschkenntnisse (C1)");
    expect(description.slice(explained?.offset ?? 0, (explained?.offset ?? 0) + (explained?.quote?.length ?? 0))).toBe(explained?.quote);
    expect(explainDealBreaker(subject, gate({ at_least: "B2" }), context(), pipeline)).toMatchObject({ atLeast: "B2", required: "C1" });
    expect(explainDealBreaker(subject, gate({ at_least: "B2" }), context(), pipeline)?.userLevel).toBeUndefined();
  });

  it("has no quote when the level is not in the description, and none for a rule that does not apply", () => {
    expect(explainDealBreaker(posting({ title: "Engineer (German C1)", germanLevel: "C1" }), gate(), context(), pipeline)).toMatchObject({ quote: null, required: "C1" });
    expect(explainDealBreaker(posting({ germanLevel: "A2" }), gate(), context(), pipeline)).toBeNull();
  });

  it("quotes a phrase hit from the field it is in", () => {
    const description = "About us. Expect travel up to 75% of the time. Benefits.";
    const travel = phrase({ patterns: ["travel.{0,30}(?:[5-9]\\d|100)\\s?%"] });
    const explained = explainDealBreaker(posting({ description }), travel, context(), pipeline);
    expect(explained).toMatchObject({ field: "description", quote: "Expect travel up to 75% of the time." });
    expect(description.slice(explained?.offset ?? 0).startsWith(explained?.quote ?? "?")).toBe(true);
    expect(explainDealBreaker(posting({ title: "Rust Engineer" }), phrase({ terms: ["rust"] }), context(), pipeline)).toMatchObject({ field: "title", quote: "Rust Engineer", offset: 0 });
  });
});

describe("visa rule", () => {
  const visaRule = (): DealBreaker => rule({ id: "visa", label: "No visa sponsorship", type: "visa_not_offered" });
  const needs = (value: boolean): DealBreakerContext => context({ me: { ...me("B1"), needs_visa_sponsorship: value }, visa: visaRulesFor(pipeline) });

  it("vetoes a JD that refuses sponsorship or requires a work permit", () => {
    expect(vetoes([visaRule()], posting({ description: "Great team. We are unable to offer visa sponsorship for this role." }), needs(true))).toEqual(["visa"]);
    expect(vetoes([visaRule()], posting({ description: "You must hold a valid work permit for Germany." }), needs(true))).toEqual(["visa"]);
  });

  it("keeps offered, unclear and silent JDs", () => {
    for (const description of [
      "We offer visa sponsorship and relocation support.",
      "You must hold a valid work permit for Germany or be eligible for an EU Blue Card.",
      "We offer relocation support, but visa sponsorship is not available.",
      "Build data pipelines in Python.",
    ])
      expect(vetoes([visaRule()], posting({ description }), needs(true)), description).toEqual([]);
    expect(vetoes([visaRule()], posting({ description: null }), needs(true))).toEqual([]);
  });

  it("counts only combined phrases on a company named like a visa word", () => {
    const description = "We cannot sponsor visas for this role.";
    expect(vetoes([visaRule()], posting({ description }), needs(true))).toEqual(["visa"]);
    expect(vetoes([visaRule()], posting({ description, companyNameNorm: "visa" }), needs(true))).toEqual([]);
  });

  it("does nothing, with a warning, for a user who does not need sponsorship or whose me.yaml cannot be read", () => {
    const description = "We are unable to offer visa sponsorship.";
    expect(compileDealBreakers([visaRule()], needs(false)).warnings).toEqual([{ id: "visa", code: "visa_not_needed" }]);
    expect(vetoes([visaRule()], posting({ description }), needs(false))).toEqual([]);
    expect(vetoes([visaRule()], posting({ description }), context({ me: { languages: [{ en: "C1" }] }, visa: visaRulesFor(pipeline) }))).toEqual([]);
    expect(compileDealBreakers([visaRule()], context({ me: null, visa: visaRulesFor(pipeline) })).warnings).toEqual([{ id: "visa", code: "me_unreadable" }]);
  });

  it("never vetoes without the packs' patterns", () => {
    expect(vetoes([visaRule()], posting({ description: "We are unable to offer visa sponsorship." }), context({ me: { ...me("B1"), needs_visa_sponsorship: true } }))).toEqual([]);
  });

  it("explains a veto with the verbatim quote and its kind", () => {
    const description = "About us. You must hold a valid work permit for Germany. Benefits.";
    const explained = explainDealBreaker(posting({ description }), visaRule(), needs(true), pipeline);
    expect(explained).toMatchObject({ id: "visa", type: "visa_not_offered", field: "description", visaKind: "permit_required", quote: "You must hold a valid work permit for Germany." });
    expect(description.slice(explained?.offset ?? 0).startsWith(explained?.quote ?? "?")).toBe(true);
    expect(explainDealBreaker(posting({ description: "We offer relocation support." }), visaRule(), needs(true), pipeline)).toBeNull();
  });
});
