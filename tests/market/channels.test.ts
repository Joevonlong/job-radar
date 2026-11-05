// @vitest-environment node
/** Channels bound to a market, and channel parameters that follow the market. */
import { describe, expect, it } from "vitest";

import { isOtherMarket, settingsFromConfig } from "@/lib/channels/registry";
import { resolveJobspySettings } from "@/lib/channels/jobspy/client";
import { buildDiscoveryInputs } from "@/lib/channels/linkedin/brightdata/contract";
import { locationFor } from "@/lib/channels/linkedin/apify/contract";
import { locationOf, type SessionSettings } from "@/lib/channels/linkedin/session/contract";
import { buildRequests } from "@/lib/channels/jsearch/query";
import { buildSearchRequest, collectFromJobspy, locationFor as jobspyLocationFor } from "@/lib/channels/jobspy/client";
import { foreignCountry, locatedText } from "@/lib/channels/query";

import { channelsWith, shippedChannels } from "../channels/helpers";
import { berlinQuery } from "../channels/linkedin/brightdata/helpers";
import { httpResponse, jobspyContext, jobspySettings } from "../channels/jobspy/helpers";
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
    expect(settingsFromConfig("berlinstartupjobs", config)).toMatchObject({ enabled: true, otherMarket: false, markets: ["DE"] });
    // Berlin Design Network discovery ships switched off, bound to the German market
    expect(settingsFromConfig("berlin_design_network", config)).toMatchObject({ enabled: false, otherMarket: false, markets: ["DE"] });
    // Handpicked Berlin is bound to the German market too, but ships switched off
    expect(settingsFromConfig("handpicked", config)).toMatchObject({ enabled: false, otherMarket: false, markets: ["DE"] });
    expect(settingsFromConfig("handpicked", channelsWith((raw) => { (raw.sources as Record<string, { enabled: boolean }>).handpicked!.enabled = true; }))).toMatchObject({ enabled: true, otherMarket: false });
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
    const [located] = buildDiscoveryInputs(berlinQuery({ country: "US" }), settings, us);
    expect(located?.country).toBe("US");
    const [remote] = buildDiscoveryInputs(berlinQuery({ location: null, remote: true, remoteScope: "home_country" }), settings, us);
    expect(remote?.location).toBe("United States");
  });

  it("apify: the city with the market's country name", () => {
    const settings = shippedChannels().linkedin.apify;
    expect(locationFor(berlinQuery({ location: "Austin", country: "US" }), { ...settings, country_name: "" } as Parameters<typeof locationFor>[1], us)).toBe("Austin, United States");
  });
});

describe("a place abroad", () => {
  const abroad = berlinQuery({ location: "Amsterdam", country: "NL" });
  const remotePlace = berlinQuery({ location: "Amsterdam", country: "NL", remote: true, remoteScope: null });
  const nl = de.countries.find((country) => country.code === "NL");

  it("reads as the place with its own country, and alone when it is the country or has none", () => {
    expect(nl?.name).toBeDefined();
    expect(locatedText(abroad, "Germany", de)).toBe(`Amsterdam, ${nl?.name}`);
    expect(locatedText(berlinQuery({ location: "Berlin", country: "DE" }), "Germany", de)).toBe("Berlin, Germany");
    expect(locatedText(berlinQuery({ location: "Germany", country: "DE" }), "Germany", de)).toBe("Germany");
    expect(locatedText(berlinQuery({ location: "Poing", country: null }), "Germany", de)).toBe("Poing");
    expect(locatedText(berlinQuery({ location: de.countryName, country: de.country }), "Deutschland", de)).toBe(de.countryName);
  });

  it("is a foreign country only outside home", () => {
    expect(foreignCountry(abroad, de)).toBe("NL");
    expect(foreignCountry(berlinQuery({ country: "DE" }), de)).toBeNull();
    expect(foreignCountry(berlinQuery({ country: null }), de)).toBeNull();
  });

  it("every board with a location field searches the place of a remote query", () => {
    const apify = { ...shippedChannels().linkedin.apify, country_name: "" } as Parameters<typeof locationFor>[1];
    const session = { site: { remote_locations: {}, country_name: "" } } as unknown as SessionSettings;
    const brightdata = { dataset_id: "d", cost_per_1k_usd: 1, poll_interval_ms: 1, timeout_ms: 2, remote_locations: {} };
    expect(locationFor(remotePlace, apify, de)).toBe("Amsterdam");
    expect(locationOf(remotePlace, session, de)).toBe("Amsterdam");
    expect(buildDiscoveryInputs(remotePlace, brightdata, de)[0]?.location).toBe("Amsterdam");
    expect(jobspyLocationFor(remotePlace, jobspySettings())).toBe("Amsterdam");
  });

  it("boards with a country field send its country; apify and session the text", () => {
    const brightdata = { dataset_id: "d", cost_per_1k_usd: 1, poll_interval_ms: 1, timeout_ms: 2, remote_locations: {} };
    expect(buildDiscoveryInputs(abroad, brightdata, de)[0]?.country).toBe("NL");
    expect(buildRequests(abroad, { keywords_per_query: 3 }, "Germany", "DE")[0]?.country).toBe("nl");
    expect(buildRequests(berlinQuery({ country: "DE" }), { keywords_per_query: 3 }, "Germany", "DE")[0]?.country).toBeUndefined();
    expect(buildSearchRequest("indeed", abroad, jobspySettings()).country_indeed).toBe(nl?.indeed);
    const apify = { ...shippedChannels().linkedin.apify, country_name: "" } as Parameters<typeof locationFor>[1];
    expect(locationFor(abroad, apify, de)).toBe(`Amsterdam, ${nl?.name}`);
  });

  it("Indeed finds nothing where it has no site, without calling the sidecar or failing", async () => {
    const settings = jobspySettings({ market: { ...de, countries: de.countries.map((country) => (country.code === "NL" ? { ...country, indeed: "" } : country)) } });
    const { ctx, calls } = jobspyContext(() => httpResponse(500, {}));
    await expect(collectFromJobspy("indeed", abroad, ctx, settings)).resolves.toEqual([]);
    expect(calls).toEqual([]);
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
      expect(settingsFromConfig("handpicked", config)).toMatchObject({ enabled: false, otherMarket: true });
      expect(settingsFromConfig("berlin_design_network", config)).toMatchObject({ enabled: false, otherMarket: true });
      expect(settingsFromConfig("berlinstartupjobs", config)).toMatchObject({ enabled: false, otherMarket: true });
      expect(registry.enabled(config).map((c) => c.id)).toEqual(["greenhouse"]);
    } finally {
      tmp.cleanup();
      resetMarketCache();
    }
  });
});
