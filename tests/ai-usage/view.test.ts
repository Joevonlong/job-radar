// @vitest-environment node
import { describe, expect, it } from "vitest";

import { resolveAiUsageRange } from "@/lib/ai-usage/range";
import { buildAiUsageView } from "@/lib/ai-usage/view";
import type { AiUsageGroup } from "@/lib/db/queries/ai-usage";

const TODAY = "2026-10-08";
const range = resolveAiUsageRange({ range: "30d", from: null, to: null }, { today: TODAY, defaultRange: "30d", customMaxDays: 366 });

const g = (day: string, over: Partial<AiUsageGroup>): AiUsageGroup => ({
  day, provider: "codex-cli", model: "gpt-6.1-sol", modelSource: "cli_default", task: "score", outcome: "ok", calls: 1, tokenCalls: 1,
  tokensIn: 0, tokensInCached: 0, tokensInCacheWrite: 0, tokensOut: 0, tokensOutReasoning: 0, durationMsSum: 0, durationCalls: 0, cachedCalls: 1, reasoningCalls: 1,
  equivalentUsd: 0, equivalentCalls: 0, actualUsd: 0, actualCalls: 1, actualUsdWithEquivalent: 0, ...over,
});

// the eight seeded calls of src/lib/db/seed.ts
const groups: AiUsageGroup[] = [
  g(TODAY, { tokensIn: 3000, tokensInCached: 1000, tokensOut: 200, tokensOutReasoning: 50, durationMsSum: 8000, durationCalls: 1, equivalentUsd: 0.0061, equivalentCalls: 1 }),
  g(TODAY, { task: "signals", outcome: "invalid_output", tokensIn: 2500, tokensOut: 300, durationMsSum: 6000, durationCalls: 1, equivalentUsd: 0.008, equivalentCalls: 1 }),
  g(TODAY, { task: "signals", tokensIn: 2600, tokensOut: 150, durationMsSum: 5000, durationCalls: 1, equivalentUsd: 0.0067, equivalentCalls: 1 }),
  g("2026-10-07", { provider: "claude-cli", model: "claude-haiku-4-5", modelSource: "call", task: "translate", tokensIn: 1800, tokensOut: 900, durationMsSum: 30000, durationCalls: 1, equivalentUsd: 0.0063, equivalentCalls: 1 }),
  g("2026-10-06", { task: "translate", outcome: "failed", tokenCalls: 0, cachedCalls: 0, reasoningCalls: 0, durationMsSum: 90000, durationCalls: 1 }),
  g("2026-10-05", { provider: "deepseek", model: "deepseek-v4-flash", modelSource: "call", task: "translate", tokensIn: 2000, tokensInCached: 500, tokensOut: 800, durationMsSum: 4000, durationCalls: 1, equivalentUsd: 0.00156, equivalentCalls: 1, actualUsd: 0.00156, actualUsdWithEquivalent: 0.00156 }),
  g("2026-10-03", { task: "summarize", tokenCalls: 0, cachedCalls: 0, reasoningCalls: 0, durationMsSum: 20000, durationCalls: 1 }),
  g("2026-09-30", { provider: "claude-cli", model: null, modelSource: null, outcome: null, cachedCalls: 0, reasoningCalls: 0, tokensIn: 1500, tokensOut: 100 }),
];
const input = (list: AiUsageGroup[], filter = {}) => ({
  groups: list, range, filter,
  labels: (provider: string, model: string) => (model === "gpt-6.1-sol" ? "GPT-6.1 Sol" : provider === "claude-cli" ? "Claude Haiku 4.5" : null),
  isSubscription: (provider: string) => provider.endsWith("-cli"),
});

describe("buildAiUsageView", () => {
  const view = buildAiUsageView(input(groups));
  it("adds up the seeded rows", () => {
    expect(view.totals).toMatchObject({
      calls: 8, ok: 5, invalid: 1, failed: 1, legacy: 1, tokenCalls: 6, tokenUnknownCalls: 2,
      tokensIn: 13400, tokensInCached: 1500, tokensOut: 2450, tokensOutReasoning: 50, equivalentUnknownCalls: 3, actualUnknownCalls: 0,
    });
    expect(view.totals.equivalentUsd).toBeCloseTo(0.02866, 6);
    expect(view.totals.actualUsd).toBeCloseTo(0.00156, 6);
    expect(view.totals.savingsUsd).toBeCloseTo(0.0271, 6);
    expect(view.empty).toBe(false);
  });
  it("groups by model, most expensive first, unknown model not clickable", () => {
    expect(view.byModel.map((r) => r.key)).toEqual(["codex-cli|gpt-6.1-sol", "claude-cli|claude-haiku-4-5", "deepseek|deepseek-v4-flash", "claude-cli|∅"]);
    expect(view.byModel[0]).toMatchObject({ modelLabel: "GPT-6.1 Sol", modelSource: "cli_default", calls: 5, filter: { provider: "codex-cli", model: "gpt-6.1-sol" } });
    expect(view.byModel[3]).toMatchObject({ model: null, filter: null });
    expect(view.byModel[0]?.share).toBeCloseTo((0.0208 / 0.02866) * 100, 1);
  });
  it("groups by provider and by task", () => {
    expect(view.byProvider.map((r) => [r.key, r.calls])).toEqual([["codex-cli", 5], ["claude-cli", 2], ["deepseek", 1]]);
    expect(view.byTask.find((r) => r.key === "translate")).toMatchObject({ calls: 3, tokenUnknownCalls: 1, filter: { task: "translate" } });
    expect(view.byTask.find((r) => r.key === "translate")?.equivalentUsd).toBeCloseTo(0.00786, 6);
  });
  it("has a column for every day of the window, zeros included", () => {
    expect(view.days).toHaveLength(30);
    expect(view.days.at(-1)?.byProvider["codex-cli"]).toMatchObject({ calls: 3, tokens: 8750 });
    expect(view.days[0]?.byProvider).toEqual({});
  });
  it("lists subscription models that have token counts but no equivalent price", () => {
    const missing = buildAiUsageView(input([g(TODAY, { tokensIn: 10, tokensOut: 1 }), g(TODAY, { model: "gpt-x", tokenCalls: 0 })]));
    expect(missing.missingEquivalentModels).toEqual([{ provider: "codex-cli", model: "gpt-6.1-sol" }]);
    expect(view.missingEquivalentModels).toEqual([]);
  });
  it("counts the calls whose cached / reasoning tokens are unknown instead of calling them 0", () => {
    expect(view.totals).toMatchObject({ cachedUnknownCalls: 1, reasoningUnknownCalls: 1 });
    expect(view.byModel.find((r) => r.key === "claude-cli|∅")).toMatchObject({ cachedUnknownCalls: 1, tokenCalls: 1 });
    expect(view.byModel[0]).toMatchObject({ cachedUnknownCalls: 0 });
  });
  it("separates calls with an unknown model from calls whose model has no equivalent price", () => {
    expect(view.totals).toMatchObject({ equivalentUnknownCalls: 3, equivalentUnknownModelCalls: 1 });
  });
  it("is empty without groups", () => {
    expect(buildAiUsageView(input([])).empty).toBe(true);
  });
  it("assumed models win the source label", () => {
    const mixed = buildAiUsageView(input([g(TODAY, { modelSource: "call" }), g(TODAY, { modelSource: "assumed", task: "x" })]));
    expect(mixed.byModel[0]?.modelSource).toBe("assumed");
  });
});
