// @vitest-environment node
/** Packs (shipped / user copy), market resolution (fail-closed) and the effective pipeline config. */
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigError, resetConfigCache } from "@/lib/config";
import { buildEffectivePipeline, loadMarket, loadPack, loadPipeline, MarketUnresolvedError, marketSettingsProblems, resetPackCache, resolveMarket } from "@/lib/market";
import type { Pack } from "@/lib/market/load";
import { emptyGhostPack, emptyVisaPack, ghostPackSchema, visaPackSchema } from "@/lib/market/schema";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { fixtureMarket, fixturePack, shippedPipelineFile } from "../pipeline/helpers";

let tmp: TempConfig;
beforeEach(() => {
  tmp = makeTempConfig();
  resetPackCache();
});
afterEach(() => {
  tmp.cleanup();
  resetPackCache();
});

const userPackDir = (id: string) => path.join(tmp.configDir, "packs", id);
function copyPack(id: string): string {
  const dir = userPackDir(id);
  fs.cpSync(path.join(tmp.defaultsDir, "packs", id), dir, { recursive: true });
  return dir;
}
function writePreferences(market: string): void {
  fs.mkdirSync(tmp.profileDir, { recursive: true });
  const template = fs.readFileSync(path.join(tmp.defaultsDir, "profile.example", "preferences.yaml"), "utf8");
  fs.writeFileSync(path.join(tmp.profileDir, "preferences.yaml"), template.replace(/market:\n(?:  .*\n)+/, `market:\n${market}`));
  resetConfigCache();
}

describe("packs", () => {
  it("reads the shipped pack, and a user copy replaces it as a whole", () => {
    expect(loadPack("de").layer).toBe("shipped");
    const dir = copyPack("de");
    fs.writeFileSync(path.join(dir, "pack.yaml"), fs.readFileSync(path.join(dir, "pack.yaml"), "utf8").replace("name: Germany", "name: Deutschland (mine)"));
    const pack = loadPack("de");
    expect(pack.layer).toBe("user");
    expect(pack.meta.name).toBe("Deutschland (mine)");
  });

  it("an invalid file names its path and field; a missing pack is 'missing'", () => {
    const dir = copyPack("de");
    fs.writeFileSync(path.join(dir, "rules.yaml"), "contract:\n  student: ['(unclosed']\n");
    expect(() => loadPack("de")).toThrow(expect.objectContaining({ kind: "schema", configName: "packs/de/rules.yaml" }));
    expect(() => loadPack("xx")).toThrow(ConfigError);
  });

  it("a bad ghost pattern is a ConfigError naming its path", () => {
    const dir = copyPack("de");
    fs.writeFileSync(path.join(dir, "rules.yaml"), "ghost:\n  evergreen_patterns:\n    - id: pool\n      pattern: '(unclosed'\n  exclude_context: ['[a-']\n");
    expect(() => loadPack("de")).toThrow(
      expect.objectContaining({
        kind: "schema",
        configName: "packs/de/rules.yaml",
        issues: expect.arrayContaining([expect.objectContaining({ path: "ghost.evergreen_patterns[0].pattern" }), expect.objectContaining({ path: "ghost.exclude_context[0]" })]),
      }),
    );
  });

  it("a pack without a ghost section reads as an empty one", () => {
    const dir = copyPack("de");
    fs.writeFileSync(path.join(dir, "rules.yaml"), "contract:\n  student: ['werkstudent']\n");
    expect(loadPack("de").rules.ghost).toEqual(emptyGhostPack());
    expect(ghostPackSchema.parse(undefined)).toEqual(emptyGhostPack());
  });
});

describe("the market", () => {
  it("takes the pack's values unless the settings name others", () => {
    const market = resolveMarket({ pack: "de" }, fixturePack);
    expect(market).toMatchObject({ packId: "de", country: "DE", currency: "EUR", homeLanguage: "de", locale: "de-DE", homeRegion: "eu" });
    expect(market.language?.code).toBe("de");
    const chf = resolveMarket({ pack: "de", currency: "CHF" }, fixturePack);
    expect(chf.currency).toBe("CHF");
  });

  it("switches the language step off when the local language is not the pack's", () => {
    expect(resolveMarket({ pack: "de", home_language: "en" }, fixturePack).language).toBeNull();
    expect(resolveMarket({ pack: "generic", country: "US", currency: "USD", home_language: "en" }, fixturePack).language).toBeNull();
  });

  it("is unresolved (never a fallback to generic) for an unknown pack, a missing value or an unknown country", () => {
    expect(() => resolveMarket({ pack: "xx" }, (id) => (id === "xx" ? loadPack("xx") : fixturePack(id)))).toThrow(MarketUnresolvedError);
    expect(() => resolveMarket({ pack: "generic" }, fixturePack)).toThrow(/names no country/);
    expect(() => resolveMarket({ pack: "generic", country: "ZZ", currency: "USD", home_language: "en" }, fixturePack)).toThrow(/not in the country table/);
  });

  it("loadPipeline fails closed when preferences.yaml is broken", () => {
    writePreferences("  pack: nowhere\n");
    expect(() => loadMarket()).toThrow(MarketUnresolvedError);
    expect(() => loadPipeline()).toThrow(MarketUnresolvedError);
    writePreferences("  pack: de\n");
    expect(loadPipeline().market.country).toBe("DE");
  });

  it("reads the template's market while preferences.yaml does not exist yet", () => {
    expect(loadMarket().packId).toBe("de");
  });
});

describe("the effective pipeline config", () => {
  it("unites the user's list entries with the packs' and lets the user's map keys win", () => {
    const file = shippedPipelineFile((raw) => {
      (raw.company as { legal_suffixes: string[] }).legal_suffixes = ["sagl"];
      (raw.filter as { city_aliases: Record<string, string[]> }).city_aliases = { München: ["Minga"] };
    });
    const effective = buildEffectivePipeline(file, fixtureMarket(), fixturePack);
    expect(effective.company.legal_suffixes).toEqual(expect.arrayContaining(["sagl", "gmbh", "llc"]));
    expect(effective.company.legal_suffixes[0]).toBe("sagl");
    expect(effective.filter.city_aliases.München).toEqual(["Minga"]);
    expect(effective.filter.metro_areas.Berlin).toContain("Potsdam");
  });

  it("unites the packs' closed_posting phrases (generic first, duplicates dropped)", () => {
    const withPhrases = (id: string): Pack => {
      const pack = fixturePack(id);
      const phrases = id === "de" ? ["nicht mehr verfügbar", "\\bno longer accepting applications\\b"] : ["\\bno longer accepting applications\\b"];
      return { ...pack, rules: { ...pack.rules, closed_posting: { phrases } } };
    };
    const de = buildEffectivePipeline(shippedPipelineFile(), fixtureMarket({ pack: "de" }), withPhrases);
    expect(de.closed_posting.phrases).toEqual(["\\bno longer accepting applications\\b", "nicht mehr verfügbar"]);
    const generic = buildEffectivePipeline(shippedPipelineFile(), fixtureMarket({ pack: "generic", country: "US", currency: "USD", home_language: "en" }), withPhrases);
    expect(generic.closed_posting.phrases).toEqual(["\\bno longer accepting applications\\b"]);
  });

  it("unites the packs' visa patterns (generic first, duplicates dropped); a pack without a visa section adds nothing", () => {
    const de = buildEffectivePipeline(shippedPipelineFile(), fixtureMarket({ pack: "de" }), fixturePack);
    const generic = fixturePack("generic").rules.visa;
    const german = fixturePack("de").rules.visa;
    expect(de.visa.offered.slice(0, generic.offered.length)).toEqual(generic.offered);
    expect(de.visa.offered).toHaveLength(generic.offered.length + german.offered.length);
    expect(de.visa.prefilter.filter((term) => term === "visa")).toHaveLength(1);
    expect(de.visa.prefilter).toEqual(expect.arrayContaining([...generic.prefilter, ...german.prefilter]));
    expect(de.visa.clause_breaks).toEqual([...generic.clause_breaks, ...german.clause_breaks]);
    expect(generic.clause_breaks.length).toBeGreaterThan(0);
    const withoutVisa = (id: string): Pack => {
      const pack = fixturePack(id);
      if (id !== "de") return pack;
      return { ...pack, rules: { ...pack.rules, visa: visaPackSchema.parse(undefined) } };
    };
    expect(visaPackSchema.parse(undefined)).toEqual(emptyVisaPack());
    expect(buildEffectivePipeline(shippedPipelineFile(), fixtureMarket({ pack: "de" }), withoutVisa).visa).toEqual(buildEffectivePipeline(shippedPipelineFile(), fixtureMarket({ pack: "generic", country: "US", currency: "USD", home_language: "en" }), fixturePack).visa);
  });

  it("unites the packs' ghost patterns; each evergreen pattern keeps its own pack's negation window", () => {
    const de = buildEffectivePipeline(shippedPipelineFile(), fixtureMarket({ pack: "de" }), fixturePack);
    const generic = fixturePack("generic").rules.ghost;
    const german = fixturePack("de").rules.ghost;
    expect(de.ghost.evergreen_patterns).toHaveLength(generic.evergreen_patterns.length + german.evergreen_patterns.length);
    expect(de.ghost.evergreen_patterns.slice(0, generic.evergreen_patterns.length).every((entry) => entry.negation_after === generic.negation_after)).toBe(true);
    expect(de.ghost.evergreen_patterns.slice(generic.evergreen_patterns.length).every((entry) => entry.negation_after === german.negation_after)).toBe(true);
    expect(de.ghost.lead_in_question.ends).toEqual(expect.arrayContaining(generic.lead_in_question.ends));
    const withoutGhost = (id: string): Pack => {
      const pack = fixturePack(id);
      return id === "de" ? { ...pack, rules: { ...pack.rules, ghost: emptyGhostPack() } } : pack;
    };
    expect(buildEffectivePipeline(shippedPipelineFile(), fixtureMarket({ pack: "de" }), withoutGhost).ghost).toEqual(buildEffectivePipeline(shippedPipelineFile(), fixtureMarket({ pack: "generic", country: "US", currency: "USD", home_language: "en" }), fixturePack).ghost);
  });

  it("unites the packs' clause exclusions and question tags", () => {
    const de = buildEffectivePipeline(shippedPipelineFile(), fixtureMarket({ pack: "de" }), fixturePack).ghost;
    const generic = fixturePack("generic").rules.ghost;
    const german = fixturePack("de").rules.ghost;
    expect(german.exclude_clause.length).toBeGreaterThan(0);
    expect(de.exclude_clause).toEqual([...generic.exclude_clause, ...german.exclude_clause]);
    expect(de.exclude_clause_ends).toEqual([...generic.exclude_clause_ends, ...german.exclude_clause_ends]);
    for (const key of ["breaks", "invitations", "openers", "markers"] as const) {
      expect(de.question_tag[key]).toEqual([...new Set([...generic.question_tag[key], ...german.question_tag[key]])]);
    }
  });

  it("has no German rules under a market without them", () => {
    const effective = buildEffectivePipeline(shippedPipelineFile(), fixtureMarket({ pack: "generic", country: "US", currency: "USD", home_language: "en" }), fixturePack);
    expect(effective.language.requirement).toBeNull();
    expect(effective.company.legal_suffixes).not.toContain("gmbh");
    expect(effective.filter.metro_areas).toEqual({});
    expect(Object.keys(effective.language.stopwords)).toEqual(["en"]);
  });
});

describe("marketSettingsProblems", () => {
  it("is empty for settings that resolve, and names the field that keeps others from resolving", () => {
    expect(marketSettingsProblems({ pack: "de" })).toEqual([]);
    expect(marketSettingsProblems({ pack: "generic", country: "US", currency: "USD", home_language: "en" })).toEqual([]);
    expect(marketSettingsProblems({ pack: "nowhere" })).toEqual([{ field: "pack", problem: "unknown" }]);
    expect(marketSettingsProblems({ pack: "generic" }).map((p) => `${p.field}:${p.problem}`)).toEqual(["country:missing", "currency:missing", "home_language:missing"]);
    expect(marketSettingsProblems({ pack: "de", country: "QQ" })).toEqual([{ field: "country", problem: "unknown" }]);
  });

  it("reports a broken pack file as invalid with a reason", () => {
    const dir = copyPack("de");
    fs.writeFileSync(path.join(dir, "pack.yaml"), "id: de\nname: [unclosed\n");
    resetPackCache();
    const [problem] = marketSettingsProblems({ pack: "de" });
    expect(problem).toMatchObject({ field: "pack", problem: "invalid" });
    expect(problem?.detail).toBeTruthy();
  });
});
