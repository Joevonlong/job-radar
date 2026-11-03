// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { legacyFormatVersion, migrateConfigDocument, overlayFormatVersion, reloadConfig, writeConfig, type ConfigMigration } from "@/lib/config";
import { parseConfigYaml } from "@/lib/config/yaml-options";

import { makeTempConfig, type TempConfig } from "./helpers";

let temp: TempConfig;
const file = (name: string): string => path.join(temp.configDir, name);
const parsed = (name: string): Record<string, unknown> => parseConfigYaml(fs.readFileSync(file(name), "utf8"), { unset: "overlay" }) as Record<string, unknown>;

/** The shipped text as a whole user file, one format back. */
function legacyCopy(name: string, version: number): void {
  const text = fs.readFileSync(path.join(temp.defaultsDir, name), "utf8").replace(/^config_version: \d+/m, `config_version: ${version}`);
  fs.writeFileSync(file(name), text);
}

beforeEach(() => {
  temp = makeTempConfig({ user: "empty" });
});
afterEach(() => temp.cleanup());

describe("a save over a whole file", () => {
  it("keeps it whole, at the last version before the overlay format, comments included", async () => {
    legacyCopy("ui.yaml", legacyFormatVersion("ui"));
    const before = parsed("ui.yaml");
    const value = reloadConfig("ui");
    await writeConfig("ui", { ...value, trend_cycles: value.trend_cycles + 1 });
    const after = parsed("ui.yaml");
    expect(after.config_version).toBe(legacyFormatVersion("ui"));
    expect(after.config_version).not.toBe(overlayFormatVersion("ui"));
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(reloadConfig("ui").trend_cycles).toBe(value.trend_cycles + 1);
  });

  it("a file saved while another is still whole is created whole", async () => {
    legacyCopy("ui.yaml", legacyFormatVersion("ui"));
    const search = reloadConfig("search");
    await writeConfig("search", { ...search });
    expect(parsed("search.yaml").config_version).toBe(legacyFormatVersion("search"));
    expect(Object.keys(parsed("search.yaml")).length).toBeGreaterThan(1);
  });
});

describe("migrating a document", () => {
  it("never runs a convertOnly step, and stops there", () => {
    const steps: ConfigMigration[] = [
      { from: 1, to: 2, description: "structural", migrate: (doc) => void doc.set("a", 2) },
      {
        from: 2,
        to: 3,
        convertOnly: true,
        description: "format",
        migrate: () => {
          throw new Error("a convertOnly step ran");
        },
      },
    ];
    const doc = parseDocument("a: 1\n");
    const result = migrateConfigDocument("ui", doc, "x.yaml", steps);
    expect(result.to).toBe(2);
    expect(doc.get("a")).toBe(2);
  });
});
