import { describe, expect, it } from "vitest";

import { researchSchema, type ResearchConfig } from "@/lib/config";
import { shouldAutoResearch, statusStartsResearch } from "@/lib/research/auto";

function config(over: { enabled?: boolean; trigger?: string; highScore?: boolean; noAuto?: boolean } = {}): ResearchConfig {
  return researchSchema.parse({
    enabled: over.enabled ?? true,
    company: { ttl_days: 30, max_per_day: 3, max_searches: 8, timeout_seconds: 60, max_field_chars: 400, allowed_domains: ["linkedin.com"], non_company_hosts: ["linkedin.com"], employees: { min: 1, max: 3_000_000 }, rating: { min: 0, max: 5 }, web_search_usd: 0.01 },
    ...(over.noAuto
      ? {}
      : { auto: { trigger: over.trigger ?? "favorite", items: ["company"], max_per_day: 5, high_score: { enabled: over.highScore ?? false, min_rank: 80, per_cycle_limit: 3, max_age_days: 3, max_per_day: 5 } } }),
  });
}

describe("what starts research by itself", () => {
  it.each([
    ["manual", "favorite", false],
    ["manual", "status", false],
    ["favorite", "favorite", true],
    ["favorite", "status", false],
    ["favorite_or_applying", "favorite", true],
    ["favorite_or_applying", "status", true],
  ] as const)("trigger %s, event %s: %s", (trigger, event, expected) => {
    expect(shouldAutoResearch(event, config({ trigger }))).toBe(expected);
  });

  it("nothing while the master switch is off", () => {
    for (const event of ["favorite", "status", "high_score_new"] as const) expect(shouldAutoResearch(event, config({ enabled: false, trigger: "favorite_or_applying", highScore: true }))).toBe(false);
  });

  it("high-score jobs have their own switch", () => {
    expect(shouldAutoResearch("high_score_new", config({ trigger: "manual", highScore: true }))).toBe(true);
    expect(shouldAutoResearch("high_score_new", config({ trigger: "favorite_or_applying", highScore: false }))).toBe(false);
  });

  it("a file written before these settings existed stays manual", () => {
    const old = config({ noAuto: true });
    expect(old.auto.trigger).toBe("manual");
    expect(shouldAutoResearch("favorite", old)).toBe(false);
    expect(shouldAutoResearch("high_score_new", old)).toBe(false);
  });

  it("only the statuses of working on an application", () => {
    expect(["interested", "preparing", "applied"].every((status) => statusStartsResearch(status as never))).toBe(true);
    for (const status of ["new", "rejected", "ignored", "archived"]) expect(statusStartsResearch(status as never)).toBe(false);
  });
});
