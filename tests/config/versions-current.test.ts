// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { configMigrations, configRegistry, currentConfigVersion, hasOverlayFormat, LAYERED_CONFIG_NAMES, legacyFormatVersion, overlayFormatVersion } from "@/lib/config";
import { parseConfigYaml } from "@/lib/config/yaml-options";

import { FIXTURE_DEFAULTS_DIR, REPO_DEFAULTS_DIR } from "./helpers";

const versionIn = (dir: string, file: string): unknown => (parseConfigYaml(fs.readFileSync(path.join(dir, file), "utf8")) as Record<string, unknown>).config_version;

describe("shipped files are released at the code's version", () => {
  for (const dir of [REPO_DEFAULTS_DIR, FIXTURE_DEFAULTS_DIR]) {
    it(`every layered file in ${path.basename(path.dirname(dir))}/${path.basename(dir)}`, () => {
      for (const name of LAYERED_CONFIG_NAMES) {
        const version = versionIn(dir, configRegistry[name].file);
        expect([name, version ?? 1]).toEqual([name, currentConfigVersion(name)]);
      }
    });
  }
});

describe("the overlay format step", () => {
  it("is the format boundary of every layered file but models.yaml, which has its own overlay by id", () => {
    for (const name of LAYERED_CONFIG_NAMES) {
      const steps = configMigrations(name);
      if (name === "models") {
        expect(hasOverlayFormat(name)).toBe(false);
        expect(overlayFormatVersion(name)).toBeNull();
        continue;
      }
      expect(steps.some((step) => step.convertOnly)).toBe(true);
      expect(steps.filter((step) => step.convertOnly)).toHaveLength(1);
      expect(legacyFormatVersion(name) + 1).toBe(overlayFormatVersion(name));
      expect(overlayFormatVersion(name)).toBeLessThanOrEqual(currentConfigVersion(name));
    }
  });
});
