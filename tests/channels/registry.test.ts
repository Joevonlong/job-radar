// @vitest-environment node
import { describe, expect, it } from "vitest";

import { CHANNEL_CONFIG_TABLE, ChannelRegistry, settingsFromConfig, type ConfiguredChannelId } from "@/lib/channels/registry";
import { createFixtureChannel, FIXTURE_SETTINGS } from "@/lib/channels/fixture";

import { channelsWith, shippedChannels } from "./helpers";

describe("CHANNEL_CONFIG_TABLE", () => {
  it("maps every block of sources.yaml to exactly one channel id", () => {
    const config = shippedChannels();
    const expected = [
      ...["brightdata", "apify", "session", "guest"].map((k) => `linkedin.${k}`),
      ...Object.keys(config.sources).map((k) => `sources.${k}`),
    ].sort();
    // the "recommended for you" side channel is a second channel on the linkedin.session block
    const mapped = [...new Set(Object.values(CHANNEL_CONFIG_TABLE).map((ref) => `${ref.section}.${ref.key}`))].sort();
    expect(mapped).toEqual(expected);
  });

  it("uses the documented ids for LinkedIn and the config key for sources", () => {
    expect(CHANNEL_CONFIG_TABLE["linkedin-brightdata"]).toEqual({ section: "linkedin", key: "brightdata" });
    expect(CHANNEL_CONFIG_TABLE["linkedin-guest"]).toEqual({ section: "linkedin", key: "guest" });
    expect(CHANNEL_CONFIG_TABLE["linkedin-session:recommended"]).toEqual({ section: "linkedin", key: "session", view: "recommended" });
    expect(CHANNEL_CONFIG_TABLE.arbeitsagentur).toEqual({ section: "sources", key: "arbeitsagentur" });
    expect(CHANNEL_CONFIG_TABLE.greenhouse).toEqual({ section: "sources", key: "greenhouse" });
  });

  it("covers every id in the LinkedIn cascade", () => {
    for (const id of shippedChannels().linkedin.cascade) expect(id in CHANNEL_CONFIG_TABLE).toBe(true);
  });
});

describe("settingsFromConfig", () => {
  const config = shippedChannels();

  it("reads enabled, limits, throttle and the free allowance", () => {
    expect(settingsFromConfig("linkedin-brightdata", config)).toMatchObject({
      enabled: true,
      maxResults: 300,
      monthlyBudgetUsd: 5,
      freeRecordsPerMonth: 5000,
      throttle: { minDelayMs: 500, maxDelayMs: 1500 },
    });
    expect(settingsFromConfig("linkedin-apify", config)).toMatchObject({ enabled: true, monthlyBudgetUsd: 10, freeRecordsPerMonth: 0 }); // on; without APIFY_TOKEN the cascade skips it
    expect(settingsFromConfig("linkedin-session", config).enabled).toBe(false);
    expect(settingsFromConfig("arbeitsagentur", config)).toMatchObject({ enabled: true, freeRecordsPerMonth: 0, monthlyBudgetUsd: 0 });
  });

  it("exposes the raw block for channel-specific keys", () => {
    expect(settingsFromConfig("linkedin-apify", config).extra).toHaveProperty("actor_id");
    expect(settingsFromConfig("linkedin-session", config).extra).toHaveProperty("recommended_daily");
  });
});

describe("ChannelRegistry", () => {
  it("registers channels that have a config entry and rejects unknown ids and duplicates", () => {
    const registry = new ChannelRegistry();
    const known = createFixtureChannel({ id: "arbeitsagentur" });
    registry.register(known);
    expect(registry.has("arbeitsagentur")).toBe(true);
    expect(registry.get("arbeitsagentur")).toBe(known);
    expect(() => registry.register(createFixtureChannel({ id: "arbeitsagentur" }))).toThrow(/already registered/);
    expect(() => registry.register(createFixtureChannel({ id: "mystery" }))).toThrow(/CHANNEL_CONFIG_TABLE/);
  });

  it("takes enabled-ness from sources.yaml, not from the code", () => {
    const registry = new ChannelRegistry();
    registry.register(createFixtureChannel({ id: "arbeitsagentur" }));
    registry.register(createFixtureChannel({ id: "jsearch" }));
    expect(registry.enabled(shippedChannels()).map((c) => c.id)).toEqual(["arbeitsagentur"]);
    const flipped = channelsWith((raw) => {
      (raw.sources as Record<string, { enabled: boolean }>).arbeitsagentur!.enabled = false;
      (raw.sources as Record<string, { enabled: boolean }>).jsearch!.enabled = true;
    });
    expect(registry.enabled(flipped).map((c) => c.id)).toEqual(["jsearch"]);
  });

  it("lets test channels bring their own settings", () => {
    const registry = new ChannelRegistry();
    registry.register(createFixtureChannel(), { settings: { ...FIXTURE_SETTINGS, maxResults: 7 } });
    expect(registry.settingsFor("fixture", shippedChannels())?.maxResults).toBe(7);
    expect(registry.isEnabled("fixture", shippedChannels())).toBe(true);
    expect(registry.settingsFor("nope", shippedChannels())).toBeUndefined();
    expect(registry.isEnabled("nope", shippedChannels())).toBe(false);
  });

  it("types ConfiguredChannelId as the table keys", () => {
    const id: ConfiguredChannelId = "linkedin-session";
    expect(CHANNEL_CONFIG_TABLE[id].section).toBe("linkedin");
  });
});
