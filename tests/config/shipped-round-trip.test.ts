// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { Document } from "yaml";

import { parseConfigText } from "@/lib/config";
import { mergeLayers } from "@/lib/config/merge";
import { convertLegacy } from "@/lib/config/migrations/overlay-convert";
import { applyOverlayEdits } from "@/lib/config/overlay-diff";
import { replaceRule } from "@/lib/config/overlay-rules";
import { configRegistry, LAYERED_CONFIG_NAMES } from "@/lib/config/registry";
import { toFullText } from "@/lib/config/to-full";
import { CONFIG_YAML_OPTIONS, parseConfigYaml, stringifyConfigYaml } from "@/lib/config/yaml-options";

import { REPO_DEFAULTS_DIR } from "./helpers";
import { migratedDocument, overlayDocument, plainValue } from "./overlay-helpers";

const files = fs.readdirSync(REPO_DEFAULTS_DIR, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".yaml")).sort();

describe("shipped config round trips", () => {
  it.each(files)("preserves every YAML value in %s", (file) => {
    const value = parseConfigYaml(fs.readFileSync(path.join(REPO_DEFAULTS_DIR, file), "utf8"));
    expect(parseConfigYaml(stringifyConfigYaml(new Document(value, CONFIG_YAML_OPTIONS)))).toEqual(value);
  });

  it.each(LAYERED_CONFIG_NAMES)("preserves %s through conversion and full rendering", (name) => {
    const file = path.join(REPO_DEFAULTS_DIR, configRegistry[name].file);
    const text = fs.readFileSync(file, "utf8");
    const shipped = migratedDocument(name, text, file);
    const raw = plainValue(shipped);
    const expected = parseConfigText(name, text, file);
    const converted = convertLegacy(name, { shipped: raw, legacy: structuredClone(raw), filePath: file });
    const overlay = applyOverlayEdits({}, converted.edits);
    expect(configRegistry[name].schema.parse(mergeLayers(raw, overlay, { replaceAt: replaceRule(name) }))).toEqual(expected);
    const overlayText = stringifyConfigYaml(new Document(overlay, CONFIG_YAML_OPTIONS));
    expect(parseConfigText(name, toFullText(name, shipped, overlayDocument(overlayText)), file)).toEqual(expected);
  });
});
