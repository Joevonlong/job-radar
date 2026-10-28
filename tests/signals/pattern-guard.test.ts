/**
 * The probe of the user's interest patterns: a pattern with catastrophic backtracking is left out of the rules (with a
 * warning naming its category) instead of holding the process on one description; the shipped vocabulary passes it.
 */
import { describe, expect, it, vi } from "vitest";

import { slowInterestPatterns } from "@/lib/config";
import { validateSuggestions } from "@/lib/interests/suggest-validate";
import { signalPatternGuard, signalPatternIsFast, signalProbeLimits } from "@/lib/signals/pattern-guard";
import { findCandidates, findQuoteTerm } from "@/lib/signals/rules";

import { context, emptyOutput, reasons } from "../interests/helpers";
import { rawCategory, shippedInterests, shippedPipeline } from "./helpers";

/** Looks harmless, backtracks exponentially on a run of words without "budget" (seconds on 38 characters). */
const SLOW = "(\\w+\\s*)*budget";
const SENTENCE = "Wir bieten eine tolle Arbeitsumgebung.";

const limits = { match_text_max_chars: 20_000, match_ms: 100 };
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
    expect(slowInterestPatterns(interests, signalPatternIsFast(signalProbeLimits(shippedPipeline())))).toEqual([]);
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
});

describe("findCandidates with the guard", () => {
  it("leaves a slow pattern out: the scan ends fast, the category's other words still hit, a warning names the category", () => {
    const interests = shippedInterests((raw) => {
      (rawCategory(raw, "T2").patterns as string[]).push(SLOW);
    });
    const { warn, guard } = warnings();
    const { value, ms } = timed(() => findCandidates(`${SENTENCE} We offer equity.`, interests, shippedPipeline(), guard));
    expect(ms).toBeLessThan(1000);
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
    expect(ms).toBeLessThan(1000);
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
    expect(ms).toBeLessThan(1000);
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
    expect(ms).toBeLessThan(1000);
    expect(value.dropped.already_listed).toBeUndefined();
  });
});
