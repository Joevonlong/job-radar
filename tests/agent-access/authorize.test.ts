// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { authorize, liveMcpSettings } from "@/lib/agent-access/authorize";
import { ConfigError, loadConfig } from "@/lib/config";
import { mcpSchema } from "@/lib/config/schemas/mcp";

import { makeTempConfig, type TempConfig } from "../config/helpers";

const capability = { id: "search_jobs", permission: "jobs:read" } as const;
let temp: TempConfig | null = null;
afterEach(() => {
  temp?.cleanup();
  temp = null;
});

describe("authorize", () => {
  it.each([
    [new ConfigError({ configName: "mcp", filePath: "/private/config/mcp.yaml", kind: "schema", issues: [{ path: "enabled", message: "invalid" }] }), "schema: enabled"],
    [new Error("cannot read /private/config/mcp.yaml"), "unreadable"],
  ])("fails closed on an unreadable setting without exposing a path", (error, problem) => {
    const decision = authorize(capability, () => { throw error; });
    expect(decision).toEqual({ allowed: false, reason: "unreadable", problem });
    expect(JSON.stringify(decision)).not.toContain("/private");
  });

  it("checks the server switch before permissions", () => {
    expect(authorize(capability, () => mcpSchema.parse({ permissions: [] }))).toEqual({ allowed: false, reason: "disabled" });
  });

  it.each([
    { permissions: [], stdio: { permissions: ["jobs:read"] } },
    { permissions: ["jobs:read"], stdio: { permissions: [] } },
  ])("requires the permission in both the global matrix and stdio grant: %j", (raw) => {
    expect(authorize(capability, () => mcpSchema.parse({ enabled: true, ...raw }))).toEqual({ allowed: false, reason: "missing_permission", permission: "jobs:read" });
  });

  it("returns exactly the settings just read and their effective permissions", () => {
    const settings = mcpSchema.parse({ enabled: true, limits: { max_results: 3 } });
    const decision = authorize(capability, () => settings);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error("expected access");
    expect(decision.settings).toBe(settings);
    expect([...decision.permissions]).toEqual(["jobs:read", "tracking:read"]);
  });
});

describe("liveMcpSettings", () => {
  it("rereads each file without retaining or updating the last valid cached settings", () => {
    temp = makeTempConfig();
    process.env.JOB_RADAR_CONFIG_POLL_MS = "0";
    const file = path.join(temp.configDir, "mcp.yaml");
    fs.writeFileSync(file, "enabled: true\n");
    const cached = loadConfig("mcp");
    expect(authorize(capability, liveMcpSettings).allowed).toBe(true);
    fs.writeFileSync(file, "enabled: [\n");
    expect(authorize(capability, liveMcpSettings)).toEqual({ allowed: false, reason: "unreadable", problem: "yaml" });
    expect(loadConfig("mcp")).toBe(cached);
    expect(cached.enabled).toBe(true);
    fs.writeFileSync(file, "enabled: false\n");
    expect(authorize(capability, liveMcpSettings)).toEqual({ allowed: false, reason: "disabled" });
    expect(loadConfig("mcp")).toBe(cached);
  });

  it.each([
    ["the global matrix lacks it", "permissions: [tracking:read]\nstdio:\n  permissions: [jobs:read, tracking:read]\n"],
    ["the stdio grant lacks it", "permissions: [jobs:read, tracking:read]\nstdio:\n  permissions: [tracking:read]\n"],
  ])("grants only the intersection of the file's two lists: refused when %s", (_case, lists) => {
    temp = makeTempConfig();
    const file = path.join(temp.configDir, "mcp.yaml");
    fs.writeFileSync(file, `config_version: 3\nenabled: true\n${lists}`);
    expect(authorize(capability, liveMcpSettings)).toEqual({ allowed: false, reason: "missing_permission", permission: "jobs:read" });
    const tracking = authorize({ id: "list_applications", permission: "tracking:read" }, liveMcpSettings);
    expect(tracking.allowed && [...tracking.permissions]).toEqual(["tracking:read"]);
  });

  it("uses disabled schema defaults when neither file exists", () => {
    temp = makeTempConfig({ user: "empty" });
    fs.rmSync(path.join(temp.defaultsDir, "mcp.yaml"));
    expect(liveMcpSettings()).toEqual(mcpSchema.parse({}));
    expect(authorize(capability, liveMcpSettings)).toEqual({ allowed: false, reason: "disabled" });
  });
});
