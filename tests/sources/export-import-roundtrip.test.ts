// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/sources/registry/sync", async (original) => ({ ...(await original<object>()), syncSourceRegistry: vi.fn(async () => ({ upserted: 0, removed: 0 })) }));

import { currentConfigVersion, legacyFormatVersion, reloadConfig, resetConfigCache } from "@/lib/config";
import { parseConfigYaml } from "@/lib/config/yaml-options";
import { applySourcesImport, exportSources, previewSourcesImport } from "@/lib/sources/registry/service";

import { makeTempConfig, type TempConfig } from "../config/helpers";

let temp: TempConfig;
const user = (): string => path.join(temp.configDir, "sources.yaml");
const exported = (format: "yaml" | "json"): string => {
  const result = exportSources(format, { now: new Date("2026-11-03T10:00:00Z"), timeZone: "UTC" });
  if ("error" in result) throw new Error(result.error);
  return result.body;
};

beforeEach(() => {
  temp = makeTempConfig({ user: "empty" });
  fs.writeFileSync(user(), `config_version: ${currentConfigVersion("channels")}\n`);
  resetConfigCache();
});
afterEach(() => temp.cleanup());

describe("sources export and import over an overlay", () => {
  it.each(["yaml", "json"] as const)("%s: a whole file at the older version, and importing it changes nothing", async (format) => {
    const body = exported(format);
    const value = format === "yaml" ? parseConfigYaml(body) : (JSON.parse(body) as unknown);
    expect(value).toMatchObject({ config_version: legacyFormatVersion("channels") });
    expect(Object.keys(value as object).length).toBeGreaterThan(2);
    const preview = await previewSourcesImport({ text: body, format, mode: "replace" });
    expect(preview).toMatchObject({ status: "preview", noChanges: true });
  });

  it("an import writes only what it changes", async () => {
    const value = JSON.parse(exported("json")) as { ats_boards: { ats: string; token: string }[] };
    const changed = { ...value, ats_boards: value.ats_boards.slice(1) };
    const text = JSON.stringify(changed);
    const preview = await previewSourcesImport({ text, format: "json", mode: "replace" });
    if (preview.status !== "preview") throw new Error(JSON.stringify(preview));
    const applied = await applySourcesImport({ text, format: "json", mode: "replace", baseHash: preview.baseHash, acknowledged: true });
    expect(applied).toMatchObject({ status: "done", outcome: "imported" });
    const saved = parseConfigYaml(fs.readFileSync(user(), "utf8"), { unset: "overlay" }) as Record<string, unknown>;
    expect(Object.keys(saved).sort()).toEqual(["ats_boards", "config_version"]);
    expect(reloadConfig("channels").ats_boards).toHaveLength(value.ats_boards.length - 1);
  });

  it("refuses a marker in an imported file", async () => {
    const result = await previewSourcesImport({ text: `config_version: ${currentConfigVersion("channels")}\ncollect: !unset\n`, format: "yaml", mode: "merge" });
    expect(result).toMatchObject({ status: "error" });
  });

  it("repairs a broken file through the repair entry, keeping the proxies out of the way", async () => {
    const good = exported("json");
    fs.writeFileSync(user(), "a: [\n");
    resetConfigCache();
    const preview = await previewSourcesImport({ text: good, format: "json", mode: "replace" });
    if (preview.status !== "preview") throw new Error(JSON.stringify(preview));
    const applied = await applySourcesImport({ text: good, format: "json", mode: "replace", baseHash: preview.baseHash, acknowledged: true });
    expect(applied).toMatchObject({ status: "done" });
    resetConfigCache();
    expect(reloadConfig("channels")).toBeTruthy();
    expect(Object.keys(parseConfigYaml(fs.readFileSync(user(), "utf8")) as object)).toContain("config_version");
    expect(fs.readdirSync(temp.configDir, { recursive: true }).map(String).some((entry) => entry.includes(".backup") || entry.includes(".editor"))).toBe(true);
  });
});
