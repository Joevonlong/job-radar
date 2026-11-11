// @vitest-environment node
import { describe, expect, it } from "vitest";

import { agentBudgetWindow, checkAgentBudget } from "@/lib/agent-access/budget";

describe("local budget day", () => {
  it("uses the schedule zone at the UTC day boundary", () => {
    expect(agentBudgetWindow(new Date("2026-11-11T23:30:00Z"), "Europe/Berlin")).toEqual({
      day: "2026-11-12", resetsAt: new Date("2026-11-12T23:00:00Z"),
    });
  });

  it.each([
    ["2026-10-25T00:30:00Z", "2026-10-25", "2026-10-25T23:00:00Z"],
    ["2026-03-29T00:30:00Z", "2026-03-29", "2026-03-29T22:00:00Z"],
  ])("resets at local midnight on a DST change day %s", (instant, day, reset) => {
    expect(agentBudgetWindow(new Date(instant), "Europe/Berlin")).toEqual({ day, resetsAt: new Date(reset) });
  });
});

describe("budget prechecks", () => {
  const input = { action: "score_jobs", cap: 100, totalCap: 150, used: 60, totalUsed: 1, resetsAt: new Date("2026-11-11T23:00:00Z") } as const;

  it("refuses an action disabled for agents with its current usage", () => {
    expect(checkAgentBudget({ ...input, cap: 0 })).toEqual({
      reason: "not_allowed", action: "score_jobs", cap: 0, used: 60, remaining: 0, requested: 1, resetsAt: input.resetsAt,
    });
  });

  it("refuses a disabled total with total usage", () => {
    expect(checkAgentBudget({ ...input, totalCap: 0 })).toMatchObject({ reason: "not_allowed", cap: 0, used: 1, remaining: 0 });
  });

  it("refuses an oversized batch with the remaining job allowance", () => {
    expect(checkAgentBudget({ ...input, units: 101 })).toEqual({
      reason: "caller_cap", action: "score_jobs", cap: 100, used: 60, remaining: 40, requested: 101, resetsAt: input.resetsAt,
    });
  });

  it("leaves atomic usage checks to the repository", () => {
    expect(checkAgentBudget({ ...input, units: 50 })).toBeNull();
    expect(checkAgentBudget(input)).toBeNull();
  });

  it.each([0, 1.5, -1, NaN, Infinity])("throws RangeError for invalid units %s", (units) => {
    expect(() => checkAgentBudget({ ...input, units })).toThrow(RangeError);
  });
});
