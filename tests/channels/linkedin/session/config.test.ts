// @vitest-environment node
import { describe, expect, it } from "vitest";

import { registerBuiltinChannels } from "@/lib/channels/builtin";
import { LINKEDIN_SESSION_ID, LINKEDIN_SESSION_RECOMMENDED_ID, readSessionSettings } from "@/lib/channels/linkedin/session";
import { ChannelRegistry, settingsFromConfig } from "@/lib/channels/registry";
import { configRegistry } from "@/lib/config";
import { shippedYaml } from "../../../config/helpers";
import { channelsWith, shippedChannels, shippedSchedule } from "../../helpers";

describe("linkedin.session config", () => {
  it("the shipped block validates and is off by default (it needs a login first)", () => {
    const session = shippedChannels().linkedin.session;
    expect(session.enabled).toBe(false);
    expect(session).toMatchObject({ max_results: 50, daily_request_limit: 200, recommended_daily: true, fetch_details: true });
    expect(session.site.auth_file).toBe(".auth/linkedin.json");
    expect(session.browser.headless).toBe(true);
  });

  it("rejects unknown keys and bad values (strict, C6)", () => {
    expect(() => channelsWith((raw) => ((raw.linkedin as Record<string, Record<string, unknown>>).session!.surprise = 1))).toThrow();
    expect(() => channelsWith((raw) => ((raw.linkedin as Record<string, Record<string, unknown>>).session!.daily_request_limit = 0))).toThrow();
    expect(() => channelsWith((raw) => (((raw.linkedin as Record<string, Record<string, Record<string, unknown>>>).session!.browser!.block_resources = ["video"])))).toThrow();
    expect(() => channelsWith((raw) => (((raw.linkedin as Record<string, Record<string, Record<string, unknown>>>).session!.site!.base_url = "not a url")))).toThrow();
  });

  it("readSessionSettings validates a channel's raw block", () => {
    expect(readSessionSettings(shippedChannels().linkedin.session).max_pages).toBe(2);
    expect(() => readSessionSettings({ enabled: true })).toThrow(/incomplete/);
  });

  it("the cascade lists the session channel fourth, and both session channels read their settings from the one block", () => {
    const config = shippedChannels();
    expect(config.linkedin.cascade).toEqual(["linkedin-brightdata", "linkedin-apify", "linkedin-monid", "linkedin-session", "linkedin-guest"]);
    expect(settingsFromConfig(LINKEDIN_SESSION_ID, config)).toMatchObject({ enabled: false, maxResults: 50, monthlyBudgetUsd: 0, throttle: { minDelayMs: 3000, maxDelayMs: 8000 } });
    expect(settingsFromConfig(LINKEDIN_SESSION_RECOMMENDED_ID, config)).toMatchObject({ enabled: false, maxResults: 25 });
  });

  it("the recommended channel runs only when the session channel is enabled AND recommended_daily is on", () => {
    const enabled = (session: Record<string, unknown>) => {
      session.enabled = true;
    };
    const on = channelsWith((raw) => enabled((raw.linkedin as Record<string, Record<string, unknown>>).session!));
    expect(settingsFromConfig(LINKEDIN_SESSION_RECOMMENDED_ID, on).enabled).toBe(true);
    const off = channelsWith((raw) => {
      const session = (raw.linkedin as Record<string, Record<string, unknown>>).session!;
      enabled(session);
      session.recommended_daily = false;
    });
    expect(settingsFromConfig(LINKEDIN_SESSION_RECOMMENDED_ID, off).enabled).toBe(false);
    expect(settingsFromConfig(LINKEDIN_SESSION_ID, off).enabled).toBe(true);
  });

  it("schedule.yaml carries the daily slot, and a file without the block gets the default", () => {
    expect(shippedSchedule().linkedin_recommended).toEqual({ enabled: true, cron: "0 7 * * *" });
    const raw = structuredClone(shippedYaml("schedule.yaml")) as Record<string, unknown>;
    delete raw.linkedin_recommended;
    expect(configRegistry.schedule.schema.parse(raw).linkedin_recommended).toEqual({ enabled: true, cron: "0 7 * * *" });
    raw.linkedin_recommended = { enabled: true, cron: "not a cron" };
    expect(() => configRegistry.schedule.schema.parse(raw)).toThrow();
  });
});

describe("registration", () => {
  it("the builtin registry holds both session channels, in the LinkedIn family, kind session", () => {
    const registry = new ChannelRegistry();
    registerBuiltinChannels(registry);
    for (const id of [LINKEDIN_SESSION_ID, LINKEDIN_SESSION_RECOMMENDED_ID]) {
      expect(registry.get(id)).toMatchObject({ family: "linkedin", kind: "session" });
    }
    expect(registry.get(LINKEDIN_SESSION_ID)?.usesQueries).toBe(true);
    expect(registry.get(LINKEDIN_SESSION_RECOMMENDED_ID)?.usesQueries).toBe(false);
    // disabled by default, so neither runs in a cycle
    expect(registry.isEnabled(LINKEDIN_SESSION_ID, shippedChannels())).toBe(false);
    expect(registry.isEnabled(LINKEDIN_SESSION_RECOMMENDED_ID, shippedChannels())).toBe(false);
  });
});
