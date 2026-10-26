// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildActorInputs } from "@/lib/channels/linkedin/apify/contract";
import { monidSettingsSchema } from "@/lib/channels/linkedin/monid/contract";

import { fixtureMarket } from "../../../pipeline/helpers";
import { harness, query, settings } from "./helpers";

describe("Monid input templates", () => {
  it("substitutes inside arrays, OR-merges keywords, and follows the same market as Apify", () => {
    expect(buildActorInputs(query(), settings(), 7, fixtureMarket())).toEqual([{
      jobTitles: ['"Platform Engineer" OR "Infrastructure Engineer"'], locations: ["Example City, Germany"], maxItems: 7, postedLimit: "24h", sortBy: "date",
    }]);
    const remote = buildActorInputs(query({ remote: true, remoteScope: "worldwide", location: null }), settings(), 7, fixtureMarket())[0];
    expect(remote).toMatchObject({ locations: ["Worldwide"], workplaceType: ["remote"] });
  });

  it.each([[10, "24h"], [24, "24h"], [25, "week"], [169, "month"], [721, undefined]])("maps a %i hour window", (windowHours, postedLimit) => {
    const input = buildActorInputs(query({ windowHours }), settings(), 2, fixtureMarket())[0];
    expect(input?.postedLimit).toBe(postedLimit);
    if (postedLimit === undefined) expect(input).not.toHaveProperty("postedLimit");
  });

  it("splits oversized OR groups and respects explicit country and remote locations", () => {
    const keywords = Array.from({ length: 12 }, (_, i) => `Platform Infrastructure Engineer ${i}`);
    const inputs = buildActorInputs(query({ keywords }), settings({ country_name: "Example Country" }), 3, fixtureMarket());
    expect(inputs.length).toBeGreaterThan(1);
    for (const input of inputs) {
      expect(String((input.jobTitles as string[])[0]).length).toBeLessThanOrEqual(200);
      expect(input.locations).toEqual(["Example City, Example Country"]);
    }
    expect(buildActorInputs(query({ remote: true, location: null, remoteScope: "home_country" }), settings({ remote_locations: { home_country: "Remote Example" } }), 3, fixtureMarket())[0]?.locations).toEqual(["Remote Example"]);
  });

  it.each([
    { jobTitles: ["A", "B"] }, { locations: ["A", "B"] }, { maxItems: 0 }, { maxItems: 99 },
  ])("refuses unsafe templates before sending: %j", async (override) => {
    for (const remote of [false, true]) {
      const block = settings(remote ? { remote_input: override } : { input_template: { ...settings().input_template, ...override } });
      const h = await harness([], { settings: block });
      await expect(h.channel.collect(query({ remote, location: remote ? null : "Example City" }), h.ctx)).rejects.toMatchObject({ code: "unknown", retryable: false });
      expect(h.requests).toHaveLength(0);
    }
  });

  it("uses a strict config block and validates positive times and nonnegative prices", () => {
    for (const override of [{ surprise: true }, { timeout_ms: 0 }, { poll_interval_ms: 21 }, { stop_grace_ms: 0 }, { price_per_1k_usd: -1 }, { flat_fee_usd: -1 }, { throttle: { min_delay_ms: 2, max_delay_ms: 1 } }]) {
      expect(monidSettingsSchema.safeParse({ ...settings(), ...override }).success).toBe(false);
    }
  });
});
