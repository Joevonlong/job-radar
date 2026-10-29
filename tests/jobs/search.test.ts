// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { loadConfig, reloadConfig } from "@/lib/config";
import { buildSearchPlan, buildSearchPlanLenient, jobSearchSettings } from "@/lib/jobs/search";
import * as query from "@/lib/jobs/search-query";
import * as market from "@/lib/market";

import { makeTempConfig, type TempConfig } from "../config/helpers";

let tmp: TempConfig;
beforeEach(() => {
  tmp = makeTempConfig();
  fs.writeFileSync(path.join(tmp.configDir, "job-search.yaml"), stringify({
    query: { max_chars: 120, max_terms: 3, cjk_min_chars: 2, all_scope_timeout_ms: 4000 },
    matching: { prefix_min_chars: 5 },
    ranking: { weights: { title: 9, company: 6, location: 4, country: 2, description: 1, translation: 1 }, prefix_factor: 0.5 },
    countries: { name_locales: ["en", "zh"], ambiguous_codes: ["IT", "IN"], extra_aliases: { DE: ["Example country alias"] } },
    palette: { min_chars: 3, limit: 6 },
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  tmp.cleanup();
});

describe("server search entry", () => {
  it("uses loaded settings and market data, reusing the country lexicon", () => {
    const build = vi.spyOn(query, "buildCountryLexicon");
    expect(buildSearchPlan("Example country alias").terms).toMatchObject([{ countryCodes: ["DE"], countryOnly: false }]);
    expect(buildSearchPlan("德国").terms[0]?.countryCodes).toEqual(["DE"]);
    expect(buildSearchPlan("four").terms[0]?.match).toBe("whole");
    expect(build).toHaveBeenCalledTimes(1);
    expect(buildSearchPlan("AI").ranking).toEqual({ weights: jobSearchSettings().ranking.weights, prefixFactor: 0.5 });
    expect(buildSearchPlan("AI").allScopeTimeoutMs).toBe(4000);
    expect(jobSearchSettings()).toBe(loadConfig("jobSearch"));
  });

  it("keeps text search for the MCP server when pipeline.yaml does not load", () => {
    vi.spyOn(market, "loadPipeline").mockImplementation(() => { throw new Error("pipeline.yaml is invalid"); });
    expect(() => buildSearchPlan("Germany engineer")).toThrow();
    expect(buildSearchPlanLenient("Germany engineer")).toMatchObject({ status: "ok", terms: [{ text: "germany", countryCodes: [] }, { text: "engineer" }] });
  });

  it("rebuilds after either config identity changes", () => {
    const build = vi.spyOn(query, "buildCountryLexicon");
    buildSearchPlan("Germany");
    const settings = structuredClone(jobSearchSettings());
    settings.countries.extra_aliases.DE = ["Changed country alias"];
    fs.writeFileSync(path.join(tmp.configDir, "job-search.yaml"), stringify(settings));
    reloadConfig("jobSearch");
    expect(buildSearchPlan("Changed country alias").terms).toMatchObject([{ countryCodes: ["DE"] }]);
    expect(build).toHaveBeenCalledTimes(2);

    const pipeline = structuredClone(loadConfig("pipeline"));
    pipeline.filter.city_aliases = { Exampletown: ["Exampleville"] };
    fs.writeFileSync(path.join(tmp.configDir, "pipeline.yaml"), stringify(pipeline));
    reloadConfig("pipeline");
    expect(buildSearchPlan("Exampleville").terms[0]?.locationVariants).toEqual(["exampleville", "exampletown"]);
    expect(build).toHaveBeenCalledTimes(3);
  });
});
