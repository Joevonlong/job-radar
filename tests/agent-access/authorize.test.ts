// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { authorize, authorizeCall, liveMcpSettings, STDIO_GRANT, type Grant } from "@/lib/agent-access/authorize";
import type { Permission } from "@/lib/agent-access/permissions";
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

describe("a token grant", () => {
  const matrix = mcpSchema.parse({ enabled: true, permissions: ["jobs:read", "tracking:read", "notes:read"], stdio: { permissions: ["jobs:read"] } });
  const token = (permissions: Permission[]): Grant => ({ kind: "token", tokenId: 5, permissions });
  const tracking = { id: "list_applications", permission: "tracking:read" } as const;

  it("takes its own list instead of the stdio grant, intersected with the global matrix", () => {
    const decision = authorize(tracking, () => matrix, token(["tracking:read", "notes:read", "config:write"]));
    expect(decision.allowed && [...decision.permissions]).toEqual(["tracking:read", "notes:read"]);
    expect(authorize(capability, () => matrix, token(["tracking:read"]))).toEqual({ allowed: false, reason: "missing_permission", permission: "jobs:read" });
    expect(authorize(tracking, () => matrix, STDIO_GRANT)).toEqual({ allowed: false, reason: "missing_permission", permission: "tracking:read" });
  });

  it("is refused when the matrix lacks the permission, and judged by the matrix as it is at the call", () => {
    let current = matrix;
    const grant = token(["config:write", "tracking:read"]);
    expect(authorize({ id: "set_config", permission: "config:write" }, () => current, grant)).toEqual({ allowed: false, reason: "missing_permission", permission: "config:write" });
    expect(authorize(tracking, () => current, grant).allowed).toBe(true);
    current = mcpSchema.parse({ enabled: true, permissions: ["jobs:read"] });
    expect(authorize(tracking, () => current, grant)).toEqual({ allowed: false, reason: "missing_permission", permission: "tracking:read" });
  });

  it("still needs the server switched on and mcp.yaml readable", () => {
    expect(authorize(tracking, () => mcpSchema.parse({ permissions: ["tracking:read"] }), token(["tracking:read"]))).toEqual({ allowed: false, reason: "disabled" });
    expect(authorize(tracking, () => { throw new Error("x"); }, token(["tracking:read"]))).toMatchObject({ allowed: false, reason: "unreadable" });
  });
});

describe("authorizeCall", () => {
  const settings = mcpSchema.parse({ enabled: true, permissions: ["jobs:read", "tracking:read"], stdio: { permissions: ["jobs:read"] } });
  const grant: Grant = { kind: "token", tokenId: 5, permissions: ["jobs:read", "tracking:read"] };

  it("decides a stdio call as authorize does, without a token read", async () => {
    const readGrant = vi.fn();
    await expect(authorizeCall(capability, () => settings, STDIO_GRANT, readGrant)).resolves.toMatchObject({ allowed: true });
    await expect(authorizeCall(capability, () => settings)).resolves.toMatchObject({ allowed: true });
    expect(readGrant).not.toHaveBeenCalled();
  });

  it("reads the token again and judges the call by its current list", async () => {
    const readGrant = vi.fn(async (): Promise<Grant> => ({ kind: "token", tokenId: 5, permissions: ["tracking:read"] }));
    await expect(authorizeCall(capability, () => settings, grant, readGrant)).resolves.toEqual({ allowed: false, reason: "missing_permission", permission: "jobs:read" });
    expect(readGrant).toHaveBeenCalledWith(5);
  });

  it.each([
    ["the token is revoked, expired or gone", async () => null],
    ["the read answers for another token", async (): Promise<Grant> => ({ ...grant, tokenId: 6 })],
    ["the read answers with the stdio grant", async (): Promise<Grant> => STDIO_GRANT],
  ])("refuses when %s", async (_case, readGrant) => {
    await expect(authorizeCall(capability, () => settings, grant, readGrant)).resolves.toEqual({ allowed: false, reason: "token_inactive" });
  });

  it("refuses a token grant that has no reader", async () => {
    await expect(authorizeCall(capability, () => settings, grant)).resolves.toEqual({ allowed: false, reason: "token_inactive" });
  });

  it("lets a failing token read fail the call", async () => {
    const failure = new Error("database down");
    await expect(authorizeCall(capability, () => settings, grant, async () => { throw failure; })).rejects.toBe(failure);
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
