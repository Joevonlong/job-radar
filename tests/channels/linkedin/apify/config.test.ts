// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ACTOR_ID_PATTERN, apifySettingsSchema, buildActorInputs, remoteTemplate, type ApifySettings } from "@/lib/channels/linkedin/apify";
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
      { keywords: '"AI Engineer" OR "LLM Engineer"', location: "Berlin, Germany", urlParam: [{ key: "f_TPR", value: "r86400" }], limit: 25 },
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

describe("buildActorInputs: the exact window", () => {
  const template = { keywords: "{keywords}", urlParam: [{ key: "f_TPR", value: "r{posted_within_seconds}" }], limit: "{limit}" };
  const settings = (over: Partial<ApifySettings> = {}): ApifySettings => ({
    ...apifySettingsSchema.parse(apifySettings().extra),
    input_template: template,
    remote_input: { urlParam: [{ key: "f_WT", value: "2" }] },
    ...over,
  });
  const remote = { ...berlinQuery(), remote: true, location: null, remoteScope: "worldwide" as const };
  const urlParam = (input: Record<string, unknown> | undefined) => input?.urlParam;

  it.each([
    [10, "r36000"],
    [24, "r86400"],
    [36, "r129600"],
    [1000, "r3600000"],
    [0.0001, "r1"],
  ])("requests a %s hour window as %s", (windowHours, value) => {
    const [input] = buildActorInputs({ ...berlinQuery(), windowHours }, settings(), 5, fixtureMarket());
    expect(urlParam(input)).toEqual([{ key: "f_TPR", value }]);
  });

  it("never sends a date_posted key or a sort for the exact-window template", () => {
    const [input] = buildActorInputs(berlinQuery(), settings(), 5, fixtureMarket());
    expect(input).not.toHaveProperty("datePosted");
    expect(JSON.stringify(input)).not.toContain("sortBy");
  });

  it("keeps the template's window on a remote query and adds the remote parameter", () => {
    const [input] = buildActorInputs({ ...remote, windowHours: 10 }, settings(), 5, fixtureMarket());
    expect(urlParam(input)).toEqual([{ key: "f_TPR", value: "r36000" }, { key: "f_WT", value: "2" }]);
  });

  it("lets a remote entry win over the template entry with the same key", () => {
    const [input] = buildActorInputs(remote, settings({ remote_input: { urlParam: [{ key: "f_TPR", value: "r60" }] } }), 5, fixtureMarket());
    expect(urlParam(input)).toEqual([{ key: "f_TPR", value: "r60" }]);
  });

  it("treats an empty remote list as no change, the window stays", () => {
    const [input] = buildActorInputs({ ...remote, windowHours: 10 }, settings({ remote_input: { urlParam: [] } }), 5, fixtureMarket());
    expect(urlParam(input)).toEqual([{ key: "f_TPR", value: "r36000" }]);
  });

  it("lets a list of another shape replace the template's list", () => {
    const [input] = buildActorInputs(remote, settings({ remote_input: { urlParam: ["f_WT=2"] } }), 5, fixtureMarket());
    expect(urlParam(input)).toEqual(["f_WT=2"]);
  });

  it("still replaces any other kind of value", () => {
    expect(remoteTemplate({ locations: ["{location}"], a: 1 }, { locations: ["Remote"], a: 2 })).toEqual({ locations: ["Remote"], a: 2 });
    expect(remoteTemplate({ list: [{ key: "x", value: "1" }] }, { list: "none" })).toEqual({ list: "none" });
  });

  it("leaves an old template as it was: coarse filter, and the remote list as the only urlParam", () => {
    const old = settings({ input_template: { keywords: "{keywords}", datePosted: "{date_posted}", limit: "{limit}" } });
    const [city] = buildActorInputs({ ...berlinQuery(), windowHours: 10 }, old, 5, fixtureMarket());
    expect(city).toEqual({ keywords: expect.any(String), datePosted: "r86400", limit: 5 });
    const [remoteInput] = buildActorInputs({ ...remote, windowHours: 10 }, old, 5, fixtureMarket());
    expect(remoteInput).toMatchObject({ datePosted: "r86400", urlParam: [{ key: "f_WT", value: "2" }] });
  });
});
