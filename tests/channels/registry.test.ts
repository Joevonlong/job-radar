// @vitest-environment node
import { describe, expect, it } from "vitest";

import { CHANNEL_CONFIG_TABLE, channelSupportsCompanyQueries, channelUsesQueries, ChannelRegistry, settingsFromConfig, type ConfiguredChannelId } from "@/lib/channels/registry";
import { registerBuiltinChannels } from "@/lib/channels/builtin";
import { createFixtureChannel, FIXTURE_SETTINGS } from "@/lib/channels/fixture";

import { channelsWith, shippedChannels } from "./helpers";

describe("CHANNEL_CONFIG_TABLE", () => {
  it("maps every block of sources.yaml to exactly one channel id", () => {
    const config = shippedChannels();
    const expected = [
      ...["brightdata", "apify", "monid", "session", "guest"].map((k) => `linkedin.${k}`),
      ...Object.keys(config.sources).map((k) => `sources.${k}`),
    ].sort();
    // the "recommended for you" side channel is a second channel on the linkedin.session block
    const mapped = [...new Set(Object.values(CHANNEL_CONFIG_TABLE).map((ref) => `${ref.section}.${ref.key}`))].sort();
    expect(mapped).toEqual(expected);
  });

  it("uses the documented ids for LinkedIn and the config key for sources", () => {
    expect(CHANNEL_CONFIG_TABLE["linkedin-brightdata"]).toEqual({ section: "linkedin", key: "brightdata", supportsCompanyQueries: true });
    expect(CHANNEL_CONFIG_TABLE["linkedin-monid"]).toEqual({ section: "linkedin", key: "monid" });
    expect(CHANNEL_CONFIG_TABLE["linkedin-guest"]).toEqual({ section: "linkedin", key: "guest", supportsCompanyQueries: true });
    expect(CHANNEL_CONFIG_TABLE["linkedin-session:recommended"]).toEqual({ section: "linkedin", key: "session", view: "recommended", usesQueries: false });
    expect(CHANNEL_CONFIG_TABLE.arbeitsagentur).toEqual({ section: "sources", key: "arbeitsagentur", supportsCompanyQueries: true });
    expect(CHANNEL_CONFIG_TABLE.arbeitnow).toEqual({ section: "sources", key: "arbeitnow", usesQueries: false });
    expect(CHANNEL_CONFIG_TABLE.greenhouse).toEqual({ section: "sources", key: "greenhouse", usesQueries: false });
  });

  it("keeps the static keyword marker in sync with every real channel", () => {
    const registry = new ChannelRegistry();
    registerBuiltinChannels(registry);
    expect(registry.list().map((channel) => channel.id).sort()).toEqual(Object.keys(CHANNEL_CONFIG_TABLE).sort());
    for (const channel of registry.list()) expect(channelUsesQueries(channel.id), channel.id).toBe(channel.usesQueries);
    for (const channel of registry.list()) expect(channelSupportsCompanyQueries(channel.id), channel.id).toBe(channel.supportsCompanyQueries ?? false);
    expect(channelUsesQueries("unknown")).toBe(false);
    expect(channelSupportsCompanyQueries("unknown")).toBe(false);
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
    expect(settingsFromConfig("linkedin-monid", config)).toMatchObject({ enabled: true, monthlyBudgetUsd: 5, freeRecordsPerMonth: 0 });
    expect(settingsFromConfig("linkedin-session", config).enabled).toBe(false);
    expect(settingsFromConfig("arbeitsagentur", config)).toMatchObject({ enabled: true, freeRecordsPerMonth: 0, monthlyBudgetUsd: 0 });
  });

  it("exposes the raw block for channel-specific keys", () => {
    expect(settingsFromConfig("linkedin-apify", config).extra).toHaveProperty("actor_id");
    expect(settingsFromConfig("linkedin-session", config).extra).toHaveProperty("recommended_daily");
  });
});

describe("Monid budget validation", () => {
  it("rejects a channel budget above the global cap", () => {
    expect(() => channelsWith((raw) => {
      const linkedin = raw.linkedin as Record<string, Record<string, unknown>>;
      linkedin.monid!.monthly_budget_usd = Number(raw.paid_total_monthly_budget_usd) + 1;
    })).toThrow(/must not exceed paid_total_monthly_budget_usd/);
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
