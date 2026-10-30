// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ZodError } from "zod";

import { configErrorDigest, configFileFromDigest } from "@/lib/config/error-digest";
import { jobSearchSchema, SEARCH_QUERY_MAX_CHARS } from "@/lib/config/schemas/job-search";

import { REPO_DEFAULTS_DIR } from "./helpers";

const fixture = () => ({
  query: { max_chars: 150, max_terms: 8, cjk_min_chars: 2, all_scope_timeout_ms: 5000 },
  matching: { prefix_min_chars: 5 },
  ranking: { weights: { title: 9, company: 6, location: 4, country: 2, description: 1, translation: 0 }, prefix_factor: 0.4 },
  countries: { name_locales: ["en", "zh-Hans"], ambiguous_codes: ["IT"], extra_aliases: { DE: ["Deutschland"] } },
  palette: { min_chars: 3, limit: 7 },
});

describe("job search config", () => {
  it("accepts the shipped YAML without depending on its values", () => {
    const input: unknown = parse(fs.readFileSync(path.join(REPO_DEFAULTS_DIR, "job-search.yaml"), "utf8"));
    expect(jobSearchSchema.safeParse(input).success).toBe(true);
    expect(configFileFromDigest(configErrorDigest("jobSearch"))).toBe("job-search.yaml");
  });

  it("accepts a complete input and requires every setting", () => {
    expect(jobSearchSchema.safeParse(fixture()).success).toBe(true);
    expect(jobSearchSchema.safeParse({ ...fixture(), query: { max_chars: 150 } }).success).toBe(false);
  });

  it("caps the query length at the shared limit and bounds the full-text time limit", () => {
    const query = (overrides: object) => jobSearchSchema.safeParse({ ...fixture(), query: { ...fixture().query, ...overrides } }).success;
    expect(query({ max_chars: SEARCH_QUERY_MAX_CHARS })).toBe(true);
    expect(query({ max_chars: SEARCH_QUERY_MAX_CHARS + 1 })).toBe(false);
    expect(query({ all_scope_timeout_ms: 0 })).toBe(false);
    expect(query({ all_scope_timeout_ms: 1.5 })).toBe(false);
  });

  it("rejects an illegal prefix threshold with a zod error", () => {
    expect(() => jobSearchSchema.parse({ ...fixture(), matching: { prefix_min_chars: 0 } })).toThrow(ZodError);
  });

  it.each([
    { ...fixture(), typo: true },
    { ...fixture(), query: { ...fixture().query, typo: true } },
    { ...fixture(), matching: { ...fixture().matching, typo: true } },
    { ...fixture(), ranking: { ...fixture().ranking, typo: true } },
    { ...fixture(), ranking: { ...fixture().ranking, weights: { ...fixture().ranking.weights, typo: 1 } } },
    { ...fixture(), countries: { ...fixture().countries, typo: true } },
    { ...fixture(), palette: { ...fixture().palette, typo: true } },
  ])("rejects unknown keys at every object level", (input) => {
    expect(jobSearchSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    { name_locales: [] }, { name_locales: ["not_a_locale"] },
    { ambiguous_codes: ["de"] }, { extra_aliases: { de: ["Germany"] } },
    { extra_aliases: { DE: [] } }, { extra_aliases: { DE: [" "] } },
  ])("rejects malformed country recognition settings", (overrides) => {
    expect(jobSearchSchema.safeParse({ ...fixture(), countries: { ...fixture().countries, ...overrides } }).success).toBe(false);
  });
});
