// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadAgentAccessView, mcpAddress, toolsByPermission } from "@/lib/agent-access/settings-view";
import { CAPABILITIES } from "@/lib/capabilities/registry";
import { listAgentTokens, type AgentTokenSummary } from "@/lib/db/repos/agent-tokens";

import { makeTempConfig } from "../config/helpers";

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/db/repos/agent-calls", () => ({ latestAgentCallAt: vi.fn(async () => null) }));
const NOW = new Date("2026-11-12T12:00:00Z");
const tokens = vi.hoisted(() => {
  const base = { autoApprove: false, createdAt: new Date("2026-11-01T00:00:00Z"), lastUsedAt: null, expiresAt: null, revokedAt: null };
  return [
    { ...base, id: 1, name: "laptop", tokenPrefix: "jrat_AAAAAAAA", permissions: ["jobs:read"] },
    { ...base, id: 2, name: "tablet", tokenPrefix: "jrat_BBBBBBBB", permissions: ["tracking:read", "not-a-permission"], lastUsedAt: new Date("2026-11-12T11:00:00Z") },
    { ...base, id: 3, name: "old", tokenPrefix: "jrat_CCCCCCCC", permissions: ["jobs:read"], revokedAt: new Date("2026-11-05T00:00:00Z") },
    { ...base, id: 4, name: "trial", tokenPrefix: "jrat_DDDDDDDD", permissions: ["ops:read"], expiresAt: new Date("2026-11-12T12:00:00Z") },
  ];
});
vi.mock("@/lib/db/repos/agent-tokens", () => ({ listAgentTokens: vi.fn(async () => tokens) }));

describe("toolsByPermission", () => {
  it("counts the tools of the registry, and a capability added to it is counted under its permission", () => {
    const before = toolsByPermission();
    const total = Object.values(before).reduce((sum, ids) => sum + ids.length, 0);
    expect(total).toBe(CAPABILITIES.length);
    const after = toolsByPermission([...CAPABILITIES, { id: "test_only_capability", permission: "ops:read" }]);
    expect(after["ops:read"]).toEqual([...before["ops:read"], "test_only_capability"]);
    expect(after["jobs:read"]).toEqual(before["jobs:read"]);
  });
});

describe("mcpAddress", () => {
  it("uses the scheme and host the request reached the page with", () => {
    expect(mcpAddress(new Headers({ host: "127.0.0.1:3000" }))).toBe("http://127.0.0.1:3000/api/mcp");
    expect(mcpAddress(new Headers({ host: "web:3000", "x-forwarded-host": "box.example-tailnet.ts.net", "x-forwarded-proto": "https" }))).toBe("https://box.example-tailnet.ts.net/api/mcp");
  });
});

describe("loadAgentAccessView", () => {
  it("an unreadable mcp.yaml is reported, and the tokens still come from the database", async () => {
    const tmp = makeTempConfig();
    try {
      fs.writeFileSync(path.join(tmp.configDir, "mcp.yaml"), "permissions: [unterminated\n");
      const view = await loadAgentAccessView("no_password", NOW);
      expect(view.config.ok).toBe(false);
      expect(view.status.verdict).toBe("config_error");
      expect(view.status.activeTokens).toBe(2);
      expect(view.tokenGrants).toEqual([["jobs:read"], ["tracking:read"]]);
      expect(view.tokens?.map((token) => [token.name, token.state])).toEqual([["laptop", "active"], ["tablet", "active"], ["old", "revoked"], ["trial", "expired"]]);
    } finally {
      tmp.cleanup();
    }
  });

  it("the token count is unknown only when the database cannot be read", async () => {
    vi.mocked(listAgentTokens).mockRejectedValueOnce(new Error("down"));
    const view = await loadAgentAccessView("no_password", NOW);
    expect(view.status.activeTokens).toBeNull();
    expect(view.tokenGrants).toBeNull();
    expect(view.tokens).toBeNull();
  });

  it("shows token metadata only: no hash ever reaches the page", async () => {
    vi.mocked(listAgentTokens).mockResolvedValueOnce([{ ...tokens[0]!, tokenHash: "f".repeat(64) } as unknown as AgentTokenSummary]);
    const view = await loadAgentAccessView("no_password", NOW);
    expect(Object.keys(view.tokens![0]!).sort()).toEqual(["createdAt", "expiresAt", "id", "lastUsedAt", "name", "permissions", "prefix", "revokedAt", "state"]);
    expect(JSON.stringify(view)).not.toContain("f".repeat(64));
  });
});
