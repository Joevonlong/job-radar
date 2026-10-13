/**
 * No user pattern may hold up the filter step or a page for long: the patterns a review measured as catastrophic are refused
 * by the schema, the test texts catch them when the schema is bypassed (a hand-written file read without it), and at run time
 * each rule has a budget and the preview a deadline.
 *
 * The time boxes, budgets and deadlines are the product's own, measured on the wall clock, and are used as such here (a rule is
 * stopped where `match_ms` or `rule_budget_ms` run out in real time). The bounds on how much work the tests themselves burn
 * before the box stops it, and on the speed of a rule that must stay within its budget, are in CPU time of this thread
 * (`tests/helpers/cpu-time.ts`): wall time grows several times over on a busy machine, the CPU time hardly at all.
 */
import { describe, expect, it } from "vitest";

import { slowPatternReason } from "@/lib/config/schemas/common";
import { DEAL_BREAKER_DEFAULTS } from "@/lib/config/schemas/pipeline";
import { dealBreakerSchema, type DealBreaker } from "@/lib/config/schemas/preferences";
import {
  compileDealBreakers,
  dealBreakerVetoes,
  explainDealBreaker,
  patternIsFast,
  slowPatternProblems,
  startDealBreakerRun,
  type DealBreakerContext,
  type DealBreakerJob,
  type DealBreakerLimits,
} from "@/lib/filter/deal-breakers";
import { vmTimeBox } from "@/lib/filter/time-box";
import { issueKey } from "@/lib/profile/draft";
import { compileVisaRules } from "@/lib/visa/rules";

import { cpuTime, leastCpuTime, type MeasureOptions } from "../helpers/cpu-time";
import { shippedPipeline } from "../pipeline/helpers";

/** Measured in the review: seconds each on a 26-character or a 20,000-character line. */
const REVIEW_PATTERNS = ["(a|a)+$", ".*.*.*x", "\\d+.*\\d+.*\\d+.*\\d+.*Z", ".*100%\\s*on-?site"];
/** Fine on the test texts, statically fine too: the examples of the user guide. */
const GUIDE_PATTERNS = ["Reisetätigkeit.{0,30}(?:[5-9]\\d|100)\\s?%", "100\\s?%\\s*(?:on-?site|vor Ort)", "\\bno travel\\b", "travel (?:is )?not required", "\\bon-?call\\b"];

const limits: DealBreakerLimits = { ...DEAL_BREAKER_DEFAULTS };
const context = (over: Partial<DealBreakerLimits> = {}): DealBreakerContext => ({ language: "de", me: { languages: [{ de: "B1" }] }, limits: { ...limits, ...over } });

/** A phrase rule with `patterns` as they are, not checked by the schema (a file the filter reads by hand-edited path). */
function unchecked(patterns: string[], unless: string[] = [], id = "slow"): DealBreaker {
  const base = dealBreakerSchema.parse({ id, label: "Slow", type: "phrase", patterns: ["placeholder"] });
  if (base.type !== "phrase") throw new Error("phrase");
  return { ...base, patterns, unless };
}

const posting = (description: string): DealBreakerJob => ({ title: "Engineer", description, germanLevel: "unknown" });

describe("vmTimeBox", () => {
  it("stops a catastrophic expression and stays usable", () => {
    let finished = true;
    const ms = cpuTime(() => void (finished = vmTimeBox(() => void /(a|a)+$/.test(`${"a".repeat(30)}!`), 50)));
    expect(finished).toBe(false);
    expect(ms).toBeLessThan(1_000);
    let value = 0;
    expect(vmTimeBox(() => void (value = 42), 50)).toBe(true);
    expect(value).toBe(42);
  });

  it("passes other errors through", () => {
    expect(() =>
      vmTimeBox(() => {
        throw new TypeError("boom");
      }, 50),
    ).toThrow("boom");
  });
});

describe("the schema refuses the slow shapes", () => {
  it.each([
    ["(a|a)+$", "alternation"],
    [".*.*.*x", "leading"],
    ["\\d+.*\\d+.*\\d+.*\\d+.*Z", "unbounded"],
    [".*100%\\s*on-?site", "leading"],
    ["(a+)+", "nested"],
    ["\\w+\\s*\\w+", "unbounded"],
    ["\\w+\\d+", "unbounded"],
    ["\\w+\\w+", "unbounded"],
    ["(a|ab)+", "alternation"],
  ])("%s (%s)", (pattern, kind) => {
    expect(slowPatternReason(pattern)?.kind).toBe(kind);
    const parsed = dealBreakerSchema.safeParse({ id: "r", label: "R", type: "phrase", patterns: [pattern] });
    expect(parsed.success).toBe(false);
    const issue = parsed.error?.issues[0];
    expect(issue?.path).toEqual(["patterns", 0]);
    if (issue) expect(issueKey(issue)).toEqual({ key: "slowPattern", params: { kind } });
  });

  it.each([...GUIDE_PATTERNS, "\\d+\\s?%", "(?:\\s|-)+", "(?:on|off)-?site", "(?:ab)+", "\\s+\\w+", "\\w+\\s+\\w+", "\\d+\\s+\\d+"])("accepts %s", (pattern) => {
    expect(slowPatternReason(pattern)).toBeNull();
  });

  it("checks unless patterns too", () => {
    const parsed = dealBreakerSchema.safeParse({ id: "r", label: "R", type: "phrase", terms: ["travel"], unless: [".*.*.*x"] });
    expect(parsed.error?.issues[0]?.path).toEqual(["unless", 0]);
  });
});

describe("the test texts", () => {
  it.each(REVIEW_PATTERNS)("catch %s when the schema is bypassed, within a few match_ms", (pattern) => {
    let fast = true;
    const ms = cpuTime(() => void (fast = patternIsFast(pattern, "pattern", { ...limits, match_ms: 50 }, vmTimeBox)));
    expect(fast).toBe(false);
    expect(ms).toBeLessThan(2_000);
  });

  it("catch a slow pattern the static check lets through (large bounded runs)", () => {
    const pattern = "1\\d{0,20000}\\d{0,20000}%";
    expect(slowPatternReason(pattern)).toBeNull();
    expect(patternIsFast(pattern, "pattern", limits, vmTimeBox)).toBe(false);
    expect(patternIsFast(pattern, "unless", limits, vmTimeBox)).toBe(false);
  });

  it.each(GUIDE_PATTERNS)("pass %s", (pattern) => {
    expect(patternIsFast(pattern, "pattern", limits, vmTimeBox)).toBe(true);
    expect(patternIsFast(pattern, "unless", limits, vmTimeBox)).toBe(true);
  });

  it("remember a fast pattern, never a slow verdict (a busy machine is not the pattern's fault)", () => {
    const slowMachine = { ...limits, match_ms: 77 };
    expect(patternIsFast("never cached", "pattern", slowMachine, () => false)).toBe(false);
    expect(patternIsFast("never cached", "pattern", slowMachine, vmTimeBox)).toBe(true);
    expect(patternIsFast("never cached", "pattern", slowMachine, () => false)).toBe(true);
  });

  it("name the slow pattern's place, for the form and config:check", () => {
    const rules = [unchecked(["ok"]), unchecked(["fine", ".*.*.*x"], ["(a|a)+$"], "two")];
    expect(slowPatternProblems(rules, limits, vmTimeBox)).toEqual([{ path: [1, "patterns", 1] }, { path: [1, "unless", 0] }]);
  });

  it("leave a slow rule out of a run, with the warning too_slow", () => {
    const compiled = compileDealBreakers([unchecked([".*100%\\s*on-?site"]), unchecked(["vor Ort"], [], "fine")], context());
    const run = startDealBreakerRun(compiled, vmTimeBox);
    expect(run.warnings).toEqual([{ id: "slow", code: "too_slow" }]);
    expect(dealBreakerVetoes(run, [posting("100% vor Ort")]).vetoes).toEqual([["fine"]]);
    // left out, it keeps the veto a job had from it
    expect(dealBreakerVetoes(run, [posting("nothing here")], { previous: [["slow", "gone"]] }).vetoes).toEqual([["slow"]]);
  });
});

describe("at run time", () => {
  /** A run whose probe is skipped (as if the test texts had missed the pattern): only the budget is left. */
  const unprobed = (rules: DealBreaker[], over: Partial<DealBreakerLimits> = {}) => ({ ...startDealBreakerRun(compileDealBreakers(rules, context(over)), () => true), timeBox: vmTimeBox });

  it("stops a rule over rule_budget_ms for the rest of the run and reports it", () => {
    const run = unprobed([unchecked(["(a|a)+$"]), unchecked(["vor Ort"], [], "fine")], { rule_budget_ms: 100 });
    const jobs = [posting("vor Ort"), posting(`${"a".repeat(40)}!`), posting("vor Ort")];
    let first: string[][] = [];
    const ms = cpuTime(() => void (first = dealBreakerVetoes(run, jobs).vetoes));
    expect(ms).toBeLessThan(2_000);
    expect(first).toEqual([["fine"], [], ["fine"]]);
    expect(run.warnings).toEqual([{ id: "slow", code: "too_slow" }]);
    // a job the stopped rule did not reach keeps the veto stored from an earlier run; a job it judged does not
    const kept = unprobed([unchecked(["(a|a)+$"]), unchecked(["vor Ort"], [], "fine")], { rule_budget_ms: 100 });
    expect(dealBreakerVetoes(kept, jobs, { previous: [["slow"], ["slow"], ["slow", "fine"]] }).vetoes).toEqual([["fine"], ["slow"], ["slow", "fine"]]);
    // the next batch does not try it again
    // a stopped rule is not tried again: alone in its run, the next batch needs no time box at all
    const alone = unprobed([unchecked(["(a|a)+$"])], { rule_budget_ms: 100 });
    dealBreakerVetoes(alone, jobs);
    expect(alone.warnings).toEqual([{ id: "slow", code: "too_slow" }]);
    let boxes = 0;
    dealBreakerVetoes({ ...alone, timeBox: (work, ms) => (boxes++, alone.timeBox(work, ms)) }, jobs);
    expect(boxes).toBe(0);
    expect(run.warnings).toHaveLength(1);
  });

  it("bounds the review's quadratic pattern on a 20,000-character line", () => {
    const run = unprobed([unchecked([".*100%\\s*on-?site"])], { rule_budget_ms: 100 });
    const line = "Lorem ipsum dolor sit amet ".repeat(800).slice(0, 20_000);
    const ms = cpuTime(() => void dealBreakerVetoes(run, Array.from({ length: 20 }, () => posting(line))));
    expect(ms).toBeLessThan(2_000);
    expect(run.warnings).toEqual([{ id: "slow", code: "too_slow" }]);
  });

  it("stops at a deadline without calling the rule too slow", () => {
    const run = unprobed([unchecked(["(a|a)+$"])]);
    let result: ReturnType<typeof dealBreakerVetoes> | null = null;
    const ms = cpuTime(() => void (result = dealBreakerVetoes(run, [posting(`${"a".repeat(40)}!`)], { deadline: performance.now() + 50 })));
    expect(ms).toBeLessThan(1_000);
    expect(result).toMatchObject({ complete: false });
    expect(run.warnings).toEqual([]);
  });

  describe("the visa rule", () => {
    /** The shipped packs plus one catastrophic `offered` pattern, as a hand-edited pack could have. */
    const slowVisa = () => {
      const pipeline = shippedPipeline();
      return compileVisaRules({ ...pipeline, visa: { ...pipeline.visa, offered: [...pipeline.visa.offered, "visa(a|a)+$"] } });
    };
    const visaRule = dealBreakerSchema.parse({ id: "visa", label: "No visa sponsorship", type: "visa_not_offered" });
    const visaContext = (over: Partial<DealBreakerLimits> = {}): DealBreakerContext => ({
      ...context(over),
      me: { languages: [{ de: "B1" }], needs_visa_sponsorship: true },
      visa: slowVisa(),
    });
    const refusal = "We are unable to offer visa sponsorship.";
    const slowText = `visa${"a".repeat(40)}!`;

    /** The budget runs out while the rule reads this job: a stand-in for a text that takes the rest of the budget. */
    const BUDGET_SPENT = new Error("budget spent");
    const spendsBudget: DealBreakerJob = {
      title: "Engineer",
      germanLevel: "unknown",
      get description(): string {
        throw BUDGET_SPENT;
      },
    };
    /** A time box that stops the work where `BUDGET_SPENT` is thrown, not after a number of milliseconds. */
    const stopsWhenSpent = (work: () => void): boolean => {
      try {
        work();
        return true;
      } catch (error) {
        if (error === BUDGET_SPENT) return false;
        throw error;
      }
    };

    // The first job of a cold process takes tens of milliseconds (the packs' patterns compile on first use, more on a loaded
    // machine), so the test must not depend on the clock for the jobs before the one that spends the budget.
    it("runs under rule_budget_ms like a phrase rule: stopped, reported, earlier vetoes kept", () => {
      const run = { ...startDealBreakerRun(compileDealBreakers([visaRule], visaContext({ rule_budget_ms: 100 })), vmTimeBox), timeBox: stopsWhenSpent };
      expect(run.warnings).toEqual([]);
      const jobs = [posting(refusal), spendsBudget, posting(refusal)];
      const { vetoes } = dealBreakerVetoes(run, jobs, { previous: [[], ["visa"], ["visa"]] });
      // judged before the budget ran out: vetoed; being read when it ran out, or not reached: the stored veto stays
      expect(vetoes).toEqual([["visa"], ["visa"], ["visa"]]);
      expect(run.warnings).toEqual([{ id: "visa", code: "too_slow" }]);
      // stopped for the rest of the run: not tried again, and the jobs it did not judge keep what they had
      expect(dealBreakerVetoes(run, [posting(refusal), posting(refusal)], { previous: [[], ["visa"]] }).vetoes).toEqual([[], ["visa"]]);
      expect(run.warnings).toHaveLength(1);
    });

    it("stops a catastrophic pack pattern at rule_budget_ms", () => {
      const run = startDealBreakerRun(compileDealBreakers([visaRule], visaContext({ rule_budget_ms: 100 })), vmTimeBox);
      let result: string[][] = [];
      // the slow text comes first, so the outcome does not depend on how long the first match takes
      const ms = cpuTime(() => void (result = dealBreakerVetoes(run, [posting(slowText), posting(refusal)], { previous: [["visa"], []] }).vetoes));
      expect(ms).toBeLessThan(2_000);
      expect(result).toEqual([["visa"], []]);
      expect(run.warnings).toEqual([{ id: "visa", code: "too_slow" }]);
    });

    it("stops at a deadline", () => {
      const run = startDealBreakerRun(compileDealBreakers([visaRule], visaContext()), vmTimeBox);
      let result: ReturnType<typeof dealBreakerVetoes> | null = null;
      const ms = cpuTime(() => void (result = dealBreakerVetoes(run, [posting(slowText)], { deadline: performance.now() + 50 })));
      expect(ms).toBeLessThan(1_000);
      expect(result).toMatchObject({ complete: false });
    });

    it("gives up explaining after match_ms", () => {
      let explanation: ReturnType<typeof explainDealBreaker> = { id: "x", type: "phrase", quote: null, field: null, offset: null };
      const ms = cpuTime(() => void (explanation = explainDealBreaker(posting(slowText), visaRule, visaContext({ match_ms: 50 }), shippedPipeline(), vmTimeBox)));
      expect(explanation).toBeNull();
      expect(ms).toBeLessThan(1_000);
    });

    describe("with the shipped packs only", () => {
      const shippedContext = (over: Partial<DealBreakerLimits> = {}): DealBreakerContext => ({
        ...context(over),
        me: { languages: [{ de: "B1" }], needs_visa_sponsorship: true },
        visa: compileVisaRules(shippedPipeline()),
      });

      // thousands of offered phrases in one sentence: their negation test reads the sentence once, not once per phrase (which
      // took seconds, over the budget). The budget here is the shipped default's size in CPU time; the rule's own wall budget is
      // raised so that a busy machine cannot stop it, and the time is checked at 4000 phrases and from 1000 to 4000 (linear ≈ 4,
      // quadratic ≈ 16). Measured here: about 20 ms at 4000.
      it("reads 4000 offered phrases in one sentence within rule_budget_ms of CPU time: not too slow, no refusal", () => {
        const run = startDealBreakerRun(compileDealBreakers([visaRule], shippedContext({ rule_budget_ms: 60_000 })), vmTimeBox);
        const read = (phrases: number, options: MeasureOptions = {}): number => {
          const jobs = [posting("we offer relocation support and ".repeat(phrases))];
          return leastCpuTime(() => void dealBreakerVetoes(run, jobs), options);
        };
        const ms = read(4000, { atLeast: 0, giveUpAbove: 3 * limits.rule_budget_ms });
        expect(ms, "CPU ms at 4000 phrases").toBeLessThan(limits.rule_budget_ms);
        expect(dealBreakerVetoes(run, [posting("we offer relocation support and ".repeat(4000))]).vetoes).toEqual([[]]);
        expect(run.warnings).toEqual([]);
        const [small, large] = [read(1000), read(4000)] as [number, number];
        expect(large / small, `CPU ms ${large.toFixed(1)} at 4000 / ${small.toFixed(1)} at 1000`).toBeLessThanOrEqual(8);
      });

      // 130000 required permits in one sentence once overflowed the stack, an error the time box passes on: the whole filter step
      // failed. The budget is raised so that only an error, not a busy machine, can fail it.
      it("reads 130000 required permits in one sentence without an error: a refusal", () => {
        const run = startDealBreakerRun(compileDealBreakers([visaRule], shippedContext({ rule_budget_ms: 60_000 })), vmTimeBox);
        expect(dealBreakerVetoes(run, [posting("work permit required, ".repeat(130_000))]).vetoes).toEqual([["visa"]]);
        expect(run.warnings).toEqual([]);
      });
    });
  });

  it("gives up explaining a veto after match_ms", () => {
    const pipeline = shippedPipeline();
    let explanation: ReturnType<typeof explainDealBreaker> = null;
    const ms = cpuTime(() => void (explanation = explainDealBreaker(posting(`${"a".repeat(40)}!`), unchecked(["(a|a)+$"]), context({ match_ms: 50 }), pipeline, vmTimeBox)));
    expect(explanation).toBeNull();
    expect(ms).toBeLessThan(1_000);
  });
});
