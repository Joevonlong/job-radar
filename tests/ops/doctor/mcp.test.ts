// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { mcpSchema } from "@/lib/config/schemas/mcp";
import { activeAgentTokenStats } from "@/lib/db/repos/agent-tokens";
import { readMcpSettings } from "@/lib/mcp/settings";
import { mcpCheck } from "@/lib/ops/doctor/checks/data";
import { mcpVerdict } from "@/lib/ops/doctor/mcp-verdict";
import { createRealProbes } from "@/lib/ops/doctor/probes";

import { makeContext, only } from "./helpers";

vi.mock("@/lib/mcp/settings", () => ({ readMcpSettings: vi.fn() }));
vi.mock("@/lib/db/repos/agent-tokens", () => ({ activeAgentTokenStats: vi.fn(async () => { throw new Error("unavailable"); }) }));
vi.mock("@/lib/db", async (original) => ({ ...await original<object>(), getDb: () => ({}) }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe("data.mcp", () => {
  it("off (the default) is fine", async () => {
    const r = await only(mcpCheck, makeContext());
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("enabled: false");
  });
  it("on: names the effective permissions and global matrix and that the client's model provider receives the results", async () => {
    const r = await only(mcpCheck, makeContext({ locale: "en", probes: { mcp: async () => ({ state: "ok", enabled: true, httpEnabled: false, webPasswordUsable: false, activeTokens: null, nearestExpiry: null, auditRetentionDays: 17, permissions: ["jobs:read", "tracking:read"], effective: ["jobs:read"] }) } }));
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("permissions: jobs:read (allowed overall: jobs:read, tracking:read)");
    expect(r.detail).toContain("docs/mcp");
    expect(r.detail).toContain("Audit retention: 17 days");
    expect(r.detail).toContain("/settings/agents");
  });
  it("separates the guide pointer from the HTTP sentence", async () => {
    for (const [locale, guide] of [["en", "docs/mcp.md"], ["zh", "docs/mcp.zh.md"]] as const) {
      const r = await only(mcpCheck, makeContext({ locale, probes: { mcp: async () => ({ state: "ok", enabled: true, httpEnabled: true, webPasswordUsable: true, activeTokens: 2, nearestExpiry: null, auditRetentionDays: 17, permissions: ["jobs:read"], effective: ["jobs:read"] }) } }));
      expect(r.detail).toMatch(new RegExp(`${guide.replace(".", "\\.")}[.。] `));
    }
  });
  it("the agent access page's verdict is the doctor's", () => {
    const base = { state: "ok", enabled: true, httpEnabled: false, webPasswordUsable: false, activeTokens: null, nearestExpiry: null, auditRetentionDays: 1, permissions: [], effective: [] } as const;
    expect(mcpVerdict({ state: "config_error", problem: "x" })).toBe("config_error");
    expect(mcpVerdict({ ...base, enabled: false })).toBe("off");
    expect(mcpVerdict(base)).toBe("on");
    expect(mcpVerdict({ ...base, httpEnabled: true })).toBe("password_required");
    expect(mcpVerdict({ ...base, httpEnabled: true, webPasswordUsable: true })).toBe("on");
  });
  it("reports retention in Chinese with the Chinese guide", async () => {
    const r = await only(mcpCheck, makeContext({ locale: "zh", probes: { mcp: async () => ({ state: "ok", enabled: true, httpEnabled: false, webPasswordUsable: false, activeTokens: null, nearestExpiry: null, auditRetentionDays: 23, permissions: ["jobs:read"], effective: ["jobs:read"] }) } }));
    expect(r.detail).toContain("调用记录保留 23 天");
    expect(r.detail).toContain("docs/mcp.zh.md");
  });
  it("names an empty effective list as none", async () => {
    const r = await only(mcpCheck, makeContext({ locale: "en", probes: { mcp: async () => ({ state: "ok", enabled: true, httpEnabled: false, webPasswordUsable: false, activeTokens: null, nearestExpiry: null, auditRetentionDays: 17, permissions: ["jobs:read"], effective: [] }) } }));
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
    expect(await probes.mcp()).toEqual({ state: "ok", enabled: true, permissions: ["jobs:read", "tracking:read"], effective: ["tracking:read"], httpEnabled: false, webPasswordUsable: false, activeTokens: null, nearestExpiry: null, auditRetentionDays: 17 });
  });

  it("reports an unreadable file without its error message", async () => {
    vi.mocked(readMcpSettings).mockImplementation(() => { throw new Error("SENTINEL-private-config"); });
    expect(await probes.mcp()).toEqual({ state: "config_error", problem: "unreadable" });
  });
});


describe("HTTP doctor metadata", () => {
  const probes = createRealProbes({ commandTimeoutMs: 1, probeTimeoutMs: 1, now: () => new Date("2026-11-11T12:00:00Z"), migrationsDir: import.meta.dirname });

  it.each(["en", "zh"] as const)("warns about the unusable password in %s", async (locale) => {
    for (const hash of ["", "jrat_uniqueSentinelTokenNeverPrinted1234567890ab"]) {
      vi.stubEnv("JOB_RADAR_WEB_PASSWORD", "");
      vi.stubEnv("JOB_RADAR_WEB_PASSWORD_HASH", hash);
      vi.mocked(readMcpSettings).mockReturnValue(mcpSchema.parse({ enabled: true, http: { enabled: true } }));
      const probe = await probes.mcp();
      const result = await only(mcpCheck, makeContext({ locale, probes: { mcp: async () => probe } }));
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("503");
      expect(result.hint).toContain("pnpm web:password");
      expect(JSON.stringify([probe, result])).not.toContain("jrat_");
    }
  });

  it("reports aggregate active tokens and their nearest expiry without credentials", async () => {
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD_HASH", "");
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD", "test-password");
    const expiry = new Date("2027-01-01T00:00:00Z");
    vi.mocked(activeAgentTokenStats).mockResolvedValueOnce({ activeTokens: 3, nearestExpiry: expiry });
    vi.mocked(readMcpSettings).mockReturnValue(mcpSchema.parse({ enabled: true, http: { enabled: true } }));
    const probe = await probes.mcp();
    expect(probe).toMatchObject({ httpEnabled: true, webPasswordUsable: true, activeTokens: 3, nearestExpiry: expiry });
    const result = await only(mcpCheck, makeContext({ probes: { mcp: async () => probe } }));
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("3");
    expect(result.detail).toContain(expiry.toISOString());
  });

  it("keeps database failures unknown without failing the check or leaking the error", async () => {
    vi.mocked(activeAgentTokenStats).mockRejectedValueOnce(new Error("jrat_uniqueSentinelTokenNeverPrinted1234567890ab"));
    vi.mocked(readMcpSettings).mockReturnValue(mcpSchema.parse({ enabled: true }));
    const probe = await probes.mcp();
    expect(probe).toMatchObject({ activeTokens: null, nearestExpiry: null });
    expect((await only(mcpCheck, makeContext({ probes: { mcp: async () => probe } }))).status).toBe("ok");
    expect(JSON.stringify(probe)).not.toContain("jrat_");
  });
});
