// @vitest-environment node
/** Channels bound to a market, and channel parameters that follow the market. */
import { describe, expect, it } from "vitest";

import { isOtherMarket, settingsFromConfig } from "@/lib/channels/registry";
import { resolveJobspySettings } from "@/lib/channels/jobspy/client";
import { buildDiscoveryInputs } from "@/lib/channels/linkedin/brightdata/contract";
import { locationFor } from "@/lib/channels/linkedin/apify/contract";

import { shippedChannels } from "../channels/helpers";
import { berlinQuery } from "../channels/linkedin/brightdata/helpers";
import { fixtureMarket } from "../pipeline/helpers";

const de = fixtureMarket();
const us = fixtureMarket({ pack: "generic", country: "US", currency: "USD", home_language: "en" });

describe("markets of a channel", () => {
  it("a channel without markets serves every market; one with markets only those", () => {
    expect(isOtherMarket(undefined, "US")).toBe(false);
    expect(isOtherMarket(["DE"], "DE")).toBe(false);
    expect(isOtherMarket(["DE"], "US")).toBe(true);
    expect(isOtherMarket(["DE"], null)).toBe(true); // no market: a market-bound channel does not run
  });

  it("the German job boards are on under the German market (the fixture's)", () => {
    const config = shippedChannels();
    const settings = settingsFromConfig("arbeitsagentur", config);
    expect(settings).toMatchObject({ enabled: true, otherMarket: false, markets: ["DE"] });
    expect(settingsFromConfig("greenhouse", config).otherMarket).toBe(false);
    expect(settingsFromConfig("arbeitnow", config)).toMatchObject({ enabled: true, otherMarket: false, markets: ["DE"] });
  });
});

describe("country parameters follow the market when empty", () => {
  it("jobspy: the Indeed country of the market, or the one configured", () => {
    const config = shippedChannels().jobspy;
    expect(resolveJobspySettings({ ...config, country_indeed: "" }, {}, us).country_indeed).toBe("usa");
    expect(resolveJobspySettings({ ...config, country_indeed: "" }, {}, de).country_indeed).toBe("germany");
    expect(resolveJobspySettings({ ...config, country_indeed: "austria" }, {}, us).country_indeed).toBe("austria");
  });

  it("bright data: the market's country for located queries, its name for the remote one", () => {
    const settings = { dataset_id: "d", cost_per_1k_usd: 1, poll_interval_ms: 1, timeout_ms: 2, remote_locations: {} };
    const [located] = buildDiscoveryInputs(berlinQuery(), settings, us);
    expect(located?.country).toBe("US");
    const [remote] = buildDiscoveryInputs(berlinQuery({ location: null, remote: true, remoteScope: "home_country" }), settings, us);
    expect(remote?.location).toBe("United States");
  });

  it("apify: the city with the market's country name", () => {
    const settings = shippedChannels().linkedin.apify;
    expect(locationFor(berlinQuery({ location: "Austin" }), { ...settings, country_name: "" } as Parameters<typeof locationFor>[1], us)).toBe("Austin, United States");
  });
});

describe("under another market", () => {
  it("leaves the German job boards out of the cycle (no run, so no failure) and keeps the others", async () => {
    const { makeTempConfig } = await import("../config/helpers");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { ChannelRegistry } = await import("@/lib/channels/registry");
    const { resetMarketCache } = await import("@/lib/market");
    const tmp = makeTempConfig();
    try {
      fs.mkdirSync(tmp.profileDir, { recursive: true });
      const template = fs.readFileSync(path.join(tmp.defaultsDir, "profile.example", "preferences.yaml"), "utf8");
      fs.writeFileSync(path.join(tmp.profileDir, "preferences.yaml"), template.replace(/market:\n(?:  .*\n)+/, "market:\n  pack: generic\n  country: US\n  currency: USD\n  home_language: en\n"));
      resetMarketCache();
      const registry = new ChannelRegistry();
      const channel = (id: string) => ({ id, family: "aggregator" as const, kind: "api" as const, usesQueries: true, collect: async () => [], parse: () => { throw new Error("unused"); } });
      registry.register(channel("arbeitsagentur") as never);
      registry.register(channel("greenhouse") as never);
      const config = shippedChannels();
      expect(settingsFromConfig("arbeitsagentur", config)).toMatchObject({ enabled: false, otherMarket: true });
      expect(settingsFromConfig("arbeitnow", config)).toMatchObject({ enabled: false, otherMarket: true });
      expect(registry.enabled(config).map((c) => c.id)).toEqual(["greenhouse"]);
    } finally {
      tmp.cleanup();
      resetMarketCache();
    }
  });
});
