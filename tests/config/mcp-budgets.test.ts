// @vitest-environment node
import { describe, expect, it } from "vitest";

import { AGENT_ACTIONS, MCP_MAX_DAILY_CAP, mcpSchema } from "@/lib/config/schemas/mcp";

describe("MCP daily budget schema", () => {
  it("adds complete defaults to older configuration and partial budget objects", () => {
    const defaults = mcpSchema.parse({}).budgets;
    expect(Object.keys(defaults.per_caller)).toEqual([...AGENT_ACTIONS]);
    expect(mcpSchema.parse({ budgets: {} }).budgets).toEqual(defaults);
    expect(mcpSchema.parse({ budgets: { per_caller: { score_jobs: 3 } } }).budgets).toEqual({
      ...defaults, per_caller: { ...defaults.per_caller, score_jobs: 3 },
    });
  });

  it.each(AGENT_ACTIONS)("accepts zero and the daily ceiling for %s", (action) => {
    for (const value of [0, MCP_MAX_DAILY_CAP]) {
      expect(mcpSchema.parse({ budgets: { per_caller: { [action]: value }, total: value } }).budgets.total).toBe(value);
    }
  });

  it.each([-1, 1.5, MCP_MAX_DAILY_CAP + 1, "3"])("rejects invalid caps %s", (value) => {
    expect(mcpSchema.safeParse({ budgets: { total: value } }).success).toBe(false);
    for (const action of AGENT_ACTIONS) {
      expect(mcpSchema.safeParse({ budgets: { per_caller: { [action]: value } } }).success).toBe(false);
    }
  });

  it("has no retention of its own: counter rows follow the audit retention", () => {
    expect(mcpSchema.safeParse({ budgets: { retention_days: 90 } }).success).toBe(false);
  });

  it("gives every parse its own default objects", () => {
    const first = mcpSchema.parse({});
    first.budgets.per_caller.score_jobs = 1;
    first.budgets.total = 1;
    const partial = mcpSchema.parse({ budgets: { total: 5 } });
    partial.budgets.per_caller.translate_job = 1;
    const next = mcpSchema.parse({});
    expect(next.budgets.per_caller.score_jobs).toBe(100);
    expect(next.budgets.per_caller.translate_job).toBe(20);
    expect(next.budgets.total).toBe(150);
    expect(Object.isFrozen(next.budgets.per_caller)).toBe(false);
    expect(next.budgets.per_caller).not.toBe(mcpSchema.parse({}).budgets.per_caller);
  });

  it("rejects misspelled budget keys", () => {
    expect(mcpSchema.safeParse({ budgets: { unexpected: 1 } }).success).toBe(false);
    expect(mcpSchema.safeParse({ budgets: { per_caller: { unexpected: 1 } } }).success).toBe(false);
  });
});
