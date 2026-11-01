// @vitest-environment node
import { describe, expect, it } from "vitest";

import { aiUsageHref, loadAiUsageSearchParams, pageOf, type AiUsageUrlState } from "@/lib/ai-usage/params";

const empty: AiUsageUrlState = { range: null, from: null, to: null, provider: null, model: null, task: null, metric: null, page: null };

describe("aiUsageHref", () => {
  it("writes only what is set and not the default, in a fixed order", () => {
    expect(aiUsageHref(empty)).toBe("/sources/ai-usage");
    expect(aiUsageHref({ ...empty, page: 1, metric: "tokens" })).toBe("/sources/ai-usage");
    expect(aiUsageHref({ ...empty, task: "translate", provider: "deepseek", range: "7d", metric: "calls", page: 3 })).toBe("/sources/ai-usage?range=7d&provider=deepseek&task=translate&metric=calls&page=3");
  });
  it("writes from / to only for a custom range", () => {
    expect(aiUsageHref({ ...empty, range: "custom", from: "2026-09-01", to: "2026-09-15" })).toBe("/sources/ai-usage?range=custom&from=2026-09-01&to=2026-09-15");
    expect(aiUsageHref({ ...empty, range: "custom", from: "2026-09-01", to: "2026-09-15" }, { range: "7d" })).toBe("/sources/ai-usage?range=7d");
  });
  it("a patch can drop a value and the page", () => {
    expect(aiUsageHref({ ...empty, range: "30d", task: "score", page: 4 }, { task: null, page: null })).toBe("/sources/ai-usage?range=30d");
  });
  it("supports another base path (the export route)", () => {
    expect(aiUsageHref({ ...empty, range: "month" }, {}, "/sources/ai-usage/export")).toBe("/sources/ai-usage/export?range=month");
  });
});

describe("loadAiUsageSearchParams", () => {
  it("drops invalid values", async () => {
    const state = await loadAiUsageSearchParams({ range: "forever", from: "2026-13-01", provider: "acme", model: "has space", task: "Bad-Task", metric: "x", page: "abc" });
    expect(state).toEqual(empty);
  });
  it("keeps valid values", async () => {
    const state = await loadAiUsageSearchParams({ range: "custom", from: "2026-09-01", to: "2026-09-02", provider: "codex-cli", model: "gpt-6.1-sol", task: "translate", metric: "calls", page: "2" });
    expect(state).toEqual({ range: "custom", from: "2026-09-01", to: "2026-09-02", provider: "codex-cli", model: "gpt-6.1-sol", task: "translate", metric: "calls", page: 2 });
  });
  it("pageOf never goes below 1", () => {
    expect(pageOf({ page: null })).toBe(1);
    expect(pageOf({ page: -3 })).toBe(1);
    expect(pageOf({ page: 5 })).toBe(5);
  });
});
