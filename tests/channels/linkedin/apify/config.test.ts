// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ACTOR_ID_PATTERN, apifySettingsSchema, buildActorInputs } from "@/lib/channels/linkedin/apify";
import { configRegistry } from "@/lib/config";

import { shippedYaml } from "../../../config/helpers";
import { apifySettings, berlinQuery } from "./helpers";
import { fixtureMarket } from "../../../pipeline/helpers";

function edited(edit: (block: Record<string, unknown>) => void) {
  const raw = structuredClone(shippedYaml("sources.yaml"));
  edit((raw.linkedin as Record<string, Record<string, unknown>>).apify as Record<string, unknown>);
  return configRegistry.channels.schema.safeParse(raw);
}

const paths = (r: ReturnType<typeof edited>) => (r.success ? [] : r.error.issues.map((i) => i.path.join(".")));

describe("sources.yaml linkedin.apify", () => {
  it("ships the researched default actor, on, and satisfies the channel's own settings schema", () => {
    const settings = apifySettings();
    expect(settings).toMatchObject({ enabled: true, monthlyBudgetUsd: 10, freeRecordsPerMonth: 0 });
    const parsed = apifySettingsSchema.parse(settings.extra);
    expect(parsed).toMatchObject({ actor_id: "valig/linkedin-jobs-scraper", price_per_1k_usd: 0.4, run_start_usd: 0.001, timeout_secs: 300 });
    // the shipped template yields a complete input
    expect(buildActorInputs(berlinQuery(), parsed, 25, fixtureMarket())).toEqual([
      { keywords: '"AI Engineer" OR "LLM Engineer"', location: "Berlin, Germany", datePosted: "r86400", limit: 25 },
    ]);
  });

  it("rejects bad values with the field path", () => {
    expect(paths(edited((b) => (b.price_per_1k_usd = -1)))).toEqual(["linkedin.apify.price_per_1k_usd"]);
    expect(paths(edited((b) => (b.actor_id = "not an actor")))).toEqual(["linkedin.apify.actor_id"]);
    expect(paths(edited((b) => (b.timeout_secs = 301)))).toEqual(["linkedin.apify.timeout_secs"]); // Apify's synchronous limit
    expect(paths(edited((b) => (b.memory_mb = 0)))).toEqual(["linkedin.apify.memory_mb"]);
    expect(paths(edited((b) => (b.api_base_url = "ftp://x")))).toEqual(["linkedin.apify.api_base_url"]);
    expect(paths(edited((b) => delete b.input_template))).toEqual(["linkedin.apify.input_template"]);
    expect(paths(edited((b) => (b.surprise = 1)))).toEqual(["linkedin.apify"]);
  });

  it("accepts an empty actor id (not configured) and the id forms Apify uses", () => {
    expect(edited((b) => (b.actor_id = "")).success).toBe(true);
    for (const ok of ["valig/linkedin-jobs-scraper", "valig~linkedin-jobs-scraper", "RIGGeqD6RqKmlVoQU", ""]) expect(ACTOR_ID_PATTERN.test(ok)).toBe(true);
    for (const bad of ["a/b/c", "/x", "x/", "two words/x", "short"]) expect(ACTOR_ID_PATTERN.test(bad)).toBe(false);
  });

  it("keeps the monthly budget under the global paid cap", () => {
    expect(paths(edited((b) => (b.monthly_budget_usd = 16)))).toContain("linkedin.apify.monthly_budget_usd");
  });
});
