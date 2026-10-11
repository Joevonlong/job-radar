// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument, type Document } from "yaml";

import {
  applyConfigMigrations,
  assertMigrationChain,
  ConfigError,
  configMigrations,
  currentConfigVersion,
  inspectConfigLayers,
  loadConfig,
  parseConfigText,
  planConfigMigrations,
  reloadConfig,
  writeConfig,
  type ConfigMigration,
} from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";

/**
 * The config_version framework, driven by a test migration. ui.yaml "version 1" (for this test) calls the ticker
 * limit `old_ticker_max`; step 1 → 2 renames it to `ticker_max_items`, the name the current schema knows.
 */
const { renameTicker } = vi.hoisted(() => {
  const step: ConfigMigration = {
    from: 1,
    to: 2,
    description: "old_ticker_max is now ticker_max_items",
    migrate(doc: Document) {
      // (vi.hoisted runs before the imports: plain property access instead of yaml's isMap / isScalar)
      const map = doc.contents as unknown as { items?: Array<{ key?: { value?: unknown } }> } | null;
      for (const pair of map?.items ?? []) if (pair.key?.value === "old_ticker_max") pair.key.value = "ticker_max_items";
    },
  };
  return { renameTicker: step };
});

// the real migrations stay (the fixture files are at their versions), plus the test step of ui.yaml
vi.mock("@/lib/config/migrations/index", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/config/migrations/index")>();
  return { CONFIG_MIGRATIONS: { ...real.CONFIG_MIGRATIONS, ui: [renameTicker] } };
});

let tmp: TempConfig;
beforeEach(() => {
  tmp = makeTempConfig();
  // The fixture's ui.yaml ships at the real current version (version 2, with a migration of its own). This file drives
  // its own test migration (mocked below), so ui.yaml starts from the unstamped version-1 text, as it was when the layered config was written.
  for (const dir of [tmp.defaultsDir, tmp.configDir]) {
    const ui = path.join(dir, "ui.yaml");
    fs.writeFileSync(ui, fs.readFileSync(ui, "utf8").replace("config_version: 2\n\n", ""));
  }
});
afterEach(() => tmp.cleanup());

const file = (name: string) => path.join(tmp.configDir, name);
const read = (name: string) => fs.readFileSync(file(name), "utf8");
/** ui.yaml in the (test) version-1 shape, comments included. */
function writeOldUi(target = file("ui.yaml")): string {
  const text = fs.readFileSync(path.join(tmp.defaultsDir, "ui.yaml"), "utf8").replace("ticker_max_items: 8", "old_ticker_max: 5");
  fs.writeFileSync(target, text);
  return text;
}
/** The shipped ui.yaml at the code's version (the defaults ship migrated). */
function stampDefaults(): void {
  const shipped = path.join(tmp.defaultsDir, "ui.yaml");
  fs.writeFileSync(shipped, `config_version: 2\n${fs.readFileSync(shipped, "utf8")}`);
}

describe("versions and the registry", () => {
  it("the current version is the last step's `to`, 1 without steps", () => {
    expect(currentConfigVersion("ui")).toBe(2);
    expect(currentConfigVersion("breakdown")).toBe(1);
    expect(configMigrations("breakdown")).toEqual([]);
  });

  it("a chain must run 1 → 2 → 3 without gaps", () => {
    const step = (from: number, to: number): ConfigMigration => ({ from, to, migrate: () => {} });
    expect(() => assertMigrationChain("x", [step(1, 2), step(2, 3)])).not.toThrow();
    expect(() => assertMigrationChain("x", [step(2, 3)])).toThrow(/expected a step 1 → 2/);
    expect(() => assertMigrationChain("x", [step(1, 2), step(3, 4)])).toThrow(/expected a step 2 → 3/);
    expect(() => assertMigrationChain("x", [step(1, 3)])).toThrow();
  });
});

describe("in memory on load", () => {
  it("migrates an older file before validating it, and leaves the file alone", () => {
    const text = writeOldUi();
    expect(loadConfig("ui").ticker_max_items).toBe(5);
    expect(read("ui.yaml")).toBe(text);
  });

  it("accepts config_version (missing = 1) without the schemas knowing the key", () => {
    fs.writeFileSync(file("breakdown.yaml"), `config_version: 1\n${read("breakdown.yaml")}`);
    expect(reloadConfig("breakdown").jd_max_chars).toBe(12000);
    stampDefaults();
    fs.writeFileSync(file("ui.yaml"), `config_version: 2\n${fs.readFileSync(path.join(tmp.defaultsDir, "ui.yaml"), "utf8").replace("config_version: 2\n", "")}`);
    expect(reloadConfig("ui").ticker_max_items).toBe(8);
  });

  it("refuses a file from a newer version (a downgrade) and an invalid config_version", () => {
    fs.writeFileSync(file("ui.yaml"), `config_version: 3\n${read("ui.yaml")}`);
    const newer = (() => {
      try {
        reloadConfig("ui");
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(newer).toBeInstanceOf(ConfigError);
    expect(newer).toMatchObject({ kind: "version", filePath: file("ui.yaml") });
    expect((newer as ConfigError).message).toContain("config_version 3 is newer than this version of Job Radar supports (2)");

    expect(() => parseConfigText("insights", "config_version: two\ndefault_range_days: 30\n", "insights.yaml")).toThrow(
      expect.objectContaining({ kind: "schema", issues: [{ path: "config_version", message: "must be a whole number ≥ 1" }] }),
    );
  });
});

describe("pnpm config:migrate", () => {
  it("lists the pending file with its steps and the migrated text; nothing is written", () => {
    const text = writeOldUi();
    const plan = planConfigMigrations();
    expect(plan.problems).toEqual([]);
    expect(plan.pending).toHaveLength(1);
    const item = plan.pending[0];
    expect(item).toMatchObject({ name: "ui", path: file("ui.yaml"), from: 1, to: 2, steps: [{ from: 1, to: 2, description: "old_ticker_max is now ticker_max_items" }], before: text });
    expect(item?.after.startsWith("# 界面（docs/settings.md）")).toBe(true); // the header comment stays on top
    expect(item?.after).toContain("config_version: 2\n");
    expect(item?.after).toContain("# 顶部跑马灯最多滚动几条\nticker_max_items: 5");
    expect(read("ui.yaml")).toBe(text);
  });

  it("--write backs the original up, writes the migrated file (comments kept), and is idempotent", async () => {
    const text = writeOldUi();
    const now = new Date("2026-10-09T12:34:56Z");
    const applied = await applyConfigMigrations(planConfigMigrations(), now);
    expect(applied.backupDir).toBe(path.join(tmp.configDir, ".backup", "2026-10-09T12-34-56Z"));
    expect(fs.readFileSync(path.join(applied.backupDir ?? "", "ui.yaml"), "utf8")).toBe(text);
    expect(applied.written).toEqual([file("ui.yaml")]);

    const after = read("ui.yaml");
    expect(after).toContain("config_version: 2");
    expect(after).toContain("# 顶部跑马灯最多滚动几条\nticker_max_items: 5");
    expect(after).toContain("# 薪资轴（千欧元/年）");
    expect(parseDocument(after).get("old_ticker_max")).toBeUndefined();
    expect(reloadConfig("ui").ticker_max_items).toBe(5);

    const again = planConfigMigrations();
    expect(again.pending).toEqual([]);
    expect(again.current.find((c) => c.name === "ui")?.version).toBe(2);
    expect(await applyConfigMigrations(again)).toEqual({ backupDir: null, written: [] });
  });

  it("only looks at the user's files: a file read from the defaults is not migrated", () => {
    fs.rmSync(file("ui.yaml"));
    writeOldUi(path.join(tmp.defaultsDir, "ui.yaml"));
    expect(planConfigMigrations().pending).toEqual([]);
  });

  it("reports files it cannot migrate and the doctor's view of it", async () => {
    fs.writeFileSync(file("ui.yaml"), `config_version: 9\n${read("ui.yaml")}`);
    const plan = planConfigMigrations();
    expect(plan.pending).toEqual([]);
    expect(plan.problems).toEqual([expect.objectContaining({ name: "ui", path: file("ui.yaml"), message: expect.stringContaining("newer") })]);

    writeOldUi();
    const state = await inspectConfigLayers();
    expect(state.pendingMigrations).toEqual([{ file: file("ui.yaml"), from: 1, to: 2 }]);
    expect(state.problems).toEqual([]);
  });

  it("a migration whose result fails the schema is a problem, not a write", () => {
    fs.writeFileSync(file("ui.yaml"), read("ui.yaml").replace("ticker_max_items: 8", "old_ticker_max: nope"));
    const plan = planConfigMigrations();
    expect(plan.pending).toEqual([]);
    expect(plan.problems[0]?.message).toContain("ticker_max_items");
  });
});

describe("writeConfig and versions", () => {
  it("saving over an older file migrates its document first (comments kept) and stamps the version", async () => {
    writeOldUi();
    const value = structuredClone(loadConfig("ui"));
    value.trend_cycles = 9;
    await writeConfig("ui", value);
    const after = read("ui.yaml");
    expect(after).toContain("config_version: 2");
    expect(after).toContain("# 顶部跑马灯最多滚动几条\nticker_max_items: 5");
    expect(after).toContain("trend_cycles: 9");
    expect(after).not.toContain("old_ticker_max");
  });

  it("the first save of a file only the defaults have stamps the version too", async () => {
    fs.rmSync(file("ui.yaml"));
    stampDefaults();
    await writeConfig("ui", structuredClone(loadConfig("ui")));
    expect(read("ui.yaml").match(/config_version: 2/g)).toHaveLength(1);
  });

  it("keeps an explicit config_version and never adds one at version 1", async () => {
    await writeConfig("breakdown", structuredClone(loadConfig("breakdown")));
    expect(read("breakdown.yaml")).not.toContain("config_version");
    fs.writeFileSync(file("breakdown.yaml"), `config_version: 1\n${read("breakdown.yaml")}`);
    await writeConfig("breakdown", { ...structuredClone(reloadConfig("breakdown")), jd_max_chars: 9000 });
    expect(read("breakdown.yaml")).toMatch(/^config_version: 1\n/);
    expect(reloadConfig("breakdown").jd_max_chars).toBe(9000);
  });

  it("refuses to save over a file from a newer version", async () => {
    const value = structuredClone(loadConfig("ui"));
    fs.writeFileSync(file("ui.yaml"), `config_version: 5\n${read("ui.yaml")}`);
    const before = read("ui.yaml");
    await expect(writeConfig("ui", value)).rejects.toMatchObject({ kind: "version" });
    expect(read("ui.yaml")).toBe(before);
  });
});
