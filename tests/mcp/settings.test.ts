// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, loadConfig, resetConfigCache } from "@/lib/config";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import { configProblem, enabledTools, readMcpSettings } from "@/lib/mcp/settings";

import { makeTempConfig, type TempConfig } from "../config/helpers";

let temp: TempConfig | null = null;
afterEach(() => {
  temp?.cleanup();
  temp = null;
});

describe("mcp.yaml schema", () => {
  it("defaults to off, every tool on, 20 results and 12000 JD characters", () => {
    expect(mcpSchema.parse({})).toEqual({ enabled: false, tools: { search_jobs: true, get_job: true, list_applications: true }, limits: { max_results: 20, max_description_chars: 12_000 } });
  });
  it("fills a partial tools / limits block with defaults", () => {
    const parsed = mcpSchema.parse({ enabled: true, tools: { get_job: false }, limits: { max_results: 5 } });
    expect(parsed.tools).toEqual({ search_jobs: true, get_job: false, list_applications: true });
    expect(parsed.limits).toEqual({ max_results: 5, max_description_chars: 12_000 });
    expect(enabledTools(parsed)).toEqual(["search_jobs", "list_applications"]);
  });
  it.each([
    ["max_results 0", { limits: { max_results: 0 } }],
    ["max_results above the cap", { limits: { max_results: 101 } }],
    ["max_results not an integer", { limits: { max_results: 2.5 } }],
    ["max_description_chars below 500", { limits: { max_description_chars: 499 } }],
    ["max_description_chars above the cap", { limits: { max_description_chars: 100_001 } }],
    ["an unknown tool", { tools: { delete_job: true } }],
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
    fs.writeFileSync(path.join(temp.configDir, "mcp.yaml"), "config_version: 1\nenabled: true\ntools:\n  list_applications: false\n");
    resetConfigCache();
    const settings = readMcpSettings();
    expect(settings.enabled).toBe(true);
    expect(enabledTools(settings)).toEqual(["search_jobs", "get_job"]);
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
