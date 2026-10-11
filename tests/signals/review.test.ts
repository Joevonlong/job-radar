import { describe, expect, it } from "vitest";

import type { AiSignal, AiSignalsOutput } from "@/lib/ai/prompts/signals";
import { buildSignalsPrompt, LEGACY_SYSTEM, truncateJd } from "@/lib/ai/prompts/signals";
import { signalsPrompt } from "@/lib/signals/fingerprint";
import { mergeAiReview, numberCandidates, toPromptCandidates } from "@/lib/signals/review";

import { candidatesOf, shippedInterests, shippedPipeline } from "./helpers";

const JD = [
  "## Compensation",
  "Salary: €85,000–105,000 per year plus equity.",
  "Competitive salary package for the right person.",
  "Bonus points if you know Rust.",
  "We also pay a yearly performance bonus of up to 10%.",
  "Monthly gross salary for the other team: EUR 7,200.",
].join("\n");

const interests = shippedInterests();
const pipeline = shippedPipeline();
const candidates = numberCandidates(candidatesOf(JD));
const idOf = (tier: string, contains: string): number => {
  const found = candidates.find((c) => c.candidate.tier === tier && c.candidate.quote.includes(contains));
  if (!found) throw new Error(`no ${tier} candidate with "${contains}"`);
  return found.id;
};

const signal = (over: Partial<AiSignal>): AiSignal => ({ tier: "T3", kind: "x", quote: "", candidate: null, amount: null, ...over });
const merge = (output: Partial<AiSignalsOutput>, description = JD) =>
  mergeAiReview({ description, candidates, output: { signals: [], rejected: [], ...output }, interests, pipeline });

/** The output schema of the default categories (T1-T4). */
const aiSignalsSchema = () => {
  const spec = signalsPrompt(shippedInterests());
  if (!spec) throw new Error("no AI categories");
  return spec.schema;
};

describe("rule candidates before the AI", () => {
  it("hold T1 to T3 plus T4 candidates waiting for the AI", () => {
    expect(candidates.map((c) => c.candidate.tier)).toEqual(expect.arrayContaining(["T1", "T2", "T3", "T4"]));
    expect(candidates.filter((c) => c.candidate.aiConfirmOnly).map((c) => c.candidate.tier)).toEqual(["T4"]);
  });

  it("are shown to the AI numbered, with the parsed amount", () => {
    const shown = toPromptCandidates(candidates);
    expect(shown[0]).toMatchObject({ id: 1, tier: "T1", parsed: "85000-105000 EUR per year" });
    const prompt = buildSignalsPrompt({ title: "Engineer", description: JD, candidates: shown, quoteMaxChars: 280, maxJdChars: 12000, system: LEGACY_SYSTEM });
    expect(prompt.user).toContain("[1] T1 (rules read: 85000-105000 EUR per year)");
    expect(prompt.user).toContain("Salary: €85,000–105,000 per year plus equity.");
    expect(prompt.system).toContain("character for character");
  });
});

describe("mergeAiReview", () => {
  it("keeps the candidates the AI left alone, drops the broad T4 ones", () => {
    const { signals, stats } = merge({});
    expect(signals.map((s) => s.tier)).toEqual(["T1", "T2", "T3"]);
    expect(signals.every((s) => s.extractor === "rule")).toBe(true);
    expect(stats.unreviewed).toBe(3);
  });

  it("drops a rejected candidate", () => {
    const t3 = idOf("T3", "Competitive salary");
    const { signals, stats } = merge({ rejected: [t3] });
    expect(signals.some((s) => s.tier === "T3")).toBe(false);
    expect(stats.rejected).toBe(1);
  });

  it("turns a confirmed T4 candidate into an AI signal", () => {
    const t4 = idOf("T4", "performance bonus");
    const { signals, stats } = merge({
      signals: [signal({ tier: "T4", kind: "performance_bonus", candidate: t4, quote: "ignored for candidates" })],
    });
    const found = signals.find((s) => s.tier === "T4");
    expect(found).toMatchObject({ kind: "performance_bonus", extractor: "ai", quote: "We also pay a yearly performance bonus of up to 10%." });
    expect(JD.slice(found?.quoteOffset ?? 0)).toContain(found?.quote ?? "?");
    expect(stats.confirmed).toBe(1);
  });

  it("keeps a confirmed rule signal as a rule signal", () => {
    const t3 = idOf("T3", "Competitive salary");
    const { signals } = merge({ signals: [signal({ tier: "T3", candidate: t3 })] });
    expect(signals.find((s) => s.tier === "T3")).toMatchObject({ extractor: "rule", kind: "competitive_pay" });
  });

  it("adds a signal the rules missed when its quote is in the JD", () => {
    const text = "We pay top of the market for strong engineers.\nPlus a yearly profit share.";
    const found = mergeAiReview({
      description: text,
      candidates: [],
      output: { signals: [signal({ tier: "T3", kind: "top_of_market", quote: "We pay top of the market for strong engineers." })], rejected: [] },
      interests,
      pipeline,
    });
    expect(found.signals).toEqual([
      { tier: "T3", kind: "top_of_market", value: null, quote: "We pay top of the market for strong engineers.", quoteOffset: 0, extractor: "ai" },
    ]);
    expect(found.stats.added).toBe(1);
  });

  it("discards a signal whose quote is not in the JD (C7)", () => {
    const { signals, stats } = merge({ signals: [signal({ tier: "T2", quote: "Generous stock option plan with 4 year vesting" })] });
    expect(signals.some((s) => s.quote.includes("vesting"))).toBe(false);
    expect(stats.droppedQuote).toBe(1);
    expect(stats.added).toBe(0);
  });

  it("repairs a quote that differs only in whitespace, storing the JD's own text", () => {
    const text = "Wir bieten\nein attraktives Gehalt\nund mehr.";
    const out = mergeAiReview({
      description: text,
      candidates: [],
      output: { signals: [signal({ tier: "T3", quote: "Wir bieten ein attraktives Gehalt und mehr." })], rejected: [] },
      interests,
      pipeline,
    });
    expect(out.signals[0]?.quote).toBe(text);
    expect(out.signals[0]?.quoteOffset).toBe(0);
  });

  it("discards a quote longer than the limit", () => {
    const long = `Intro. ${"word ".repeat(100)}end.`;
    const out = mergeAiReview({ description: long, candidates: [], output: { signals: [signal({ tier: "T3", quote: long })], rejected: [] }, interests, pipeline });
    expect(out.signals).toEqual([]);
    expect(out.stats.droppedQuote).toBe(1);
  });

  it("normalizes a monthly amount to a year and ignores the AI's arithmetic", () => {
    const quote = "Monthly gross salary for the other team: EUR 7,200.";
    const out = merge({ signals: [signal({ tier: "T1", quote, amount: { min: 7200, max: 7200, currency: "EUR", period: "month" } })] });
    const value = out.signals.find((s) => s.quote === quote)?.value;
    expect(value).toMatchObject({ currency: "EUR", min: 86400, max: 86400, stated: { period: "month" } });
  });

  it("rejects an AI amount whose figures are not in the quote", () => {
    const quote = "Salary: €85,000–105,000 per year plus equity.";
    const wrong = merge({ signals: [signal({ tier: "T1", candidate: null, quote, amount: { min: 120000, max: 140000, currency: "EUR", period: "year" } })] });
    expect(wrong.stats.droppedAmount).toBe(1);
    // the rule's own reading of that sentence is still there
    expect(wrong.signals.find((s) => s.tier === "T1" && s.quote === quote)?.extractor).toBe("rule");
  });

  it("drops a new T1 without an amount or below the minimum", () => {
    const quote = "Salary: €85,000–105,000 per year plus equity.";
    expect(merge({ signals: [signal({ tier: "T1", quote, amount: null })] }).stats.droppedAmount).toBe(1);
    const tiny = "We pay €3 per hour of coffee";
    const out = mergeAiReview({ description: tiny, candidates: [], output: { signals: [signal({ tier: "T1", quote: tiny, amount: { min: 3, max: 3, currency: "EUR", period: "hour" } })], rejected: [] }, interests, pipeline });
    expect(out.signals).toEqual([]);
  });

  it("takes the AI's normalized amount for a confirmed T1 candidate (marked ai when it differs)", () => {
    const t1 = idOf("T1", "85,000");
    const out = merge({ signals: [signal({ tier: "T1", candidate: t1, quote: "x", amount: { min: 85000, max: 105000, currency: "EUR", period: "year" } })] });
    const found = out.signals.find((s) => s.tier === "T1" && s.quote.includes("85,000"));
    expect(found).toMatchObject({ extractor: "rule", value: { min: 85000, max: 105000 } });
  });

  it("does not store the same sentence twice, treats an unknown candidate id as a new signal", () => {
    const out = merge({
      signals: [
        signal({ tier: "T3", candidate: 999, quote: "Competitive salary package for the right person." }),
        signal({ tier: "T3", candidate: null, quote: "Competitive salary package for the right person." }),
      ],
    });
    expect(out.signals.filter((s) => s.tier === "T3")).toHaveLength(1);
  });

  it("lets a rejection win over a contradictory confirmation", () => {
    const t3 = idOf("T3", "Competitive salary");
    const out = merge({ signals: [signal({ tier: "T3", candidate: t3 })], rejected: [t3] });
    expect(out.signals.some((s) => s.tier === "T3")).toBe(false);
  });

  it("moves a reclassified candidate to the new tier", () => {
    const t3 = idOf("T3", "Competitive salary");
    const out = merge({ signals: [signal({ tier: "T4", candidate: t3, quote: "Competitive salary package for the right person." })] });
    expect(out.signals.some((s) => s.tier === "T3")).toBe(false);
    expect(out.signals.find((s) => s.tier === "T4")?.extractor).toBe("ai");
  });

  it("limits signals per tier", () => {
    const text = Array.from({ length: 6 }, (_, i) => `Perk ${i}: yearly profit share number ${i}.`).join("\n");
    const out = mergeAiReview({
      description: text,
      candidates: [],
      output: { signals: Array.from({ length: 6 }, (_, i) => signal({ tier: "T4", quote: `Perk ${i}: yearly profit share number ${i}.` })), rejected: [] },
      interests,
      pipeline,
    });
    expect(out.signals).toHaveLength(interests.limits.per_category_max);
  });
});

describe("AI output schema", () => {
  it("accepts a well-formed answer and rejects a tier outside T1-T4", () => {
    expect(aiSignalsSchema().safeParse({ signals: [{ tier: "T2", kind: "equity", quote: "x", candidate: null, amount: null }], rejected: [] }).success).toBe(true);
    expect(aiSignalsSchema().safeParse({ signals: [{ tier: "T5", kind: "x", quote: "x", candidate: null, amount: null }], rejected: [] }).success).toBe(false);
    expect(aiSignalsSchema().safeParse({ signals: [] }).success).toBe(false);
  });

  it("cuts a long JD in the middle", () => {
    const cut = truncateJd("a".repeat(100) + "b".repeat(100), 50);
    expect(cut.length).toBeLessThan(120);
    expect(cut).toContain("[... text omitted ...]");
    expect(cut.startsWith("a")).toBe(true);
    expect(cut.endsWith("b")).toBe(true);
    expect(truncateJd("short", 50)).toBe("short");
  });
});
