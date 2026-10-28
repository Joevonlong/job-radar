/**
 * The probe of the user's interest patterns: a pattern with catastrophic backtracking is left out of the rules (with a
 * warning naming its category) instead of holding the process on one description; the shipped vocabulary passes it.
 */
import { describe, expect, it, vi } from "vitest";

import { slowInterestPatterns } from "@/lib/config";
import { interestsSchema, SIGNAL_PROBE_DEFAULTS } from "@/lib/config/schemas/interests";
import { patternIsFast, type TimeBox } from "@/lib/filter/deal-breakers";
import { vmTimeBox } from "@/lib/filter/time-box";
import { validateSuggestions } from "@/lib/interests/suggest-validate";
import { signalPatternGuard, signalPatternIsFast, withinJobBudget } from "@/lib/signals/pattern-guard";
import { findCandidates, findQuoteTerm } from "@/lib/signals/rules";

import { shippedYaml } from "../config/helpers";
import { context, emptyOutput, reasons } from "../interests/helpers";
import { rawCategory, shippedInterests, shippedPipeline } from "./helpers";

/** Looks harmless, backtracks exponentially on a run of words without "budget" (seconds on 38 characters). */
const SLOW = "(\\w+\\s*)*budget";
const SENTENCE = "Wir bieten eine tolle Arbeitsumgebung.";

const limits = { pattern_probe_chars: 20_000, pattern_probe_ms: 100, pattern_probe_retry_ms: 400 };
const warnings = () => {
  const warn = vi.fn();
  return { warn, guard: signalPatternGuard(limits, { warn }) };
};

const timed = <T>(work: () => T): { value: T; ms: number } => {
  const start = performance.now();
  const value = work();
  return { value, ms: performance.now() - start };
};

describe("the probe of interest patterns", () => {
  it("passes every pattern of the shipped vocabulary with the shipped limits (patterns, exclude, tag_patterns)", () => {
    const interests = shippedInterests();
    const sources = interests.signals.categories.flatMap((category) => (category.kind === "tag" ? category.tag_patterns.map((entry) => entry.pattern) : [...category.patterns, ...category.exclude]));
    expect(sources.length).toBeGreaterThan(10);
    expect(slowInterestPatterns(interests, signalPatternIsFast(interests.limits))).toEqual([]);
    // and the rules run with a guard leave nothing out
    const { warn, guard } = warnings();
    findCandidates("We offer equity and a learning budget of €1,000.", interests, shippedPipeline(), guard);
    expect(warn).not.toHaveBeenCalled();
  });

  it("finds a slow pattern of a keyword category, with its path in interests.yaml", () => {
    const interests = shippedInterests((raw) => {
      (rawCategory(raw, "T2").patterns as string[]).push(SLOW);
      (rawCategory(raw, "tag").tag_patterns as Array<Record<string, string>>).push({ name: "Learning budget", pattern: SLOW });
    });
    const t2 = interests.signals.categories.findIndex((category) => category.id === "T2");
    const tag = interests.signals.categories.findIndex((category) => category.id === "tag");
    const t2Patterns = interests.signals.categories[t2]?.kind === "keyword" ? (interests.signals.categories[t2]?.patterns.length ?? 0) : 0;
    const tagPatterns = interests.signals.categories[tag]?.kind === "tag" ? (interests.signals.categories[tag]?.tag_patterns.length ?? 0) : 0;
    expect(slowInterestPatterns(interests, signalPatternIsFast(limits))).toEqual([
      { categoryId: "T2", path: ["signals", "categories", t2, "patterns", t2Patterns - 1] },
      { categoryId: "tag", path: ["signals", "categories", tag, "tag_patterns", tagPatterns - 1, "pattern"] },
    ]);
  });

  it.each(["(\\d+)+x", "(\\s+)+x", "(\\d+\\s?)+€", "(\\d+[.,]?)+\\s*k", "(?:\\d+[.,\\s]?)+€"])("refuses nested digit, whitespace and separator repetitions: %s", (pattern) => {
    const { value, ms } = timed(() => signalPatternIsFast(limits)(pattern));
    expect(value).toBe(false);
    expect(ms).toBeLessThan(3000);
    // The shared probe protects deal-breaker patterns too.
    expect(patternIsFast(pattern, "pattern", { match_text_max_chars: 20_000, match_ms: 100 }, vmTimeBox)).toBe(false);
  });

  it("retries a busy probe with the larger budget", () => {
    const budgets: number[] = [];
    const timeBox: TimeBox = (work, ms) => {
      budgets.push(ms);
      if (budgets.length === 1) return false;
      work();
      return true;
    };
    expect(signalPatternIsFast({ pattern_probe_chars: 2000, pattern_probe_ms: 10, pattern_probe_retry_ms: 40 }, timeBox)("\\bretry_probe_fixture\\b")).toBe(true);
    expect(budgets[0]).toBe(10);
    expect(budgets.slice(1).length).toBeGreaterThan(1);
    expect(budgets.slice(1).every((ms) => ms === 40)).toBe(true);
  });

  it("keeps a slow verdict across runs and tests a changed pattern or budget afresh", () => {
    const timeBox = vi.fn<TimeBox>(() => false);
    const settings = { pattern_probe_chars: 2000, pattern_probe_ms: 11, pattern_probe_retry_ms: 44 };
    expect(signalPatternIsFast(settings, timeBox)("stable_probe_fixture")).toBe(false);
    expect(timeBox).toHaveBeenCalledTimes(2);
    expect(signalPatternIsFast({ ...settings }, timeBox)("stable_probe_fixture")).toBe(false);
    expect(timeBox).toHaveBeenCalledTimes(2);
    expect(signalPatternIsFast(settings, timeBox)("changed_probe_fixture")).toBe(false);
    expect(timeBox).toHaveBeenCalledTimes(4);
    expect(signalPatternIsFast({ ...settings, pattern_probe_retry_ms: 45 }, timeBox)("stable_probe_fixture")).toBe(false);
    expect(timeBox).toHaveBeenCalledTimes(6);
  });
});

describe("interest pattern limits", () => {
  it("supplies absent keys from the schema and keeps explicit overrides", () => {
    const raw = shippedYaml("interests.yaml");
    const rawLimits = raw.limits as Record<string, unknown>;
    for (const key of Object.keys(SIGNAL_PROBE_DEFAULTS)) delete rawLimits[key];
    expect(interestsSchema.parse(raw).limits).toMatchObject(SIGNAL_PROBE_DEFAULTS);
    Object.assign(rawLimits, { pattern_probe_chars: 3000, pattern_probe_ms: 20, pattern_probe_retry_ms: 80, pattern_job_ms: 100 });
    expect(interestsSchema.parse(raw).limits).toMatchObject(rawLimits);
    delete raw.limits;
    expect(interestsSchema.parse(raw).limits).toMatchObject(SIGNAL_PROBE_DEFAULTS);
  });

  it.each([
    ["pattern_probe_chars", 1999],
    ["pattern_probe_ms", 9],
    ["pattern_probe_retry_ms", 9],
    ["pattern_job_ms", 49],
  ])("refuses a %s value below the minimum", (key, value) => {
    const raw = shippedYaml("interests.yaml");
    (raw.limits as Record<string, unknown>)[key] = value;
    expect(interestsSchema.safeParse(raw).success).toBe(false);
  });

  it("interrupts a running expression at the job budget, including one the probe accepts", () => {
    const pattern = "\\bticket:(\\d+)+x\\b";
    expect(signalPatternIsFast(limits)(pattern)).toBe(true);
    let finished = false;
    const { value, ms } = timed(() => withinJobBudget(() => {
      new RegExp(pattern, "iu").test(`ticket:${"1".repeat(80)}!`);
      finished = true;
    }, { pattern_job_ms: 50 }));
    expect(value).toBe(false);
    expect(finished).toBe(false);
    expect(ms).toBeLessThan(3000);
  });

  it("passes the configured job budget to the time box", () => {
    const timeBox = vi.fn<TimeBox>(() => false);
    const work = vi.fn();
    expect(withinJobBudget(work, { pattern_job_ms: 125 }, timeBox)).toBe(false);
    expect(timeBox).toHaveBeenCalledWith(work, 125);
  });
});

describe("findCandidates with the guard", () => {
  it("leaves a slow pattern out: the scan ends fast, the category's other words still hit, a warning names the category", () => {
    const interests = shippedInterests((raw) => {
      (rawCategory(raw, "T2").patterns as string[]).push(SLOW);
    });
    const { warn, guard } = warnings();
    const { value, ms } = timed(() => findCandidates(`${SENTENCE} We offer equity.`, interests, shippedPipeline(), guard));
    expect(ms).toBeLessThan(3000);
    expect(value.filter((candidate) => candidate.tier === "T2")).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ category: "T2", field: "patterns" });
    // compiled once per config and guard: a second job does not probe or warn again
    findCandidates(`${SENTENCE} Equity too.`, interests, shippedPipeline(), guard);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("leaves slow exclude and tag patterns out too", () => {
    const interests = shippedInterests((raw) => {
      (rawCategory(raw, "T2").exclude as string[]).push(SLOW);
      (rawCategory(raw, "tag").tag_patterns as Array<Record<string, string>>).push({ name: "Learning budget", pattern: SLOW });
    });
    const { warn, guard } = warnings();
    const { value, ms } = timed(() => findCandidates(`${SENTENCE} We offer equity.`, interests, shippedPipeline(), guard));
    expect(ms).toBeLessThan(3000);
    expect(value.some((candidate) => candidate.tier === "T2")).toBe(true);
    expect(warn.mock.calls.map((call) => call[1])).toEqual([expect.objectContaining({ category: "T2", field: "exclude" }), expect.objectContaining({ category: "tag", field: "tag_patterns" })]);
  });
});

describe("findQuoteTerm with the guard (the job page)", () => {
  it("marks the term of a stored quote without running the slow pattern", () => {
    const interests = shippedInterests((raw) => {
      (rawCategory(raw, "T2").patterns as string[]).push(SLOW);
    });
    const quote = `${SENTENCE} Equity for all.`;
    const { value, ms } = timed(() => findQuoteTerm(quote, "T2", interests, warnings().guard));
    expect(ms).toBeLessThan(3000);
    expect(value && quote.slice(value.start, value.end)).toBe("Equity");
  });
});

describe("suggestion validation with the probe", () => {
  it("does not run a slow pattern on the suggested term", () => {
    const interests = shippedInterests((raw) => {
      (rawCategory(raw, "tag").tag_patterns as Array<Record<string, string>>).push({ name: "Learning budget", pattern: SLOW });
    });
    const output = { ...emptyOutput(), signal_words: [{ tier: "tag", term: "Wir bieten eine tolle Arbeitsumgebung", ...reasons, evidence: [] }] };
    const { value, ms } = timed(() => validateSuggestions(output, context({ interests, isPatternFast: signalPatternIsFast(limits) })));
    expect(ms).toBeLessThan(3000);
    expect(value.dropped.already_listed).toBeUndefined();
  });
});
