// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { mcpSchema } from "@/lib/config/schemas/mcp";
import { readMcpSettings } from "@/lib/mcp/settings";
import { mcpCheck } from "@/lib/ops/doctor/checks/data";
import { createRealProbes } from "@/lib/ops/doctor/probes";

import { makeContext, only } from "./helpers";

vi.mock("@/lib/mcp/settings", () => ({ readMcpSettings: vi.fn() }));
afterEach(() => vi.clearAllMocks());

describe("data.mcp", () => {
  it("off (the default) is fine", async () => {
    const r = await only(mcpCheck, makeContext());
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("enabled: false");
  });
  it("on: names the effective permissions and global matrix and that the client's model provider receives the results", async () => {
    const r = await only(mcpCheck, makeContext({ locale: "en", probes: { mcp: async () => ({ state: "ok", enabled: true, auditRetentionDays: 17, permissions: ["jobs:read", "tracking:read"], effective: ["jobs:read"] }) } }));
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("permissions: jobs:read (allowed overall: jobs:read, tracking:read)");
    expect(r.detail).toContain("docs/mcp");
    expect(r.detail).toContain("Audit retention: 17 days");
  });
  it("reports retention in Chinese with the Chinese guide", async () => {
    const r = await only(mcpCheck, makeContext({ locale: "zh", probes: { mcp: async () => ({ state: "ok", enabled: true, auditRetentionDays: 23, permissions: ["jobs:read"], effective: ["jobs:read"] }) } }));
    expect(r.detail).toContain("调用记录保留 23 天");
    expect(r.detail).toContain("docs/mcp.zh.md");
  });
  it("names an empty effective list as none", async () => {
    const r = await only(mcpCheck, makeContext({ locale: "en", probes: { mcp: async () => ({ state: "ok", enabled: true, auditRetentionDays: 17, permissions: ["jobs:read"], effective: [] }) } }));
    expect(r.detail).toContain("permissions: none (allowed overall: jobs:read)");
  });
  it("warns when mcp.yaml cannot be read", async () => {
    const r = await only(mcpCheck, makeContext({ locale: "en", probes: { mcp: async () => ({ state: "config_error", problem: "limits.max_results: Too big" }) } }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("limits.max_results");
    expect(r.hint).toContain("pnpm config:check");
  });
});

describe("MCP settings probe", () => {
  const probes = createRealProbes({ commandTimeoutMs: 1, probeTimeoutMs: 1, now: () => new Date(), migrationsDir: import.meta.dirname });

  it("reads configured retention alongside the effective permission intersection", async () => {
    vi.mocked(readMcpSettings).mockReturnValue(mcpSchema.parse({ enabled: true, permissions: ["jobs:read", "tracking:read"], stdio: { permissions: ["tracking:read"] }, audit: { retention_days: 17 } }));
    expect(await probes.mcp()).toEqual({ state: "ok", enabled: true, permissions: ["jobs:read", "tracking:read"], effective: ["tracking:read"], auditRetentionDays: 17 });
  });

  it("reports an unreadable file without its error message", async () => {
    vi.mocked(readMcpSettings).mockImplementation(() => { throw new Error("SENTINEL-private-config"); });
    expect(await probes.mcp()).toEqual({ state: "config_error", problem: "unreadable" });
  });
});
