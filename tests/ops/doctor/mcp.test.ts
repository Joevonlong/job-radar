// @vitest-environment node
import { describe, expect, it } from "vitest";

import { mcpCheck } from "@/lib/ops/doctor/checks/data";

import { makeContext, only } from "./helpers";

describe("data.mcp", () => {
  it("off (the default) is fine", async () => {
    const r = await only(mcpCheck, makeContext());
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("enabled: false");
  });
  it("on: names the effective permissions and global matrix and that the client's model provider receives the results", async () => {
    const r = await only(mcpCheck, makeContext({ locale: "en", probes: { mcp: async () => ({ state: "ok", enabled: true, permissions: ["jobs:read", "tracking:read"], effective: ["jobs:read"] }) } }));
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("permissions: jobs:read (allowed overall: jobs:read, tracking:read)");
    expect(r.detail).toContain("docs/mcp");
  });
  it("names an empty effective list as none", async () => {
    const r = await only(mcpCheck, makeContext({ locale: "en", probes: { mcp: async () => ({ state: "ok", enabled: true, permissions: ["jobs:read"], effective: [] }) } }));
    expect(r.detail).toContain("permissions: none (allowed overall: jobs:read)");
  });
  it("warns when mcp.yaml cannot be read", async () => {
    const r = await only(mcpCheck, makeContext({ locale: "en", probes: { mcp: async () => ({ state: "config_error", problem: "limits.max_results: Too big" }) } }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("limits.max_results");
    expect(r.hint).toContain("pnpm config:check");
  });
});
