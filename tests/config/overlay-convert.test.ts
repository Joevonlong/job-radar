import { describe, expect, it } from "vitest";
import { Document } from "yaml";

import { ConfigError, parseConfigText } from "@/lib/config";
import { mergeLayers } from "@/lib/config/merge";
import { convertLegacy } from "@/lib/config/migrations/overlay-convert";
import { applyOverlayEdits } from "@/lib/config/overlay-diff";
import { replaceRule } from "@/lib/config/overlay-rules";
import type { ConfigName } from "@/lib/config/registry";
import { toFullText } from "@/lib/config/to-full";
import { CONFIG_YAML_OPTIONS, stringifyConfigYaml, UNSET } from "@/lib/config/yaml-options";

import { effective, fixtureText, migratedDocument, overlayDocument, plainValue, shippedValue } from "./overlay-helpers";

type Plain = Record<string, Record<string, unknown>>;

function convert(name: ConfigName, legacy: unknown): ReturnType<typeof convertLegacy> & { overlay: unknown } {
  const shipped = shippedValue(name);
  const result = convertLegacy(name, { shipped, legacy, filePath: `${name}.yaml` });
  const converted = applyOverlayEdits({}, result.edits);
  // the invariant: the effective value does not change
  expect(effective(name, mergeLayers(shipped, converted, { replaceAt: replaceRule(name) }))).toEqual(effective(name, legacy));
  return { ...result, overlay: converted };
}

describe("convertLegacy", () => {
  it("keeps timestamp leaves through conversion, overlay serialization and full rendering", () => {
    const shipped = migratedDocument("channels", fixtureText("channels"));
    const legacy = shipped.clone();
    legacy.setIn(["linkedin", "apify", "input_template"], overlayDocument("since: !!timestamp 2026-10-30\nnested: {dates: [!!timestamp 2026-10-31]}\n").contents);
    const expected = parseConfigText("channels", legacy.toString());
    const result = convert("channels", plainValue(legacy));
    const text = stringifyConfigYaml(new Document(result.overlay, CONFIG_YAML_OPTIONS));
    const full = toFullText("channels", shipped, overlayDocument(text));
    expect(parseConfigText("channels", full)).toEqual(expected);
    expect(expected.linkedin.apify.input_template.since).toEqual(new Date("2026-10-30T00:00:00.000Z"));
  });

  it("turns a full copy of the shipped file into an empty overlay and lists the dropped keys", () => {
    const result = convert("schedule", shippedValue("schedule"));
    expect(result.overlay).toEqual({});
    expect(result.kept).toEqual([]);
    expect(result.dropped).toContain("timezone");
    expect(result.dropped).toContain("backup.keep_daily");
  });

  it("keeps only the key that was changed", () => {
    const legacy = shippedValue("schedule") as Plain;
    legacy.backup = { ...legacy.backup, keep_daily: 99 };
    const result = convert("schedule", legacy);
    expect(result.overlay).toEqual({ backup: { keep_daily: 99 } });
    expect(result.kept).toEqual(["backup.keep_daily"]);
    expect(result.dropped).not.toContain("backup.keep_daily");
  });

  it("writes !unset for a deleted glossary entry", () => {
    const legacy = shippedValue("ai") as Plain;
    const glossary = { ...(legacy.translation?.glossary as Record<string, string>) };
    delete glossary["Solutions Engineer"];
    legacy.translation = { ...legacy.translation, glossary };
    const result = convert("ai", legacy);
    expect(result.overlay).toEqual({ translation: { glossary: { "Solutions Engineer": UNSET } } });
    expect(result.unset).toEqual(["translation.glossary.Solutions Engineer"]);
  });

  it("writes the explicit value of a key the legacy file lacks when the schema default differs from the shipped value", () => {
    const legacy = shippedValue("language") as Plain;
    const ai = { ...legacy.ai };
    delete ai.summary_also;
    legacy.ai = ai;
    const result = convert("language", legacy);
    expect(result.overlay).toEqual({ ai: { summary_also: [] } });
    expect(result.filled).toEqual(["ai.summary_also"]);
    expect(result.kept).toEqual([]);
  });

  it("leaves out a missing key whose schema default equals the shipped value", () => {
    const legacy = shippedValue("schedule") as Plain;
    const backup = { ...legacy.backup };
    delete backup.max_age_hours;
    legacy.backup = backup;
    const result = convert("schedule", legacy);
    expect(result.overlay).toEqual({});
    expect(result.filled).toEqual([]);
    expect(result.unset).toEqual([]);
  });

  it("does not convert a file that does not pass its schema", () => {
    expect(() => convertLegacy("schedule", { shipped: shippedValue("schedule"), legacy: { timezone: 5 }, filePath: "schedule.yaml" })).toThrow(ConfigError);
  });

  it("replaces a whole record as a whole (search keyword_groups)", () => {
    const legacy = shippedValue("search") as Plain;
    legacy.keyword_groups = { mine: ["Staff Engineer"] };
    const result = convert("search", legacy);
    expect(result.overlay).toEqual({ keyword_groups: { mine: ["Staff Engineer"] } });
  });

  it("returns plain edits that survive structuredClone", () => {
    const legacy = shippedValue("ai") as Plain;
    legacy.translation = { ...legacy.translation, glossary: {} };
    const result = convertLegacy("ai", { shipped: shippedValue("ai"), legacy, filePath: "ai.yaml" });
    expect(structuredClone(result)).toEqual(result);
  });
});
