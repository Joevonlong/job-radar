// @vitest-environment node
import { describe, expect, it } from "vitest";

import { sanitize, registerSecret } from "@/lib/ai/errors";
import { costOfUsage, createMemoryUsageStore, estimateCostUsd, estimateEquivalentUsd } from "@/lib/ai/usage";

import { bareCatalog, usageEntry } from "./helpers";

const catalog = bareCatalog((raw) => {
  const providers = raw.providers as Record<string, { models: Record<string, unknown>[] }>;
  providers.anthropic!.models[0]!.aliases = ["claude-haiku-4-5-20251001"];
});

describe("estimateCostUsd", () => {
  it("prices API models per 1M tokens from the catalog", () => {
    expect(estimateCostUsd(catalog, "anthropic", "claude-haiku-4-5", { tokensIn: 2_000_000, tokensOut: 500_000 })).toEqual({ costUsd: 4.5, priced: "exact" });
    expect(estimateCostUsd(catalog, "deepseek", "deepseek-v4-flash", { tokensIn: 1000, tokensOut: 1000 }).costUsd).toBeCloseTo(0.0015, 6);
  });
  it("finds a model by alias", () => {
    expect(estimateCostUsd(catalog, "anthropic", "claude-haiku-4-5-20251001", { tokensIn: 1_000_000, tokensOut: 0 })).toEqual({ costUsd: 1, priced: "exact" });
  });
  it("prices an unknown reported name at the provider's highest price", () => {
    // anthropic: highest input 2, highest output 10 (claude-sonnet-5-5)
    expect(estimateCostUsd(catalog, "anthropic", "mystery", { tokensIn: 1_000_000, tokensOut: 1_000_000 })).toEqual({ costUsd: 12, priced: "fallback" });
  });
  it("is 0 for subscription CLIs whatever the tokens", () => {
    expect(estimateCostUsd(catalog, "claude-cli", "claude-haiku-4-5", { tokensIn: 5_000_000, tokensOut: 5_000_000 })).toEqual({ costUsd: 0, priced: "exact" });
    expect(estimateCostUsd(catalog, "codex-cli", "codex-default", { tokensIn: 1, tokensOut: 1 }).costUsd).toBe(0);
  });
  it("is 0 / none without a catalog", () => {
    expect(estimateCostUsd(null, "anthropic", "claude-haiku-4-5", { tokensIn: 1000, tokensOut: 1000 })).toEqual({ costUsd: 0, priced: "none" });
  });
});

describe("costOfUsage", () => {
  const price = { input_per_mtok: 1, output_per_mtok: 5 };
  it("prices input and output only without sub-counts", () => {
    expect(costOfUsage(price, { tokensIn: 2_000_000, tokensOut: 500_000 })).toBe(4.5);
  });
  it("prices cache reads and writes at their own price", () => {
    const cached = { ...price, cached_input_per_mtok: 0.1, cache_write_per_mtok: 1.25 };
    // 1M uncached + 1M cached + 1M written + 1M out = 1 + 0.1 + 1.25 + 5
    expect(costOfUsage(cached, { tokensIn: 3_000_000, tokensOut: 1_000_000, cachedIn: 1_000_000, cacheWriteIn: 1_000_000 })).toBe(7.35);
  });
  it("prices cache tokens like input when the catalog has no cache price (same as before AI usage tracking)", () => {
    expect(costOfUsage(price, { tokensIn: 3_000_000, tokensOut: 0, cachedIn: 1_000_000, cacheWriteIn: 1_000_000 })).toBe(3);
  });
  it("never goes below zero when the sub-counts exceed the input", () => {
    expect(costOfUsage({ ...price, cached_input_per_mtok: 0.1 }, { tokensIn: 1_000_000, tokensOut: 0, cachedIn: 2_000_000 })).toBe(0.2);
  });
});

describe("estimateEquivalentUsd", () => {
  const withEquivalent = bareCatalog((raw) => {
    const providers = raw.providers as Record<string, { models: Record<string, unknown>[] }>;
    providers["claude-cli"]!.models[0]!.aliases = ["claude-haiku-4-5-20251001"];
    providers["claude-cli"]!.models[0]!.equivalent_price = { input_per_mtok: 1, output_per_mtok: 5, source: "test" };
  });
  const usage = { tokensIn: 1_000_000, tokensOut: 1_000_000 };
  it("equals the actual cost for an API call, also when it was priced as a fallback", () => {
    const actual = estimateCostUsd(catalog, "anthropic", "mystery", usage);
    expect(estimateEquivalentUsd(catalog, "anthropic", "mystery", usage, actual)).toBe(12);
  });
  it("is unknown for an API call that had no price", () => {
    expect(estimateEquivalentUsd(null, "anthropic", "x", usage, { costUsd: 0, priced: "none" })).toBeNull();
  });
  it("prices a subscription call with equivalent_price, by id or alias", () => {
    const actual = { costUsd: 0, priced: "exact" as const };
    expect(estimateEquivalentUsd(withEquivalent, "claude-cli", "claude-haiku-4-5", usage, actual)).toBe(6);
    expect(estimateEquivalentUsd(withEquivalent, "claude-cli", "claude-haiku-4-5-20251001", usage, actual)).toBe(6);
  });
  it("is unknown without an equivalent price, for an unknown model, and when the reply had no usage", () => {
    const actual = { costUsd: 0, priced: "exact" as const };
    expect(estimateEquivalentUsd(catalog, "claude-cli", "claude-haiku-4-5", usage, actual)).toBeNull();
    expect(estimateEquivalentUsd(withEquivalent, "claude-cli", "mystery", usage, actual)).toBeNull();
    expect(estimateEquivalentUsd(withEquivalent, "claude-cli", "claude-haiku-4-5", { tokensIn: 0, tokensOut: 0, reported: false }, actual)).toBeNull();
  });
});

describe("memory usage store", () => {
  it("sums API spend of one month in the given time zone", async () => {
    const store = createMemoryUsageStore();
    const entry = { task: "score" as const, tokensIn: 1, tokensOut: 1 };
    const record = (e: { provider: "anthropic" | "deepseek" | "claude-cli"; costUsd: number; at: Date }) => store.record(usageEntry({ ...entry, ...e }));
    await record({ provider: "anthropic", costUsd: 1, at: new Date("2026-10-31T23:30:00Z") }); // Nov 1 in Berlin
    await record({ provider: "deepseek", costUsd: 2, at: new Date("2026-10-15T10:00:00Z") });
    await record({ provider: "claude-cli", costUsd: 9, at: new Date("2026-10-15T10:00:00Z") });
    expect(await store.apiSpendUsd("2026-10", "Europe/Berlin")).toBe(2);
    expect(await store.apiSpendUsd("2026-11", "Europe/Berlin")).toBe(1);
    expect(await store.apiSpendUsd("2026-10", "UTC")).toBe(3);
  });
});

describe("sanitize", () => {
  it("masks environment secrets, registered secrets and generic key shapes", () => {
    registerSecret("registered-secret-value");
    const env = { ANTHROPIC_API_KEY: "env-secret-value-1" };
    const text = sanitize("a env-secret-value-1 b registered-secret-value c sk-abcdefghijklmnop d Bearer abcdefghijkl1234 e api_key=ABCDEF123456", env);
    expect(text).not.toMatch(/env-secret|registered-secret|sk-abc|abcdefghijkl1234|ABCDEF123456/);
    expect(text).toContain("[redacted]");
  });
  it("shortens long text", () => {
    expect(sanitize("x".repeat(5000)).length).toBeLessThan(500);
  });
});
