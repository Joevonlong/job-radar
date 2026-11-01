// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configRegistry, currentConfigVersion, interestsRawWarnings, validateConfigText } from "@/lib/config";
import { DATE_FILTER_DEFAULTS } from "@/lib/config/schemas/ui";

import { makeTempConfig, shippedYaml, type TempConfig } from "./helpers";
import { runConfigScript } from "./run-script";

type Json = Record<string, unknown>;

const ui = (filters: Json | undefined): unknown => {
  const config = structuredClone(shippedYaml("ui.yaml")) as Json;
  if (filters === undefined) delete config.filters;
  else config.filters = { hidden_workplaces: [], hidden_contracts: [], ...filters };
  return config;
};
const read = (config: unknown) => (configRegistry.ui.schema.parse(config) as { filters: { date_quick_ranges: string[]; date_default_field: string } }).filters;
const issues = (config: unknown): string[] => {
  const result = configRegistry.ui.schema.safeParse(config);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
};

describe("ui date filter keys", () => {
  it("a file without them (or without the filters block) reads with the defaults", () => {
    expect(read(ui({}))).toMatchObject(DATE_FILTER_DEFAULTS);
    expect(read(ui(undefined))).toMatchObject(DATE_FILTER_DEFAULTS);
  });

  it("takes your own list of ranges and the default date", () => {
    expect(read(ui({ date_quick_ranges: ["3d", "30d"], date_default_field: "seen" }))).toMatchObject({ date_quick_ranges: ["3d", "30d"], date_default_field: "seen" });
  });

  it("names the key of a range that is not Nd or month, an empty, a long or a repeating list, and an unknown date", () => {
    expect(issues(ui({ date_quick_ranges: ["7d", "0d"] }))).toEqual(["filters.date_quick_ranges.1"]);
    expect(issues(ui({ date_quick_ranges: ["367d"] }))).toEqual(["filters.date_quick_ranges.0"]);
    expect(issues(ui({ date_quick_ranges: ["week"] }))).toEqual(["filters.date_quick_ranges.0"]);
    expect(issues(ui({ date_quick_ranges: [] }))).toEqual(["filters.date_quick_ranges"]);
    expect(issues(ui({ date_quick_ranges: ["1d", "2d", "3d", "4d", "5d", "6d", "7d", "8d", "9d"] }))).toEqual(["filters.date_quick_ranges"]);
    expect(issues(ui({ date_quick_ranges: ["7d", "7d"] }))).toEqual(["filters.date_quick_ranges"]);
    expect(issues(ui({ date_default_field: "updated" }))).toEqual(["filters.date_default_field"]);
  });
});

/** A filter key no version knows: stands for what a later version may add to a view. */
const FUTURE_KEY = "futureFilter";

describe("saved views hold the date condition", () => {
  const interests = (views: unknown): Json => ({ ...structuredClone(shippedYaml("interests.yaml")), views }) as Json;
  const parseViews = (filters: Json) => configRegistry.interests.schema.safeParse(interests([{ id: "v", name: "V", default: false, filters }]));

  it("accepts a quick range, a custom range and what they compare, and keeps them as written", () => {
    for (const filters of [{ within: "7d", dateBy: "posted" }, { within: "month" }, { within: "366d", dateBy: "seen" }, { from: "2026-10-01", to: "2026-10-15", dateBy: "posted" }]) {
      const parsed = parseViews(filters);
      expect(parsed.success, JSON.stringify(filters)).toBe(true);
      if (parsed.success) expect((parsed.data as { views: { filters: Json }[] }).views[0]?.filters).toEqual(filters);
    }
  });

  it("rejects a range or a date field the URL would not take", () => {
    for (const within of ["0d", "367d", "7", "7D", "week", 7]) expect(parseViews({ within }).success, String(within)).toBe(false);
    expect(parseViews({ dateBy: "updated" }).success).toBe(false);
  });

  it("loads a view file from before the date filter exactly as it did", () => {
    const parsed = parseViews({ city: "Berlin", from: "2026-10-01", to: "2026-10-15" });
    expect(parsed.success && (parsed.data as { views: { filters: Json }[] }).views[0]?.filters).toEqual({ city: "Berlin", from: "2026-10-01", to: "2026-10-15" });
  });
});

describe("saved views read by an older or newer version", () => {
  const interests = (views: unknown): Json => ({ ...structuredClone(shippedYaml("interests.yaml")), views }) as Json;
  const view = (filters: Json) => [{ id: "v", name: "V", default: false, filters }];

  it("ignores a filter key it does not know and keeps the others", () => {
    const parsed = configRegistry.interests.schema.parse(interests(view({ city: "Berlin", [FUTURE_KEY]: "7d", other: "x" }))) as { views: { filters: Json }[] };
    expect(parsed.views[0]?.filters).toEqual({ city: "Berlin" });
  });

  it("still validates the keys it knows", () => {
    expect(configRegistry.interests.schema.safeParse(interests(view({ [FUTURE_KEY]: "7d", minScore: 101 }))).success).toBe(false);
  });

  it("stays strict about everything else in interests.yaml", () => {
    expect(configRegistry.interests.schema.safeParse({ ...interests(view({})), surprise: true }).success).toBe(false);
    expect(configRegistry.interests.schema.safeParse(interests([{ id: "v", name: "V", default: false, filters: {}, extra: 1 }])).success).toBe(false);
  });

  it("warns, with the path, for each key it ignored", () => {
    const warnings = interestsRawWarnings(interests([...view({ [FUTURE_KEY]: "7d" }), { ...view({ city: "Berlin", within: "7d", foo: 1 })[0], id: "w", name: "W" }]));
    expect(warnings.map((w) => w.path.join("."))).toEqual([`views.0.filters.${FUTURE_KEY}`, "views.1.filters.foo"]);
    expect(warnings[0]?.message).toContain(`"${FUTURE_KEY}"`);
    expect(interestsRawWarnings(interests(view({ city: "Berlin" })))).toEqual([]);
    expect(interestsRawWarnings(undefined)).toEqual([]);
  });

  it("the config editor accepts such a file and warns", () => {
    const text = JSON.stringify({ ...interests(view({ city: "Berlin", [FUTURE_KEY]: "7d" })), config_version: currentConfigVersion("interests") });
    const result = validateConfigText("interests", text);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.warnings.map((w) => w.path)).toContain(`views[0].filters.${FUTURE_KEY}`);
  });
});

describe("pnpm config:check with a view from a newer version", () => {
  let tmp: TempConfig;
  beforeEach(() => {
    tmp = makeTempConfig();
  });
  afterEach(() => tmp.cleanup());

  it("passes and prints a warning for the unknown filter key", () => {
    const file = path.join(tmp.configDir, "interests.yaml");
    const config = parseYaml(fs.readFileSync(file, "utf8")) as Json;
    config.views = [{ id: "week", name: "Week", default: false, filters: { city: "Berlin", [FUTURE_KEY]: "7d" } }];
    fs.writeFileSync(file, stringifyYaml(config));
    const run = runConfigScript(tmp, "config-check.ts");
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain(`! interests.yaml views.0.filters.${FUTURE_KEY}`);
  });
});
