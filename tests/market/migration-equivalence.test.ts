// @vitest-environment node
/**
 * Acceptance: the config files of a German instance from before the market packs (`tests/fixtures/config/legacy-de`,
 * config_version 1) migrate to files that, together with the DE pack, mean exactly what they meant. Each migrated file
 * is projected back onto the old shape and compared with the original: lists as sets (regex lists also by what they
 * match over the golden inputs), ordered blocks in order. A second migration changes nothing.
 *
 * `MARKET_LEGACY_DIR=<dir>` runs the same checks on another copy (the orchestrator's check of a real instance).
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { migrateConfigDocument, parseConfigDocument, parseConfigTextWithVersion, type ConfigName, type PipelineConfig } from "@/lib/config";
import { LEGACY_REMOTE_SCOPES, remoteScopeKey } from "@/lib/market/remote-scope";
import { buildEffectivePipeline } from "@/lib/market";

import { fixtureMarket, fixturePack } from "../pipeline/helpers";
import { readGoldenInputs } from "./golden";

const LEGACY_DIR = process.env.MARKET_LEGACY_DIR ?? path.resolve(import.meta.dirname, "../fixtures/config/legacy-de");
const FILES: Partial<Record<ConfigName, string>> = {
  pipeline: "pipeline.yaml",
  preferences: "preferences.yaml",
  search: "search.yaml",
  channels: "sources.yaml",
  ai: "ai.yaml",
  insights: "insights.yaml",
};

type Json = Record<string, unknown>;
const legacyText = (name: ConfigName): string | null => {
  const file = path.join(LEGACY_DIR, FILES[name] ?? "");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
};
const legacyValue = (name: ConfigName): Json => {
  const { config_version: _v, ...rest } = parse(legacyText(name) ?? "{}") as Json;
  void _v;
  return rest;
};
/** Migrate text the way `pnpm config:migrate --write` does; returns the new text and the parsed value. */
function migrateText(name: ConfigName, text: string): { text: string; value: Json; steps: number } {
  const doc = parseConfigDocument(name, text, FILES[name] ?? name);
  const result = migrateConfigDocument(name, doc, FILES[name] ?? name);
  const after = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  return { text: after, value: parseConfigTextWithVersion(name, after, FILES[name] ?? name).value as Json, steps: result.applied.length };
}
const get = (obj: unknown, dotted: string): unknown => dotted.split(".").reduce<unknown>((cur, key) => (cur as Json | undefined)?.[key], obj);

const inputs = readGoldenInputs();
const SAMPLES = [...inputs.short, ...inputs.long];
const anyMatch = (patterns: readonly string[], text: string): boolean => patterns.some((p) => new RegExp(p, "iu").test(text));

describe.runIf(legacyText("pipeline") !== null)("pipeline.yaml: legacy -> migrated + DE pack == legacy", () => {
  const original = legacyValue("pipeline");
  const migrated = migrateText("pipeline", legacyText("pipeline") ?? "");
  const effective: PipelineConfig = buildEffectivePipeline(migrated.value as never, fixtureMarket(), fixturePack);
  const market = effective.market;

  /** Pack-managed lists of v1 -> where the effective config holds them now. */
  const lists: Record<string, readonly string[]> = {
    "company.legal_suffixes": effective.company.legal_suffixes,
    "company.agency_names": effective.company.agency_names,
    "agency.company_name_patterns": effective.agency.company_name_patterns,
    "agency.text_patterns": effective.agency.text_patterns,
    "agency.exclude_context_patterns": effective.agency.exclude_context_patterns,
    ...Object.fromEntries((["student", "temp_agency", "direct_hire", "freelance", "fixed_term", "permanent"] as const).map((k) => [`contract.${k}`, effective.contract[k]])),
    "filter.country_level.patterns": effective.filter.country_level.patterns,
    "filter.generic_location_patterns": effective.filter.generic_location_patterns,
    "filter.remote.worldwide_patterns": effective.filter.remote.worldwide_patterns,
    "filter.remote.outside_patterns": effective.filter.remote.outside_patterns,
    "filter.remote.title_outside_patterns": effective.filter.remote.title_outside_patterns,
    "filter.remote.description_in_scope_patterns": effective.filter.remote.description_in_scope_patterns,
    "filter.remote.eu_wide_patterns": market.regions.eu?.patterns ?? [],
    "filter.eu_countries": market.regions.eu?.countries ?? [],
    "filter.remote.outside_state_codes": market.subdivisionCodes.US ?? [],
  };
  /** Plain-word lists (compared as sets); the rest are regular expressions. */
  const WORD_LISTS = new Set(["company.legal_suffixes", "company.agency_names", "filter.eu_countries", "filter.remote.outside_state_codes"]);
  /** v1 wrote one regex that the packs split in two (same alternatives): compared by what it matches only. */
  const REWRITTEN = new Set(["filter.generic_location_patterns"]);

  it("migrates in one step and a second run changes nothing", () => {
    expect(migrated.steps).toBe(1);
    const again = migrateText("pipeline", migrated.text);
    expect(again.steps).toBe(0);
    expect(again.text).toBe(migrated.text);
  });

  it.each(Object.keys(lists))("%s: every old entry is still there", (key) => {
    const old = (get(original, key) ?? []) as string[];
    const now = new Set(lists[key]);
    if (REWRITTEN.has(key)) return;
    expect(old.filter((entry) => !now.has(entry))).toEqual([]);
    if (WORD_LISTS.has(key)) expect([...now].filter((entry) => !old.includes(entry))).toEqual([]);
  });

  it.each(Object.keys(lists).filter((key) => !WORD_LISTS.has(key)))("%s: matches exactly the same texts", (key) => {
    const old = (get(original, key) ?? []) as string[];
    const now = lists[key] ?? [];
    const differing = SAMPLES.filter((text) => anyMatch(old, text) !== anyMatch(now, text));
    expect(differing.slice(0, 5)).toEqual([]);
  });

  it("maps: city aliases, metro areas and regions", () => {
    for (const key of ["city_aliases", "metro_areas", "metro_regions"] as const) expect(effective.filter[key]).toEqual(get(original, `filter.${key}`));
  });

  it("the German requirement rules, in order (the DE pack's block)", () => {
    const rules = effective.language.requirement;
    expect(rules).not.toBeNull();
    const language = original.language as Json;
    const renamed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(language)) if (key.startsWith("german_")) renamed[key.slice("german_".length)] = value;
    expect(Object.fromEntries(Object.keys(renamed).map((key) => [key, (rules as unknown as Json)[key]]))).toEqual(renamed);
    expect(effective.language.min_words_for_detection).toBe(language.min_words_for_detection);
  });

  it("everything that did not move is unchanged", () => {
    for (const key of ["batch_size", "dedupe", "apply_priority", "description", "workplace"]) expect(effective[key as keyof PipelineConfig]).toEqual(original[key]);
    // The watched-job recheck added `lifecycle.watch_recheck` (schema defaults when the file has none)
    const { watch_recheck: _watchRecheck, ...lifecycle } = effective.lifecycle;
    void _watchRecheck;
    expect(lifecycle).toEqual(original.lifecycle);
    // `aliases` has a schema default
    expect(effective.skills).toEqual((original.skills as Json[]).map((skill) => ({ aliases: [], ...skill })));
    expect(effective.company.aliases).toEqual(get(original, "company.aliases"));
    expect(effective.agency.exclude_context_chars).toBe(get(original, "agency.exclude_context_chars"));
    expect(effective.filter.country_level.onsite_policy).toBe(get(original, "filter.country_level.onsite_policy"));
    expect(effective.filter.seniority_map).toEqual(get(original, "filter.seniority_map"));
    // fx_to_eur became fx_pivot EUR + fx_rates; local_currencies [EUR] is the market's currency now
    const { fx_pivot: pivot, fx_rates: rates, local_currencies: local, currencies: _tokens, ...salary } = effective.salary;
    void _tokens;
    const { fx_to_eur: legacyRates, local_currencies: legacyLocal, ...legacySalary } = original.salary as Json;
    expect(pivot).toBe("EUR");
    expect(rates).toEqual(legacyRates);
    expect(local).toEqual(legacyLocal ?? ["EUR"]);
    expect(salary).toEqual(legacySalary);
  });
});

/** The remote scope back in the old words (`home_country` was `eu_hire_in_de` for Germany). */
const legacyScope = (scope: unknown): unknown => {
  const key = remoteScopeKey(scope as never);
  return key === LEGACY_REMOTE_SCOPES.eu_hire_in_de ? "eu_hire_in_de" : key === remoteScopeKey(LEGACY_REMOTE_SCOPES.eu_any as never) ? "eu_any" : scope;
};

/** Rename keys of nested blocks back (`paths`: dotted parents). */
function renameBack(value: Json, parents: readonly string[], renames: ReadonlyArray<readonly [string, string]>): Json {
  const copy = structuredClone(value);
  for (const parent of parents) {
    const block = (parent === "" ? copy : get(copy, parent)) as Json | undefined;
    if (!block) continue;
    for (const [from, to] of renames) {
      if (from in block) {
        block[to] = block[from];
        delete block[from];
      }
    }
  }
  return copy;
}

describe.each([["preferences"], ["search"]] as const)("%s.yaml", (name) => {
  it.runIf(legacyText(name) !== null)("migrates to the DE market and the new scope words, nothing else changes", () => {
    const original = legacyValue(name);
    const migrated = migrateText(name, legacyText(name) ?? "");
    expect(migrated.steps).toBe(1);
    const { market, salary_floor_year: floor, ...rest } = migrated.value;
    if (name === "preferences") expect(market).toEqual({ pack: "de", country: "DE", currency: "EUR", home_language: "de" });
    const back = { ...rest, remote_scope: legacyScope(rest.remote_scope), ...(floor !== undefined ? { salary_floor_eur_year: floor } : {}) };
    expect(back).toEqual(original);
    expect(migrateText(name, migrated.text).steps).toBe(0);
  });
});

describe("sources.yaml", () => {
  it.runIf(legacyText("channels") !== null)("renames the remote-location keys, keeps every value", () => {
    const original = legacyValue("channels");
    const migrated = migrateText("channels", legacyText("channels") ?? "");
    expect(migrated.steps).toBe(1);
    const back = renameBack(parse(migrated.text) as Json, ["linkedin.brightdata.remote_locations", "linkedin.apify.remote_locations", "linkedin.session.site.remote_locations", "jobspy.remote_location"], [
      ["home_country", "eu_hire_in_de"],
      ["region", "eu_any"],
    ]);
    delete back.config_version;
    // the German job boards are bound to the German market now; under it they run as before
    const sources = back.sources as Record<string, Json>;
    for (const id of ["arbeitsagentur", "stepstone", "xing"]) {
      expect(sources[id]?.markets).toEqual(["DE"]);
      delete sources[id]?.markets;
    }
    expect(back).toEqual(original);
    expect(migrateText("channels", migrated.text).steps).toBe(0);
  });
});

describe("insights.yaml", () => {
  it.runIf(legacyText("insights") !== null)("renames the salary bucket keys, keeps the values", () => {
    const original = legacyValue("insights");
    const migrated = migrateText("insights", legacyText("insights") ?? "");
    const back = renameBack(parse(migrated.text) as Json, [""], [["salary_bucket", "salary_bucket_eur"], ["salary_bucket_cap", "salary_bucket_cap_eur"]]);
    delete back.config_version;
    expect(back).toEqual(original);
    expect(migrateText("insights", migrated.text).steps).toBe(0);
  });
});

describe("ai.yaml", () => {
  it.runIf(legacyText("ai") !== null)("renames the German deduction keys, keeps the values", () => {
    const original = legacyValue("ai");
    const migrated = migrateText("ai", legacyText("ai") ?? "");
    const back = renameBack(renameBack(parse(migrated.text) as Json, ["scoring"], [["language_penalty", "german_penalty"]]), ["scoring.priority.weights"], [["language_gap", "german_gap"]]);
    delete back.config_version;
    expect(back).toEqual(original);
    expect(migrateText("ai", migrated.text).steps).toBe(0);
  });
});
