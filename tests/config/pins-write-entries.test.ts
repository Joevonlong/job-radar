// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { applyExamplePlan, ensureProfileFiles, getConfigPath, loadConfig, overlayFormatVersion, planExample, readExample, resetConfigCache, setOnProfileSaved, type ConfigName } from "@/lib/config";
import { valueAt } from "@/lib/config/merge";
import { parseConfigYaml } from "@/lib/config/yaml-options";
import { saveView } from "@/lib/interests/service";
import { resetSetupStateCache } from "@/lib/setup/state";
import { saveAiStep } from "@/lib/setup/steps/ai";
import { saveLanguageStep } from "@/lib/setup/steps/language";
import { saveMarketStep } from "@/lib/setup/steps/market";
import { saveSourcesStep } from "@/lib/setup/steps/sources";
import { saveTargetsStep } from "@/lib/setup/steps/targets";
import { saveTelegramStep } from "@/lib/setup/steps/telegram";
import { saveAtsBoard } from "@/lib/sources/registry/service";
import { UNREACHABLE_DATABASE_URL } from "@/lib/db/test-guard";

import { makeTempConfig, type TempConfig } from "./helpers";

vi.mock("@/lib/sources/registry/sync", () => ({ syncSourceRegistry: vi.fn(async () => ({ upserted: 0, removed: 0 })) }));
vi.mock("@/lib/db", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/db")>()), getDb: () => ({}) }));

/**
 * A hand-written pin (a key written into the file with the shipped value) survives every write entry: an unrelated change
 * through the entry keeps it, and saving the same thing again leaves the file's bytes alone.
 */
let tmp: TempConfig;
const savedUrl = process.env.DATABASE_URL;

beforeEach(async () => {
  process.env.DATABASE_URL = UNREACHABLE_DATABASE_URL; // the profile history snapshot fails and the file still counts as written
  tmp = makeTempConfig();
  await ensureProfileFiles();
  resetSetupStateCache();
});
afterEach(() => {
  setOnProfileSaved(null);
  tmp.cleanup();
  if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
  else delete process.env.DATABASE_URL;
});

const fileOf = (name: ConfigName): string => getConfigPath(name);
const bytes = (name: ConfigName): string => fs.readFileSync(fileOf(name), "utf8");

/** `key: value` nested along `keyPath`. */
function nested(keyPath: readonly string[], value: unknown): unknown {
  return keyPath.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
}

/** Write `keyPath: <the shipped value>` as the whole content of the user file (an overlay with one pin). */
function pin(name: ConfigName, keyPath: readonly string[]): unknown {
  const shippedValue = valueAt(loadConfig(name), keyPath);
  expect(shippedValue, `${name} ${keyPath.join(".")}`).not.toBeUndefined();
  fs.writeFileSync(fileOf(name), `# my pin\nconfig_version: ${overlayFormatVersion(name)}\n${stringify(nested(keyPath, shippedValue))}`);
  resetConfigCache();
  return shippedValue;
}

const overlayOf = (name: ConfigName): unknown => parseConfigYaml(bytes(name), { unset: "overlay" });

const MARKET = { market: { pack: "generic", country: "NL", currency: "EUR", home_language: "nl" }, home_city: "Amsterdam", places: [{ place: "Utrecht", relocate: true }, { place: "eu", relocate: false }], timezone: "Europe/Amsterdam" };
const TARGETS = { target_titles: ["Data Engineer", "Analytics Engineer"], seniority: "senior", workplace: ["hybrid", "remote"], salary_floor_year: "60000", contracts: { permanent: "allow", fixed_term: "none", freelance: "none", temp_agency: "exclude" }, exclude_student_roles: true, exclude_companies: ["Example Staffing"], exclude_keywords: ["unpaid"] };
const BOARD = { name: "Example Co", ats: "greenhouse", token: "exampleco", enabled: true };

interface Entry {
  name: string;
  /** The file that gets the pin, and the key the entry does not touch. */
  config: ConfigName;
  keyPath: string[];
  /** Called once the pin is in the file: returns an unrelated change through the entry (and, optionally, a save of the same thing again). */
  prepare: () => { change: () => Promise<unknown>; again?: () => Promise<unknown> };
}

/** The save to repeat, fixed once the pin is in the file (a value flipped from the current one must be flipped only once). */
const save = (run: () => Promise<unknown>): ReturnType<Entry["prepare"]> => ({ change: run });

const ENTRIES: Entry[] = [
  {
    name: "wizard: language",
    config: "language",
    keyPath: ["translation", "target"],
    prepare: () => {
      const ui_locale = loadConfig("language").ui.default_locale === "en" ? "zh" : "en";
      return save(() => saveLanguageStep({ ui_locale }));
    },
  },
  { name: "wizard: market", config: "schedule", keyPath: ["backup", "keep_daily"], prepare: () => save(() => saveMarketStep(MARKET)) },
  { name: "wizard: targets", config: "search", keyPath: ["max_per_group_per_location"], prepare: () => save(() => saveTargetsStep(TARGETS)) },
  {
    name: "wizard: sources",
    config: "channels",
    keyPath: ["sources", "lever", "enabled"],
    prepare: () => {
      const greenhouse = !loadConfig("channels").sources.greenhouse.enabled;
      return save(() => saveSourcesStep({ channels: { greenhouse } }));
    },
  },
  {
    name: "wizard: ai",
    config: "ai",
    keyPath: ["api_timeout_seconds"],
    prepare: () => {
      const enabled = !loadConfig("ai").providers.mimo.enabled;
      return save(() => saveAiStep({ providers: { mimo: { enabled } } }));
    },
  },
  {
    name: "wizard: telegram",
    config: "notify",
    keyPath: ["push_min_score"],
    prepare: () => {
      const enabled = !loadConfig("notify").telegram.enabled;
      return save(() => saveTelegramStep({ enabled }));
    },
  },
  { name: "/interests", config: "interests", keyPath: ["bonus_cap"], prepare: () => save(() => saveView({ name: "Berlin", filters: { city: "Berlin" } })) },
  {
    name: "source registration",
    config: "channels",
    keyPath: ["sources", "lever", "enabled"],
    prepare: () => ({
      change: () => saveAtsBoard({ original: null, board: BOARD }),
      again: () => saveAtsBoard({ original: { ats: BOARD.ats, token: BOARD.token }, board: BOARD }),
    }),
  },
  {
    name: "config:example",
    config: "search",
    keyPath: ["window_hours", "morning"],
    prepare: () => {
      const dir = path.join(tmp.defaultsDir, "examples", "demo");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "example.yaml"), "name: Demo\ndescription: A demo setup.\n");
      fs.writeFileSync(path.join(dir, "search.yaml"), `max_per_group_per_location: ${loadConfig("search").max_per_group_per_location + 3}\n`);
      return save(async () => {
        resetConfigCache();
        return applyExamplePlan(planExample(readExample("demo")));
      });
    },
  },
];

describe("a pin equal to the shipped value", () => {
  it.each(ENTRIES)("$name: kept through an unrelated save, and a second identical save leaves the bytes alone", async (entry) => {
    const pinned = pin(entry.config, entry.keyPath);
    const { change, again } = entry.prepare();

    await change();
    resetConfigCache();
    const afterChange = bytes(entry.config);
    expect(valueAt(overlayOf(entry.config), entry.keyPath), "the pin is still in the file").toEqual(pinned);
    expect(afterChange).toContain("# my pin");
    // the entry did write something else (the test is about a save that happened)
    expect(afterChange).not.toBe(`# my pin\nconfig_version: ${overlayFormatVersion(entry.config)}\n${stringify(nested(entry.keyPath, pinned))}`);

    await (again ?? change)();
    resetConfigCache();
    expect(bytes(entry.config)).toBe(afterChange);
  });
});
