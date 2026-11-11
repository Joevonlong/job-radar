// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { mcpSchema } from "@/lib/config/schemas/mcp";
import { pruneAgentCallsOnce } from "@/runner/agent-calls-prune";

function fixture() {
  const settings = mcpSchema.parse({ enabled: false, audit: { retention_days: 2 } });
  return { now: () => new Date("2026-10-20T12:00:00Z"), readSettings: vi.fn(() => settings), prune: vi.fn(async () => 3), log: vi.fn() };
}

describe("agent calls pruning", () => {
  it("uses the configured age even with MCP off and reports a nonempty prune", async () => {
    const deps = fixture();
    await pruneAgentCallsOnce(deps);
    expect(deps.prune).toHaveBeenCalledExactlyOnceWith(new Date("2026-10-18T12:00:00Z"));
    expect(deps.log).toHaveBeenCalledExactlyOnceWith("pruned 3 agent calls");
  });
  it("reads settings afresh and stays quiet when nothing was deleted", async () => {
    const deps = fixture();
    deps.prune.mockResolvedValue(0);
    await pruneAgentCallsOnce(deps);
    deps.readSettings.mockReturnValue(mcpSchema.parse({ audit: { retention_days: 1 } }));
    await pruneAgentCallsOnce(deps);
    expect(deps.prune).toHaveBeenLastCalledWith(new Date("2026-10-19T12:00:00Z"));
    expect(deps.log).not.toHaveBeenCalled();
  });
  it("skips an unreadable configuration with one operation-only line", async () => {
    const deps = fixture();
    deps.readSettings.mockImplementation(() => { throw new Error("SENTINEL-private-config"); });
    await pruneAgentCallsOnce(deps);
    expect(deps.prune).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledExactlyOnceWith("agent calls prune settings unreadable");
  });
  it("contains a failed deletion with one operation-only line", async () => {
    const deps = fixture();
    deps.prune.mockRejectedValue(new Error("SENTINEL-private-database"));
    await expect(pruneAgentCallsOnce(deps)).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalledExactlyOnceWith("agent calls prune failed");
  });
});
