// @vitest-environment node
import { describe, expect, it } from "vitest";

import { configRegistry } from "@/lib/config";

import { shippedYaml } from "./helpers";

type Json = Record<string, unknown>;

function issuePaths(input: unknown): string[] {
  const result = configRegistry.channels.schema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((i) => (i.code === "unrecognized_keys" ? [...i.path, ...i.keys].join(".") : i.path.join(".")));
}

function channels(edit: (sources: Record<string, Json>) => void): Json {
  const raw = structuredClone(shippedYaml("sources.yaml")) as Json & { sources: Record<string, Json> };
  edit(raw.sources);
  return raw;
}

describe("sources.yaml: ashby, personio, smartrecruiters, brave", () => {
  const parsed = configRegistry.channels.schema.parse(shippedYaml("sources.yaml"));

  it("ships the four channels on, with their hosts and tunables in config (C8)", () => {
    expect(parsed.sources.ashby).toMatchObject({ enabled: true, api_base_url: "https://api.ashbyhq.com", include_compensation: true });
    expect(parsed.sources.personio).toMatchObject({ enabled: true, api_base_url: "https://{token}.jobs.personio.de", language: "en" });
    expect(parsed.sources.smartrecruiters).toMatchObject({ enabled: true, api_base_url: "https://api.smartrecruiters.com", country: "de", page_size: 100, fetch_details: true });
    expect(parsed.sources.brave).toMatchObject({ enabled: false, api_base_url: "https://api.search.brave.com", country: "DE", safesearch: "strict", interval_hours: 20, max_queries_per_run: 40 });
    for (const id of ["ashby", "personio", "smartrecruiters"] as const) {
      expect(parsed.sources[id].title_prefilter.enabled).toBe(true);
    }
  });

  it("rejects bad values", () => {
    const bad = channels((s) => {
      Object.assign(s.ashby ?? {}, { include_compensation: "yes" });
      Object.assign(s.personio ?? {}, { api_base_url: "https://jobs.personio.de", language: "fr" });
      Object.assign(s.smartrecruiters ?? {}, { country: "DE", page_size: 101, fetch_details: 1 });
      Object.assign(s.brave ?? {}, { country: "de", safesearch: "none", interval_hours: 0, max_queries_per_run: 0 });
    });
    expect(issuePaths(bad)).toEqual(
      expect.arrayContaining([
        "sources.ashby.include_compensation",
        "sources.personio.api_base_url",
        "sources.personio.language",
        "sources.smartrecruiters.country",
        "sources.smartrecruiters.page_size",
        "sources.smartrecruiters.fetch_details",
        "sources.brave.country",
        "sources.brave.safesearch",
        "sources.brave.interval_hours",
        "sources.brave.max_queries_per_run",
      ]),
    );
  });

  it("rejects a missing prefilter block and unknown keys", () => {
    const bad = channels((s) => {
      delete s.ashby?.title_prefilter;
      Object.assign(s.brave ?? {}, { title_prefilter: {} });
    });
    expect(issuePaths(bad)).toEqual(expect.arrayContaining(["sources.ashby.title_prefilter", "sources.brave.title_prefilter"]));
  });
});

describe("sources.yaml ats_boards: boards of the new ATS", () => {
  const companies = configRegistry.channels.schema.parse(shippedYaml("sources.yaml")).ats_boards;

  it.each(["ashby", "personio", "smartrecruiters"] as const)("lists at least 5 enabled %s boards", (ats) => {
    expect(companies.filter((c) => c.ats === ats && c.enabled).length).toBeGreaterThanOrEqual(5);
  });
});

describe("sources.yaml: tavily replaces brave as the default search backend", () => {
  const parsed = configRegistry.channels.schema.parse(shippedYaml("sources.yaml"));

  it("ships tavily on and brave off, with the credit budget in config (C8)", () => {
    expect(parsed.sources.tavily).toMatchObject({
      enabled: true,
      api_base_url: "https://api.tavily.com",
      search_depth: "basic",
      max_results: 20,
      monthly_credit_limit: 1000,
      credit_cost_usd: 0,
      monthly_budget_usd: 0,
    });
    expect(parsed.sources.brave.enabled).toBe(false);
  });

  it("rejects bad values and unknown keys", () => {
    const bad = channels((s) => {
      Object.assign(s.tavily ?? {}, { max_results: 21, search_depth: "deep", keywords_per_query: 0, monthly_credit_limit: 0, credit_cost_usd: -1, interval_hours: 0, title_prefilter: {} });
    });
    expect(issuePaths(bad)).toEqual(
      expect.arrayContaining([
        "sources.tavily.max_results",
        "sources.tavily.search_depth",
        "sources.tavily.keywords_per_query",
        "sources.tavily.monthly_credit_limit",
        "sources.tavily.credit_cost_usd",
        "sources.tavily.interval_hours",
        "sources.tavily.title_prefilter",
      ]),
    );
  });
});
