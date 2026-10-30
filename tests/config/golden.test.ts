// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Document } from "yaml";

import { canonicalConfigHash } from "@/lib/config/canonical-hash";
import { effectiveConfigEntries } from "@/lib/config/effective-report";
import { mergeLayers } from "@/lib/config/merge";
import { convertLegacy } from "@/lib/config/migrations/overlay-convert";
import { applyOverlayEdits } from "@/lib/config/overlay-diff";
import { replaceRule } from "@/lib/config/overlay-rules";
import { configRegistry, LAYERED_CONFIG_NAMES, type ConfigName } from "@/lib/config/registry";
import { toFullText } from "@/lib/config/to-full";
import { CONFIG_YAML_OPTIONS, stringifyConfigYaml } from "@/lib/config/yaml-options";
import { parseConfigText } from "@/lib/config";

import { FIXTURE_DEFAULTS_DIR } from "./helpers";
import { fixtureText, migratedDocument, overlayDocument, plainValue, shippedValue } from "./overlay-helpers";

/**
 * The golden effective configs were taken with the loader of an older commit (`sha` in each file, the merge base of the
 * change that added them; see `scripts/dev/gen-config-golden.ts`). The current loader must give the same canonical
 * hashes for the same inputs, and converting each full copy to an overlay must not change them either.
 */
interface Golden {
  sha: string;
  set: string;
  files: Record<string, { layer: string; hash: string | null; valid: boolean }>;
}

const FIXTURES = path.resolve(FIXTURE_DEFAULTS_DIR, "..");
const GOLDEN_DIR = path.join(FIXTURES, "golden");
const goldens = fs
  .readdirSync(GOLDEN_DIR)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, file), "utf8")) as Golden);

let empty = "";
const saved = { config: process.env.JOB_RADAR_CONFIG_DIR, profile: process.env.JOB_RADAR_PROFILE_DIR, defaults: process.env.JOB_RADAR_DEFAULTS_DIR };
beforeAll(() => {
  empty = fs.mkdtempSync(path.join(os.tmpdir(), "config-golden-"));
});
afterAll(() => {
  fs.rmSync(empty, { recursive: true, force: true });
  for (const [key, value] of [["JOB_RADAR_CONFIG_DIR", saved.config], ["JOB_RADAR_PROFILE_DIR", saved.profile], ["JOB_RADAR_DEFAULTS_DIR", saved.defaults]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function userDir(set: string): string | null {
  return set === "defaults" ? null : path.join(FIXTURES, "full", set);
}

function pointAt(set: string): void {
  const dir = userDir(set);
  const profile = dir === null ? null : path.join(dir, "profile");
  process.env.JOB_RADAR_DEFAULTS_DIR = FIXTURE_DEFAULTS_DIR;
  process.env.JOB_RADAR_CONFIG_DIR = dir ?? path.join(empty, "config");
  process.env.JOB_RADAR_PROFILE_DIR = profile !== null && fs.existsSync(profile) ? profile : path.join(empty, "profile");
}

describe("golden files", () => {
  it("cover the defaults and at least three full copies, all from one older commit", () => {
    expect(goldens.map((golden) => golden.set)).toContain("defaults");
    expect(goldens.length).toBeGreaterThanOrEqual(4);
    expect(new Set(goldens.map((golden) => golden.sha)).size).toBe(1);
    for (const golden of goldens) {
      expect(golden.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(Object.keys(golden.files).sort(), golden.set).toEqual(Object.keys(configRegistry).sort());
    }
  });
});

describe.each(goldens)("the current loader on $set", (golden) => {
  it("gives the golden hash for every config file the golden file lists", () => {
    pointAt(golden.set);
    // a config added after the golden files were taken is not in them, and is not compared
    const entries = effectiveConfigEntries().filter((entry) => Object.hasOwn(golden.files, entry.name));
    expect(entries.length).toBe(Object.keys(golden.files).length);
    for (const entry of entries) {
      const expected = golden.files[entry.name];
      expect({ name: entry.name, layer: entry.layer, hash: entry.hash, valid: entry.error === null }, entry.error ?? "").toEqual({ name: entry.name, ...expected });
    }
  });
});

const conversions = goldens
  .filter((golden) => userDir(golden.set) !== null)
  .flatMap((golden) =>
    LAYERED_CONFIG_NAMES.filter((name) => Object.hasOwn(golden.files, name) && fs.existsSync(path.join(userDir(golden.set) ?? "", configRegistry[name].file))).map((name) => ({
      set: golden.set,
      name,
      hash: golden.files[name]?.hash ?? null,
    })),
  );

describe("convertLegacy keeps the effective value of every full copy (the golden hash)", () => {
  it("has cases", () => {
    expect(conversions.length).toBeGreaterThan(20);
  });

  it.each(conversions)("$set/$name", ({ set, name, hash }) => {
    pointAt(set);
    const file = path.join(userDir(set) ?? "", configRegistry[name].file);
    const legacy = plainValue(migratedDocument(name, fs.readFileSync(file, "utf8"), file));
    const shipped = shippedValue(name);
    const result = convertLegacy(name as ConfigName, { shipped, legacy, filePath: file });
    const overlay = applyOverlayEdits({}, result.edits);
    const schema = configRegistry[name].schema;
    const effective = schema.parse(mergeLayers(shipped, overlay, { replaceAt: replaceRule(name) }));
    expect(effective).toEqual(schema.parse(legacy));
    expect(canonicalConfigHash(effective)).toBe(hash);
    // the overlay written out and read back, then rendered as a full file: the current loader reads the same value
    const text = stringifyConfigYaml(new Document(overlay, CONFIG_YAML_OPTIONS));
    const full = toFullText(name, migratedDocument(name, fixtureText(name)), overlayDocument(text));
    const loaded = parseConfigText(name, full);
    expect(loaded).toEqual(schema.parse(legacy));
    expect(canonicalConfigHash(loaded)).toBe(hash);
  });
});
