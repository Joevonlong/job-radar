// @vitest-environment node
/**
 * The German market behaves exactly as before the market packs (see golden.ts). Regenerate the JSON only from
 * main's code before the packs (`MARKET_GOLDEN_WRITE=1 pnpm vitest run tests/market/de-golden.test.ts`); never to
 * make a difference go away.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { configRegistry } from "@/lib/config";
import { rulesFingerprint } from "@/lib/signals";

import { shippedYaml } from "../config/helpers";
import { shippedPipeline } from "../pipeline/helpers";
import { computeGolden, deContext, GOLDEN_DIR, readGoldenInputs, US_STATE_LABEL, type Golden } from "./golden";

const GOLDEN_FILE = path.join(GOLDEN_DIR, "de-golden.json");

const inputs = readGoldenInputs();
const expected = JSON.parse(fs.readFileSync(GOLDEN_FILE, "utf8")) as Golden;
const legacyCountry = new Map(inputs.short.map((label, i) => [label, expected.location[i]?.[1] ?? null]));
const actual = computeGolden(inputs, deContext(), (label) => legacyCountry.get(label) ?? null);

type Place = readonly [string | null, string | null];

/**
 * The only differences the market packs may make (acceptance): a place outside the city table's countries that
 * the old code left without a country now gets that country (`world`, city stays null), and a US state code after a
 * European city name ("Berlin, CT") now means the US (`state`; before the market packs only 24 state codes were known).
 */
function allowedChange(label: string, got: Place, want: Place): "world" | "state" | null {
  if (want[1] === null && got[1] !== null && (got[0] === null || want[0] === got[0])) return "world";
  if (US_STATE_LABEL.test(label) && got[0] === null && (got[1] === null || got[1] === "US")) return "state";
  return null;
}

/** Labels whose location changed in an allowed way, by kind (filled by the location test). */
const changed = { world: new Set<string>(), state: new Set<string>() };
inputs.short.forEach((label, i) => {
  const got = actual.location[i] as Place;
  const want = expected.location[i] as Place;
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  const kind = allowedChange(label, got, want);
  if (kind !== null) changed[kind].add(label);
});
const isChanged = (label: string): boolean => changed.world.has(label) || changed.state.has(label);

/** The first few entries that differ, with the input they belong to (a readable failure instead of a huge diff). */
function differences<T>(name: string, got: readonly T[], want: readonly T[], label: (i: number) => string): string[] {
  const out: string[] = [];
  const length = Math.max(got.length, want.length);
  for (let i = 0; i < length && out.length < 20; i += 1) {
    if (JSON.stringify(got[i]) !== JSON.stringify(want[i])) out.push(`${name}[${label(i)}]: got ${JSON.stringify(got[i])}, want ${JSON.stringify(want[i])}`);
  }
  return out;
}

describe("DE market golden", () => {
  it("locations: normalizeLocation and normalizeDraftLocations (only the allowed kinds of change)", () => {
    const keep = (i: number): boolean => !isChanged(inputs.short[i] ?? "");
    expect(differences("location", actual.location.filter((_, i) => keep(i)), expected.location.filter((_, i) => keep(i)), (i) => inputs.short.filter((_, j) => keep(j))[i] ?? "")).toEqual([]);
    const keepDraft = (i: number): boolean => !isChanged(inputs.locations[i] ?? "");
    expect(differences("draftLocations", actual.draftLocations.filter((_, i) => keepDraft(i)), expected.draftLocations.filter((_, i) => keepDraft(i)), (i) => inputs.locations.filter((_, j) => keepDraft(j))[i] ?? "")).toEqual([]);
    // the US state codes the old code did not know: hand-written edge cases only, never a fixture's location
    expect([...changed.state].sort()).toEqual(["Berlin, CT", "Berlin, NH", "London, KY"]);
  });

  it("company keys, agency and contract", () => {
    const at = (i: number) => inputs.short[i] ?? "";
    expect(actual.companyKey).toEqual(expected.companyKey);
    expect(actual.companyNorm).toEqual(expected.companyNorm);
    expect(differences("agencyCompany", actual.agencyCompany, expected.agencyCompany, at)).toEqual([]);
    expect(differences("contractTitle", actual.contractTitle, expected.contractTitle, at)).toEqual([]);
  });

  it("German level, explicit levels, text language, contract, agency and salary of descriptions", () => {
    expect(differences("levelShort", actual.levelShort, expected.levelShort, (i) => inputs.short[i] ?? "")).toEqual([]);
    expect(differences("long", actual.long, expected.long, (i) => (inputs.long[i] ?? "").slice(0, 80))).toEqual([]);
    expect(differences("salaryText", actual.salaryText, expected.salaryText, (i) => inputs.salaryTexts[i] ?? "")).toEqual([]);
  });

  it("hard filter verdicts and reasons under every remote scope", () => {
    const keep = (i: number): boolean => !isChanged(inputs.locations[Math.floor(i / 4)] ?? "");
    for (const scope of Object.keys(expected.filterLocation)) {
      const got = (actual.filterLocation[scope] ?? []).filter((_, i) => keep(i));
      const want = (expected.filterLocation[scope] ?? []).filter((_, i) => keep(i));
      expect(differences(`filterLocation.${scope}`, got, want, (i) => String(i))).toEqual([]);
      expect(differences(`filterTitle.${scope}`, actual.filterTitle[scope] ?? [], expected.filterTitle[scope] ?? [], (i) => inputs.titles[i] ?? "")).toEqual([]);
      expect(differences(`filterDescription.${scope}`, actual.filterDescription[scope] ?? [], expected.filterDescription[scope] ?? [], (i) => (inputs.long[i] ?? "").slice(0, 80))).toEqual([]);
    }
    expect(differences("filterSalary", actual.filterSalary, expected.filterSalary, (i) => String(i))).toEqual([]);
  });

  it("pre-score, German deduction and city dropdown", () => {
    const keep = (i: number): boolean => !isChanged(inputs.locations[Math.floor(i / 2)] ?? "");
    expect(differences("priority", actual.priority.filter((_, i) => keep(i)), expected.priority.filter((_, i) => keep(i)), (i) => String(i))).toEqual([]);
    expect(actual.penalty).toEqual(expected.penalty);
    expect(actual.cityGroups).toEqual(expected.cityGroups);
  });

  it("scoring prompt: system text and output schema byte-identical", () => {
    expect(actual.prompt.system).toBe(expected.prompt.system);
    expect(JSON.stringify(actual.prompt.schema)).toBe(JSON.stringify(expected.prompt.schema));
    // the user part names the remote scope by its new value (migration: eu_hire_in_de -> home_country); nothing else changes
    expect(actual.prompt.user).toBe(expected.prompt.user.replace("remote scope: eu_hire_in_de", "remote scope: home_country"));
  });

  it("the rule-scan fingerprint is the one before the market packs (no rescan, no lost AI reviews)", () => {
    const interests = configRegistry.interests.schema.parse(shippedYaml("interests.yaml"));
    expect(rulesFingerprint(interests, shippedPipeline())).toBe("08524588cac609820854be1fd76175b8");
  });
});
