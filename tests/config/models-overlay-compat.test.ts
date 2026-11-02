// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { loadConfig, validateConfigText } from "@/lib/config";

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
  it("loads with the provider sections it lacks taken from the shipped file, and the user's own edits kept", () => {
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

  it("also gets the shipped models its provider sections lack (a model added by a product update)", () => {
    const doc = parseDocument(fs.readFileSync(path.join(tmp.defaultsDir, "models.yaml"), "utf8"));
    const copy = doc.toString();
    fs.writeFileSync(path.join(tmp.configDir, "models.yaml"), copy);
    const shipped = parseDocument(copy);
    shipped.addIn(["providers", "deepseek", "models"], shipped.createNode({ id: "deepseek-new", price: { input_per_mtok: 1, output_per_mtok: 1 } }));
    fs.writeFileSync(path.join(tmp.defaultsDir, "models.yaml"), shipped.toString());
    expect(loadConfig("models").providers.deepseek.models.map((m) => m.id)).toContain("deepseek-new");
  });
});
