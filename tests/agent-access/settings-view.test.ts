// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadAgentAccessView, mcpAddress, toolsByPermission } from "@/lib/agent-access/settings-view";
import { CAPABILITIES } from "@/lib/capabilities/registry";
import { activeAgentTokenGrants } from "@/lib/db/repos/agent-tokens";

import { makeTempConfig } from "../config/helpers";

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/db/repos/agent-calls", () => ({ latestAgentCallAt: vi.fn(async () => null) }));
vi.mock("@/lib/db/repos/agent-tokens", () => ({
  activeAgentTokenGrants: vi.fn(async () => [{ permissions: ["jobs:read"] }, { permissions: ["tracking:read", "not-a-permission"] }]),
  activeAgentTokenStats: vi.fn(async () => ({ activeTokens: 2, nearestExpiry: null })),
}));

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
      const view = await loadAgentAccessView("no_password");
      expect(view.config.ok).toBe(false);
      expect(view.status.verdict).toBe("config_error");
      expect(view.status.activeTokens).toBe(2);
      expect(view.tokenGrants).toEqual([["jobs:read"], ["tracking:read"]]);
    } finally {
      tmp.cleanup();
    }
  });

  it("the token count is unknown only when the database cannot be read", async () => {
    vi.mocked(activeAgentTokenGrants).mockRejectedValueOnce(new Error("down"));
    const view = await loadAgentAccessView("no_password");
    expect(view.status.activeTokens).toBeNull();
    expect(view.tokenGrants).toBeNull();
  });
});
