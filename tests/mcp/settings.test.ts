// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, loadConfig, resetConfigCache } from "@/lib/config";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import { configProblem, readMcpSettings } from "@/lib/mcp/settings";

import { makeTempConfig, type TempConfig } from "../config/helpers";

let temp: TempConfig | null = null;
afterEach(() => {
  temp?.cleanup();
  temp = null;
});

describe("mcp.yaml schema", () => {
  it("defaults to off, the read tools on, the writer tools off, 20 results and 12000 JD characters", () => {
    expect(mcpSchema.parse({})).toEqual({
      enabled: false,
      permissions: ["jobs:read", "tracking:read"],
      stdio: { permissions: ["jobs:read", "tracking:read"] },
      limits: { max_results: 20, max_description_chars: 12_000 },
    });
  });
  it("defaults the stdio grant and limits independently of the global matrix", () => {
    const parsed = mcpSchema.parse({ enabled: true, permissions: ["writer:read"], stdio: {}, limits: { max_results: 5 } });
    expect(parsed.permissions).toEqual(["writer:read"]);
    expect(parsed.stdio.permissions).toEqual(["jobs:read", "tracking:read"]);
    expect(parsed.limits).toEqual({ max_results: 5, max_description_chars: 12_000 });
  });
  it.each(["permissions", "stdio"])("reports an unknown permission at its array path in %s", (key) => {
    const result = mcpSchema.safeParse(key === "permissions" ? { permissions: ["unknown:read"] } : { stdio: { permissions: ["unknown:read"] } });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected invalid permission");
    expect(result.error.issues[0]?.path).toEqual(key === "permissions" ? ["permissions", 0] : ["stdio", "permissions", 0]);
  });
  it.each([
    ["max_results 0", { limits: { max_results: 0 } }],
    ["max_results above the cap", { limits: { max_results: 101 } }],
    ["max_results not an integer", { limits: { max_results: 2.5 } }],
    ["max_description_chars below 500", { limits: { max_description_chars: 499 } }],
    ["max_description_chars above the cap", { limits: { max_description_chars: 100_001 } }],
    ["the removed tools key", { tools: { search_jobs: true } }],
    ["an unknown key (no transport / http / include)", { transport: "http" }],
    ["enabled not a boolean", { enabled: "yes" }],
  ])("rejects %s", (_name, raw) => {
    expect(mcpSchema.safeParse(raw).success).toBe(false);
  });
});

describe("readMcpSettings", () => {
  it("reads the defaults layer when there is no user copy", () => {
    temp = makeTempConfig({ user: "empty" });
    expect(readMcpSettings().enabled).toBe(false);
  });
  it("reads the user copy over the defaults", () => {
    temp = makeTempConfig();
    fs.writeFileSync(path.join(temp.configDir, "mcp.yaml"), "config_version: 3\nenabled: true\npermissions: [jobs:read]\n");
    resetConfigCache();
    const settings = readMcpSettings();
    expect(settings.enabled).toBe(true);
    expect(settings.permissions).toEqual(["jobs:read"]);
  });
  it("means the schema defaults when the file is missing from both layers", () => {
    const missing = () => {
      throw new ConfigError({ configName: "mcp", filePath: "/x/mcp.yaml", kind: "missing" });
    };
    expect(readMcpSettings(missing)).toEqual(mcpSchema.parse({}));
  });
  it("throws on a broken file (never silently on or off)", () => {
    temp = makeTempConfig();
    fs.writeFileSync(path.join(temp.configDir, "mcp.yaml"), "config_version: 1\nenabled: maybe\n");
    resetConfigCache();
    expect(() => readMcpSettings(() => loadConfig("mcp"))).toThrow(ConfigError);
  });
});

describe("configProblem", () => {
  it("names the kind and the field paths, never the file path", () => {
    const error = new ConfigError({ configName: "mcp", filePath: "/Users/someone/job-radar/data/config/mcp.yaml", kind: "schema", issues: [{ path: "limits.max_results", message: "Too big" }] });
    const problem = configProblem(error);
    expect(problem).toBe("schema: limits.max_results");
    expect(problem).not.toContain("/Users");
  });
  it("says unreadable for anything else", () => {
    expect(configProblem(new Error("connect ECONNREFUSED 127.0.0.1:5433"))).toBe("unreadable");
  });
});
