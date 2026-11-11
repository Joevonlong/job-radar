// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { authorize, liveMcpSettings } from "@/lib/agent-access/authorize";
import { DEFAULT_PERMISSIONS, effectivePermissions, PERMISSIONS, type Permission } from "@/lib/agent-access/permissions";
import { CAPABILITIES } from "@/lib/capabilities/registry";
import { applyConfigMigrations, ConfigError, parseConfigText, planConfigMigrations, writeConfig } from "@/lib/config";
import { parseConfigDocument } from "@/lib/config/load";
import { migrateConfigDocument } from "@/lib/config/migrations/version";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import { readMcpSettings } from "@/lib/mcp/settings";

import { makeTempConfig, type TempConfig } from "./helpers";
import { runConfigScript } from "./run-script";

const defaults = { search_jobs: true, get_job: true, list_applications: true, get_application_context: false, save_application_answer: false };
type OldTool = keyof typeof defaults;
const names = Object.keys(defaults) as OldTool[];
const notice = (off: string) => `search_jobs and get_job now share the permission jobs:read: ${off} was off and is offered again; remove jobs:read from permissions to switch both off`;
const invalidBodies = ["tools: {typo: true}\n", "tools: {get_job: yes}\n", "tools: []\n", "tools: {search_jobs: false, list_applications: 1}\n"];
const nullBodies = ["tools:\n", "tools: null\n", "tools:\n  list_applications:\n", "tools:\n  search_jobs: false\n  get_job: false\n  list_applications: null\n"];
const formats = [
  { name: "overlay", prefix: "config_version: 2\n", version: 3 },
  { name: "unstamped whole file", prefix: "", version: 1 },
  { name: "versioned whole file", prefix: "config_version: 1\n", version: 1 },
];
let temp: TempConfig | undefined;
afterEach(() => { temp?.cleanup(); temp = undefined; });

function expectedPermissions(tools: typeof defaults): Permission[] {
  const allowed: Permission[] = [];
  if (tools.search_jobs || tools.get_job) allowed.push("jobs:read");
  if (tools.list_applications) allowed.push("tracking:read");
  if (tools.get_application_context) allowed.push("writer:read");
  if (tools.save_application_answer) allowed.push("writer:write");
  return allowed;
}

function verify(text: string, tools: typeof defaults, version: number) {
  const doc = parseConfigDocument("mcp", text, "mcp.yaml");
  const result = migrateConfigDocument("mcp", doc, "mcp.yaml");
  const value = parseConfigText("mcp", doc.toString(), "mcp.yaml");
  const expected = expectedPermissions(tools);
  expect(result.to).toBe(version);
  expect(value.permissions).toEqual(expected);
  expect(value.stdio.permissions).toEqual(expected);
  const effective = effectivePermissions(value.stdio.permissions, value.permissions);
  expect(value.permissions).not.toContain("profile:read");
  expect(value.stdio.permissions).not.toContain("profile:read");
  expect(effective.has("profile:read")).toBe(false);
  for (const name of names) {
    const capability = CAPABILITIES.find((entry) => entry.id === name)!;
    const old = tools[name];
    const expanded = capability.permission === "jobs:read" && tools.search_jobs !== tools.get_job;
    expect(effective.has(capability.permission)).toBe(expanded || old);
  }
  expect(result.notices).toEqual(tools.search_jobs === tools.get_job ? [] : [notice(tools.search_jobs ? "get_job" : "search_jobs")]);
  const after = doc.toString();
  const again = migrateConfigDocument("mcp", doc, "mcp.yaml");
  expect(again.applied).toEqual([]);
  expect(again.notices).toEqual([]);
  expect(doc.toString()).toBe(after);
  return { doc, result, value };
}

describe.each(formats)("permissions migration: $name", ({ prefix, version }) => {
  it.each(Array.from({ length: 32 }, (_, mask) => ({ mask, tools: Object.fromEntries(names.map((name, bit) => [name, Boolean(mask & (1 << bit))])) as typeof defaults })))
    ("preserves every capability for switch combination $mask, except the documented shared permission", ({ tools }) => {
      verify(prefix + stringify({ enabled: true, tools }), tools, version);
    });

  it.each(["", "enabled: true\n"])("leaves absent tools unchanged, with defaults and no notice: %s", (body) => {
    const { doc, result, value } = verify(prefix + body || "{}\n", defaults, version);
    expect(value.enabled).toBe(body.startsWith("enabled:"));
    expect(doc.has("permissions")).toBe(false);
    expect(doc.has("stdio")).toBe(false);
    expect(result.applied).toHaveLength(version === 3 ? 1 : 0);
  });

  it.each([
    { search_jobs: false }, { get_job: false }, { list_applications: false },
    { search_jobs: false, get_job: false }, { get_application_context: true },
    { save_application_answer: true }, { get_application_context: true, save_application_answer: true },
    { search_jobs: false, get_job: false, list_applications: false, get_application_context: true, save_application_answer: true },
  ])("defaults omitted switches independently of the shipped file: %j", (tools) => {
    verify(prefix + stringify({ tools }), { ...defaults, ...tools }, version);
  });

  it("migrates boolean aliases and keeps references to removed anchors valid", () => {
    const { doc } = verify(prefix + "tools:\n  search_jobs: &on true\n  get_job: *on\n  get_application_context: &off false\n  save_application_answer: *off\nenabled: *on # keep enabled\n", defaults, version);
    expect(doc.toString()).toContain("enabled: true # keep enabled");
    expect(parseConfigText("mcp", doc.toString()).enabled).toBe(true);
  });

  const unsetBodies = [
    { body: "tools:\n  search_jobs: !unset\n  get_job: false\n", tools: { ...defaults, get_job: false } },
    { body: "tools:\n  get_application_context: !unset\n", tools: defaults },
    { body: "tools: !unset\n", tools: defaults },
  ];
  if (version === 3) {
    it.each(unsetBodies)("uses version-2 defaults for unset: $body", ({ body, tools }) => { verify(prefix + body, tools, version); });
  } else {
    it.each(unsetBodies)("refuses !unset in a whole file, as before: $body", ({ body }) => {
      expect(() => parseConfigDocument("mcp", prefix + body, "mcp.yaml")).toThrow(ConfigError);
    });
  }

  it.each([...invalidBodies, ...nullBodies])("leaves invalid and null tools intact for validation: %s", (body) => {
    const doc = parseConfigDocument("mcp", prefix + body, "mcp.yaml");
    const before: unknown = doc.toJS();
    const result = migrateConfigDocument("mcp", doc, "mcp.yaml");
    expect(doc.toJS()).toEqual(version === 3 ? { ...(before as object), config_version: 3 } : before);
    expect(result.notices).toEqual([]);
    expect(() => parseConfigText("mcp", prefix + body, "mcp.yaml")).toThrow(ConfigError);
  });

  it("accepts the new shape unchanged, without a pending whole-file step", () => {
    const text = prefix + "permissions: [writer:read]\nstdio:\n  permissions: [writer:read]\n";
    const doc = parseConfigDocument("mcp", text, "mcp.yaml");
    const before = doc.toString();
    const result = migrateConfigDocument("mcp", doc, "mcp.yaml");
    expect(result.notices).toEqual([]);
    expect(result.to).toBe(version);
    expect(parseConfigText("mcp", doc.toString()).permissions).toEqual(["writer:read"]);
    if (version === 1) { expect(doc.toString()).toBe(before); expect(result.applied).toEqual([]); }
    expect(migrateConfigDocument("mcp", doc, "mcp.yaml").applied).toEqual([]);
  });
});

it.each([
  { existing: "permissions: [writer:write]\n", matrix: ["writer:write"], stdio: ["jobs:read", "tracking:read"] },
  { existing: "stdio:\n  permissions: []\n", matrix: ["jobs:read", "tracking:read"], stdio: [] },
  { existing: "permissions: []\nstdio:\n  permissions: [writer:read]\n", matrix: [], stdio: ["writer:read"] },
  { existing: "stdio: {}\n", matrix: ["jobs:read", "tracking:read"], stdio: ["jobs:read", "tracking:read"] },
])("keeps explicit grants and fills only missing ones: $existing", ({ existing, matrix, stdio }) => {
  const value = parseConfigText("mcp", "config_version: 2\ntools: {}\n" + existing);
  expect(value.permissions).toEqual(matrix);
  expect(value.stdio.permissions).toEqual(stdio);
});

it.each([
  "tools: {get_job: false} # old note\n",
  "tools: # old note\n  # switch note\n  get_job: false # switch note\n",
])("keeps other keys' comments, drops the comments of tools and its switches and inserts the grants where tools stood: %s", (tools) => {
  const doc = parseConfigDocument("mcp", `config_version: 2\n# master\nenabled: true # enabled note\n\n# old tools\n# second line\n${tools}# limits note\nlimits: {max_results: 7}\n`, "mcp.yaml");
  migrateConfigDocument("mcp", doc, "mcp.yaml");
  const after = doc.toString();
  for (const comment of ["# master", "# enabled note", "# limits note"]) expect(after).toContain(comment);
  expect(after).toContain("enabled: true # enabled note\n\npermissions:\n");
  for (const comment of ["old tools", "second line", "old note", "switch note"]) expect(after).not.toContain(comment);
  expect(after.indexOf("enabled:")).toBeLessThan(after.indexOf("permissions:"));
  expect(after.indexOf("stdio:")).toBeLessThan(after.indexOf("limits:"));
  expect(parseConfigText("mcp", after).permissions).toEqual(["jobs:read", "tracking:read"]);
});

it("accepts every catalog id and keeps removed tools invalid in version 3", () => {
  expect(mcpSchema.parse({ permissions: [...PERMISSIONS], stdio: { permissions: [...PERMISSIONS] } }).permissions).toEqual(PERMISSIONS);
  expect(() => parseConfigText("mcp", "config_version: 3\ntools: {}\n")).toThrow(ConfigError);
});

it.each(formats.flatMap((format) => nullBodies.map((body) => ({ ...format, body }))))("refuses calls when a $name has null tools, read in memory: $body", ({ prefix, body }) => {
  temp = makeTempConfig({ user: "empty" });
  fs.writeFileSync(path.join(temp.configDir, "mcp.yaml"), `${prefix}enabled: true\n${body}`);
  for (const capability of CAPABILITIES) expect(authorize(capability, liveMcpSettings)).toMatchObject({ allowed: false, reason: "unreadable" });
});

it("a missing file means off with default permissions", () => {
  temp = makeTempConfig({ user: "empty" });
  fs.rmSync(path.join(temp.defaultsDir, "mcp.yaml"));
  const settings = readMcpSettings();
  expect(settings.enabled).toBe(false);
  expect(settings.permissions).toEqual(DEFAULT_PERMISSIONS);
  expect(settings.stdio.permissions).toEqual(DEFAULT_PERMISSIONS);
});

describe.each(formats)("migration files: $name", ({ prefix, version }) => {
  it.each([false, true])("plans, preserves meaning, backs up and reaches the right version; convertOverlays=%s", async (convertOverlays) => {
    temp = makeTempConfig({ user: "empty" });
    const file = path.join(temp.configDir, "mcp.yaml");
    const before = prefix + "enabled: true\ntools:\n  get_job: false\n";
    fs.writeFileSync(file, before);
    const plan = planConfigMigrations(["mcp"], { convertOverlays });
    expect(plan.problems).toEqual([]);
    expect(plan.pending).toHaveLength(1);
    const item = plan.pending[0];
    expect(item?.to).toBe(convertOverlays ? 3 : version);
    expect(item?.notices).toEqual([notice("get_job")]);
    expect(parseConfigText("mcp", item?.after ?? "")).toEqual(parseConfigText("mcp", before));
    const applied = await applyConfigMigrations(plan, new Date("2026-11-01T12:00:00Z"), { convertOverlays });
    expect(applied.written).toEqual([file]);
    expect(fs.readFileSync(path.join(applied.backupDir ?? "", "mcp.yaml"), "utf8")).toBe(before);
    expect(fs.readFileSync(file, "utf8")).toBe(item?.after);
    expect(planConfigMigrations(["mcp"], { convertOverlays }).pending).toEqual([]);
  });
});

it.each(formats.flatMap((format) => [false, true].flatMap((convertOverlays) => ["tools: {unknown: true}\n", "tools: {get_job: invalid}\n", "tools:\n"].map((body) => ({ ...format, convertOverlays, body })))))
  ("reports invalid tools in planning: $name, convertOverlays=$convertOverlays, $body", ({ prefix, convertOverlays, body }) => {
    temp = makeTempConfig({ user: "empty" });
    fs.writeFileSync(path.join(temp.configDir, "mcp.yaml"), prefix + body);
    const plan = planConfigMigrations(["mcp"], { convertOverlays });
    expect(plan.pending).toEqual([]);
    if (prefix !== "config_version: 2\n" && !convertOverlays) {
      expect(plan.current).toHaveLength(1);
      expect(plan.problems).toEqual([]);
      expect(() => parseConfigText("mcp", prefix + body, "mcp.yaml")).toThrow(ConfigError);
      return;
    }
    expect(plan.current).toEqual([]);
    expect(plan.problems).toHaveLength(1);
  });

it("prints the per-file notice once under the steps in preview and write mode", () => {
  temp = makeTempConfig({ user: "empty" });
  const file = path.join(temp.configDir, "mcp.yaml");
  const before = "config_version: 2\nenabled: true\ntools: {search_jobs: false}\n";
  fs.writeFileSync(file, before);
  for (const args of [[], ["--write"]]) {
    const result = runConfigScript(temp, "config-migrate.ts", args);
    expect(result.status).toBe(0);
    expect(result.out.match(/    note: /g)).toHaveLength(1);
    expect(result.out).toContain(`    note: ${notice("search_jobs")}`);
    expect(result.out.indexOf("2 -> 3:")).toBeLessThan(result.out.indexOf("    note: "));
  }
});

it.each(["", "config_version: 1\n"])("says a whole file's shape was updated while its format version stays: %j", (prefix) => {
  temp = makeTempConfig({ user: "empty" });
  fs.writeFileSync(path.join(temp.configDir, "mcp.yaml"), `${prefix}enabled: true\ntools: {get_job: false}\n`);
  const check = runConfigScript(temp, "config-check.ts", []);
  expect(check.out).toContain("shape updated, config_version 1 unchanged, applied in memory: run pnpm config:migrate --write");
  const migrate = runConfigScript(temp, "config-migrate.ts", []);
  expect(migrate.status).toBe(0);
  expect(migrate.out).toContain("mcp.yaml  shape updated, config_version 1 unchanged\n    2 -> 3: ");
  expect(migrate.out).not.toContain("config_version 1 -> 1");
});

it("saving a legacy whole file keeps its format version and migrated permission meaning", async () => {
  temp = makeTempConfig({ user: "empty" });
  const file = path.join(temp.configDir, "mcp.yaml");
  fs.writeFileSync(file, "config_version: 1\nenabled: true\ntools: {get_job: false}\n");
  const value = readMcpSettings();
  await writeConfig("mcp", { ...value, limits: { ...value.limits, max_results: 7 } });
  expect(fs.readFileSync(file, "utf8")).toContain("config_version: 1");
  expect(fs.readFileSync(file, "utf8")).not.toContain("tools:");
  expect(planConfigMigrations(["mcp"]).pending).toEqual([]);
});
