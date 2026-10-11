// @vitest-environment node
import { describe, expect, it } from "vitest";

import { configRegistry } from "@/lib/config";

import { shippedYaml } from "../config/helpers";

const paths = (edit: (scoring: Record<string, unknown>) => void): string[] => {
  const raw = structuredClone(shippedYaml("ai.yaml"));
  edit(raw.scoring as Record<string, unknown>);
  const result = configRegistry.ai.schema.safeParse(raw);
  return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
};

describe("ai.yaml scoring block", () => {
  it("ships the documented defaults", () => {
    const parsed = configRegistry.ai.schema.parse(shippedYaml("ai.yaml"));
    expect(parsed.scoring).toMatchObject({ jd_max_chars: 6000, jd_head_share: 0.7, concurrency: 3, language_penalty: { B2: 10, C1: 20, C2: 25 }, backlog_per_run: 40 });
    expect(parsed.scoring.priority.weights).toEqual({ title: 40, signals: 25, location: 15, seniority: 10, recency: 10, language_gap: 10 });
  });

  it("rejects an unusable backlog budget and priority block", () => {
    expect(paths((s) => { s.backlog_per_run = 0; })).toContain("scoring.backlog_per_run");
    expect(paths((s) => { delete s.priority; })).toContain("scoring.priority");
    const priority = (s: Record<string, unknown>) => s.priority as Record<string, Record<string, unknown> | unknown>;
    expect(paths((s) => { (priority(s).weights as Record<string, unknown>).title = -1; })).toContain("scoring.priority.weights.title");
    expect(paths((s) => { (priority(s).weights as Record<string, unknown>).typo = 1; })).toContain("scoring.priority.weights");
    expect(paths((s) => { (priority(s).seniority_fit as Record<string, unknown>).senior = 1.5; })).toContain("scoring.priority.seniority_fit.senior");
    expect(paths((s) => { delete (priority(s).seniority_fit as Record<string, unknown>).unknown; })).toContain("scoring.priority.seniority_fit.unknown");
    expect(paths((s) => { (priority(s) as Record<string, unknown>).recency_days = 0; })).toContain("scoring.priority.recency_days");
    expect(paths((s) => { (priority(s) as Record<string, unknown>).unclear_location_factor = 2; })).toContain("scoring.priority.unclear_location_factor");
  });

  it("is required", () => {
    const raw = structuredClone(shippedYaml("ai.yaml"));
    delete raw.scoring;
    expect(configRegistry.ai.schema.safeParse(raw).success).toBe(false);
  });

  it("rejects unusable values", () => {
    expect(paths((s) => { s.jd_max_chars = 100; })).toContain("scoring.jd_max_chars");
    expect(paths((s) => { s.jd_head_share = 1; })).toContain("scoring.jd_head_share");
    expect(paths((s) => { s.concurrency = 0; })).toContain("scoring.concurrency");
    expect(paths((s) => { s.concurrency = 50; })).toContain("scoring.concurrency");
    expect(paths((s) => { s.language_penalty = { B2: -1 }; })).toContain("scoring.language_penalty.B2");
    expect(paths((s) => { s.language_penalty = { D1: 5 }; })).toContain("scoring.language_penalty");
    expect(paths((s) => { s.typo = 1; })).toContain("scoring");
  });

  it("accepts an empty penalty table (no deductions)", () => {
    expect(paths((s) => { s.language_penalty = {}; })).toEqual([]);
  });
});
