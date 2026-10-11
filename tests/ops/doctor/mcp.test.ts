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
  it("on: names the tools and that the client's model provider receives the results", async () => {
    const r = await only(mcpCheck, makeContext({ probes: { mcp: async () => ({ state: "ok", enabled: true, tools: ["search_jobs", "get_job"] }) } }));
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("search_jobs, get_job");
    expect(r.detail).toContain("docs/mcp");
  });
  it("warns when mcp.yaml cannot be read", async () => {
    const r = await only(mcpCheck, makeContext({ probes: { mcp: async () => ({ state: "config_error", problem: "limits.max_results: Too big" }) } }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("limits.max_results");
    expect(r.hint).toContain("pnpm config:check");
  });
});
