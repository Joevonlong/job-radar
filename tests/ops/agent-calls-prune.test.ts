// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { liveMcpSettings } from "@/lib/agent-access/authorize";
import { loadConfig } from "@/lib/config";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import { pruneAgentCallsOnce } from "@/runner/agent-calls-prune";

import { makeTempConfig, type TempConfig } from "../config/helpers";

const ROOT = path.resolve(import.meta.dirname, "../..");
let temp: TempConfig | null = null;
afterEach(() => {
  temp?.cleanup();
  temp = null;
});

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

describe("agent calls pruning in the runner", () => {
  it("runs in the runner's periodic prune block with mcp.yaml read fresh and the runner's database", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/runner/index.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const from = source.indexOf("pruneHeartbeats: async () => {");
    expect(from).toBeGreaterThanOrEqual(0);
    const block = source.slice(from, source.indexOf("reportConfig:", from));
    expect(block).toMatch(/if \(Date\.now\(\) - lastPruneAt >= PRUNE_EVERY_MS\) \{[\s\S]*await pruneAgentCallsOnce\(\{/);
    expect(block).toContain("readSettings: liveMcpSettings");
    expect(block).toContain("prune: (olderThan) => pruneAgentCalls(db, olderThan)");
  });

  it("follows edits of mcp.yaml before the config cache refreshes and skips a broken file", async () => {
    temp = makeTempConfig();
    process.env.JOB_RADAR_CONFIG_POLL_MS = "0";
    const file = path.join(temp.configDir, "mcp.yaml");
    const deps = { now: () => new Date("2026-10-20T12:00:00Z"), readSettings: liveMcpSettings, prune: vi.fn(async () => 0), log: vi.fn() };
    fs.writeFileSync(file, "config_version: 3\naudit:\n  retention_days: 1\n");
    expect(loadConfig("mcp").audit.retention_days).toBe(1);
    await pruneAgentCallsOnce(deps);
    fs.writeFileSync(file, "config_version: 3\naudit:\n  retention_days: 90\n");
    await pruneAgentCallsOnce(deps);
    expect(loadConfig("mcp").audit.retention_days).toBe(1);
    expect(deps.prune.mock.calls).toEqual([[new Date("2026-10-19T12:00:00Z")], [new Date("2026-07-22T12:00:00Z")]]);
    fs.writeFileSync(file, "audit: [\n");
    await pruneAgentCallsOnce(deps);
    expect(deps.prune).toHaveBeenCalledTimes(2);
    expect(deps.log).toHaveBeenCalledExactlyOnceWith("agent calls prune settings unreadable");
  });
});

