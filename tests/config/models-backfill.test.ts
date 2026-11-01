// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { loadConfig, validateConfigText } from "@/lib/config";
import { withShippedModelProviders } from "@/lib/config/models-backfill";

import { makeTempConfig, type TempConfig } from "./helpers";

let tmp: TempConfig;
beforeEach(() => {
  tmp = makeTempConfig();
});
afterEach(() => tmp.cleanup());

/** A full user copy of models.yaml made before the openai / openrouter sections existed, with one own edit. */
function writeOldCopy(): string {
  const doc = parseDocument(fs.readFileSync(path.join(tmp.defaultsDir, "models.yaml"), "utf8"));
  doc.deleteIn(["providers", "openai"]);
  doc.deleteIn(["providers", "openrouter"]);
  doc.setIn(["providers", "mimo", "notes"], "my own note");
  const text = doc.toString();
  fs.writeFileSync(path.join(tmp.configDir, "models.yaml"), text);
  return text;
}

describe("an older full models.yaml copy", () => {
  it("loads with the new provider sections taken from the shipped file, and the user's own edits kept", () => {
    writeOldCopy();
    const shipped = parseDocument(fs.readFileSync(path.join(tmp.defaultsDir, "models.yaml"), "utf8")).toJS() as { providers: Record<string, unknown> };
    const models = loadConfig("models");
    expect(models.providers.openai).toEqual(shipped.providers.openai);
    expect(models.providers.openrouter).toEqual(shipped.providers.openrouter);
    expect(models.providers.mimo.notes).toBe("my own note");
  });

  it("passes the editor's validation (what config:check and /settings use)", () => {
    expect(validateConfigText("models", writeOldCopy()).ok).toBe(true);
  });

  it("a section the copy has is never replaced", () => {
    const own = { providers: { openai: { label: "Mine", models: [] } } };
    expect(withShippedModelProviders(own)).toMatchObject({ providers: { openai: { label: "Mine", models: [] } } });
  });

  it("leaves anything that is not a providers mapping to the schema, and never changes its input", () => {
    expect(withShippedModelProviders(null)).toBeNull();
    expect(withShippedModelProviders({ providers: [] })).toEqual({ providers: [] });
    const input = { providers: { mimo: { label: "x", models: [] } } };
    const before = structuredClone(input);
    const out = withShippedModelProviders(input) as { providers: Record<string, unknown> };
    expect(input).toEqual(before);
    expect(Object.keys(out.providers)).toEqual(expect.arrayContaining(["mimo", "openai", "openrouter", "deepseek"]));
  });
});
