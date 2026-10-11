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

function jsearchWith(edit: (block: Json) => void): Json {
  const raw = structuredClone(shippedYaml("sources.yaml")) as Json & { sources: Record<string, Json> };
  edit(raw.sources.jsearch ?? {});
  return raw;
}

describe("sources.yaml: sources.jsearch", () => {
  it("ships valid, with every tunable in config (C8)", () => {
    const parsed = configRegistry.channels.schema.parse(shippedYaml("sources.yaml"));
    expect(parsed.sources.jsearch).toMatchObject({
      enabled: false,
      api_base_url: "https://jsearch.p.rapidapi.com",
      country: "de",
      language: "",
      pages_per_query: 1,
      keywords_per_query: 1,
      monthly_request_limit: 200,
      overage_cost_per_request_usd: 0,
      pace_requests: true,
      fetch_details: false,
      max_details_per_query: 5,
      apply_publisher_preference: ["LinkedIn", "StepStone", "XING", "Indeed"],
      rate_limit_retries: 2,
    });
  });

  it("rejects bad values", () => {
    const bad = jsearchWith((b) => {
      Object.assign(b, {
        api_base_url: "jsearch.p.rapidapi.com",
        country: "DE",
        language: "english",
        pages_per_query: 21,
        keywords_per_query: 0,
        monthly_request_limit: 0,
        overage_cost_per_request_usd: -1,
        pace_requests: "yes",
        fetch_details: 1,
        max_details_per_query: -1,
        apply_publisher_preference: ["LinkedIn", "LinkedIn"],
        rate_limit_retries: 1.5,
      });
    });
    expect(issuePaths(bad)).toEqual(
      expect.arrayContaining(
        [
          "api_base_url",
          "country",
          "language",
          "pages_per_query",
          "keywords_per_query",
          "monthly_request_limit",
          "overage_cost_per_request_usd",
          "pace_requests",
          "fetch_details",
          "max_details_per_query",
          "apply_publisher_preference",
          "rate_limit_retries",
        ].map((key) => `sources.jsearch.${key}`),
      ),
    );
  });

  it("rejects a missing key and an unknown key", () => {
    expect(issuePaths(jsearchWith((b) => delete b.monthly_request_limit))).toEqual(["sources.jsearch.monthly_request_limit"]);
    expect(issuePaths(jsearchWith((b) => Object.assign(b, { api_key: "x" })))).toEqual(["sources.jsearch.api_key"]);
  });

  it("the overage budget still cannot exceed the paid total", () => {
    expect(issuePaths(jsearchWith((b) => Object.assign(b, { monthly_budget_usd: 99 })))).toEqual(["sources.jsearch.monthly_budget_usd"]);
  });
});
