// @vitest-environment node
import { describe, expect, it } from "vitest";

import { configRegistry, companiesSchema } from "@/lib/config";

import { shippedYaml } from "./helpers";

const INCLUDE = ["AI", "ML", "KI", "LLM", "GenAI", "Machine Learning", "Applied Scientist", "Forward Deployed"];
const EXCLUDE = ["Werkstudent", "Working Student", "Intern", "Internship", "Praktikum", "Praktikant"];

type Json = Record<string, unknown>;

function issuePaths(name: "channels" | "companies", input: unknown): string[] {
  const result = (name === "channels" ? configRegistry.channels.schema : companiesSchema).safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((i) => (i.code === "unrecognized_keys" ? [...i.path, ...i.keys].join(".") : i.path.join(".")));
}

function channels(edit: (sources: Record<string, Json>) => void): Json {
  const raw = structuredClone(shippedYaml("sources.yaml")) as Json & { sources: Record<string, Json> };
  edit(raw.sources);
  return raw;
}

describe("sources.yaml: ats channels", () => {
  it("ships the prefilter on with the agreed term lists, and the API hosts in config (C8)", () => {
    const parsed = configRegistry.channels.schema.parse(shippedYaml("sources.yaml"));
    expect(parsed.sources.greenhouse).toMatchObject({
      api_base_url: "https://boards-api.greenhouse.io",
      title_prefilter: { enabled: true, include_terms: INCLUDE, exclude_terms: EXCLUDE },
    });
    expect(parsed.sources.lever).toMatchObject({
      api_base_url: "https://api.lever.co",
      eu_api_base_url: "https://api.eu.lever.co",
      title_prefilter: { enabled: true, include_terms: INCLUDE, exclude_terms: EXCLUDE },
    });
  });

  it("rejects a missing or malformed prefilter block and bad hosts", () => {
    const noPrefilter = channels((s) => { delete s.greenhouse?.title_prefilter; });
    expect(issuePaths("channels", noPrefilter)).toEqual(["sources.greenhouse.title_prefilter"]);
    const bad = channels((s) => {
      if (s.lever) {
        s.lever.title_prefilter = { enabled: "yes", include_terms: ["a", "a"], exclude_terms: [""], extra: 1 };
        s.lever.eu_api_base_url = "ftp://example.test";
      }
    });
    const paths = issuePaths("channels", bad);
    expect(paths).toEqual(expect.arrayContaining([
      "sources.lever.title_prefilter.enabled",
      "sources.lever.title_prefilter.include_terms",
      "sources.lever.title_prefilter.exclude_terms.0",
      "sources.lever.title_prefilter.extra",
      "sources.lever.eu_api_base_url",
    ]));
  });

  it("rejects an unknown key on the greenhouse block (no eu host there)", () => {
    const bad = channels((s) => { if (s.greenhouse) s.greenhouse.eu_api_base_url = "https://x.test"; });
    expect(issuePaths("channels", bad)).toEqual(["sources.greenhouse.eu_api_base_url"]);
  });
});

describe("sources.yaml ats_boards: region", () => {
  const companies = (entries: Json[]): Json => ({ companies: entries });

  it("accepts region on lever boards only", () => {
    expect(issuePaths("companies", companies([{ name: "A", ats: "lever", token: "a", enabled: true, region: "eu" }]))).toEqual([]);
    expect(issuePaths("companies", companies([{ name: "A", ats: "lever", token: "a", enabled: true, region: "global" }]))).toEqual([]);
    expect(issuePaths("companies", companies([{ name: "A", ats: "greenhouse", token: "a", enabled: true, region: "eu" }]))).toEqual(["companies.0.region"]);
    expect(issuePaths("companies", companies([{ name: "A", ats: "lever", token: "a", enabled: true, region: "mars" }]))).toEqual(["companies.0.region"]);
  });
});
