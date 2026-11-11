// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { mcpSchema } from "@/lib/config/schemas/mcp";
import { pruneAgentBudgetOnce } from "@/runner/agent-budget-prune";

function fixture() {
  return {
    now: () => new Date("2026-11-11T23:30:00Z"),
    readSettings: () => mcpSchema.parse({ audit: { retention_days: 2 } }),
    timeZone: () => "Europe/Berlin",
    prune: vi.fn<(beforeDay: string) => Promise<number>>().mockResolvedValue(3),
    log: vi.fn<(message: string) => void>(),
  };
}

describe("agent budget pruning", () => {
  it("uses the audit retention and the current local day and logs the count", async () => {
    const deps = fixture();
    await pruneAgentBudgetOnce(deps);
    expect(deps.prune).toHaveBeenCalledExactlyOnceWith("2026-11-10");
    expect(deps.log).toHaveBeenCalledExactlyOnceWith("pruned 3 agent budget rows");
  });

  it("uses a fresh retention setting on every run", async () => {
    const deps = fixture();
    await pruneAgentBudgetOnce(deps);
    deps.readSettings = () => mcpSchema.parse({ audit: { retention_days: 4 } });
    await pruneAgentBudgetOnce(deps);
    expect(deps.prune).toHaveBeenLastCalledWith("2026-11-08");
  });

  it("does not log when no rows are deleted", async () => {
    const deps = fixture();
    deps.prune.mockResolvedValue(0);
    await pruneAgentBudgetOnce(deps);
    expect(deps.log).not.toHaveBeenCalled();
  });

  it.each(["now", "readSettings", "timeZone", "prune"] as const)("swallows %s errors without exposing values", async (key) => {
    const deps = fixture();
    const failing = { ...deps, [key]: () => { throw new Error("private configuration or database value"); } };
    await expect(pruneAgentBudgetOnce(failing)).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalledExactlyOnceWith("agent budget prune failed");
  });
});
