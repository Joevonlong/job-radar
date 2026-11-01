// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDocument, stringify } from "yaml";

import { applyConfigMigrations, loadConfig, planConfigMigrations, validateConfigText } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";

let tmp: TempConfig;
beforeEach(() => {
  tmp = makeTempConfig();
});
afterEach(() => tmp.cleanup());

/** The user's ai.yaml as it was at config_version 2, with `apiOrder` (undefined: no api_order key). */
function writeVersion2Ai(apiOrder: string[] | undefined): string {
  const file = path.join(tmp.configDir, "ai.yaml");
  const doc = parseDocument(fs.readFileSync(file, "utf8"));
  doc.set("config_version", 2);
  if (apiOrder === undefined) doc.delete("api_order");
  else doc.set("api_order", doc.createNode(apiOrder));
  for (const id of ["openai", "openrouter"]) doc.deleteIn(["providers", id]);
  fs.writeFileSync(file, doc.toString());
  return file;
}

describe("ai.yaml 2 -> 3", () => {
  it("appends openai and openrouter to the end of api_order, keeping the user's order", () => {
    writeVersion2Ai(["mimo", "anthropic", "deepseek"]);
    expect(loadConfig("ai").api_order).toEqual(["mimo", "anthropic", "deepseek", "openai", "openrouter"]);
  });

  it("does not add an id twice or move one the user already placed", () => {
    writeVersion2Ai(["openrouter", "deepseek"]);
    expect(loadConfig("ai").api_order).toEqual(["openrouter", "deepseek", "openai"]);
  });

  it("does not invent an api_order: a file without one is still reported by the schema", () => {
    writeVersion2Ai(undefined);
    expect(() => loadConfig("ai")).toThrow(/api_order/);
  });

  it("the new providers get their defaults: on, JSON mode, OpenRouter keeps data collection denied", () => {
    writeVersion2Ai(["deepseek"]);
    const { providers } = loadConfig("ai");
    expect(providers.openai).toMatchObject({ enabled: true, json_mode_only: true, max_tokens_field: "max_completion_tokens" });
    expect(providers.openrouter).toMatchObject({ enabled: true, json_mode_only: true, max_tokens_field: "max_tokens" });
    expect(providers.openrouter.routing).toEqual({ require_parameters: true, data_collection: "deny", zdr: false });
    expect(providers.deepseek.max_tokens_field).toBe("max_tokens");
  });

  it("--write appends the ids, keeps comments, validates and is idempotent", async () => {
    const file = writeVersion2Ai(["deepseek", "anthropic"]);
    fs.writeFileSync(file, `# my own note\n${fs.readFileSync(file, "utf8")}`);
    await applyConfigMigrations(planConfigMigrations(["ai"]));
    const after = fs.readFileSync(file, "utf8");
    expect(after).toContain("config_version: 3");
    expect(after).toContain("# my own note");
    expect(parseDocument(after).get("api_order")).toBeDefined();
    expect((parseDocument(after).toJS() as { api_order: string[] }).api_order).toEqual(["deepseek", "anthropic", "openai", "openrouter"]);
    expect(validateConfigText("ai", after).ok).toBe(true);
    expect(planConfigMigrations(["ai"]).pending).toHaveLength(0);
  });

  it("an unknown max_tokens_field or data_collection value is rejected", () => {
    const base = parseDocument(fs.readFileSync(path.join(tmp.configDir, "ai.yaml"), "utf8")).toJS() as Record<string, unknown>;
    const bad = (edit: (providers: Record<string, Record<string, unknown>>) => void) => {
      const raw = structuredClone(base);
      raw.providers ??= {};
      edit(raw.providers as Record<string, Record<string, unknown>>);
      return validateConfigText("ai", stringify(raw)).ok;
    };
    expect(bad((p) => void (p.openai = { max_tokens_field: "max_output_tokens" }))).toBe(false);
    expect(bad((p) => void (p.openrouter = { routing: { data_collection: "maybe" } }))).toBe(false);
    expect(bad((p) => void (p.openrouter = { routing: { zdr: true } }))).toBe(true);
  });
});
