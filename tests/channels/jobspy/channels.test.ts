// @vitest-environment node
import { describe, expect, it } from "vitest";

import { registerBuiltinChannels } from "@/lib/channels/builtin";
import { createIndeedChannel, createJobspyGoogleChannel, createLinkedinGuestChannel } from "@/lib/channels/jobspy";
import { ChannelRegistry } from "@/lib/channels/registry";

import { shippedChannels } from "../helpers";
import { httpResponse, jobspyContext, jobspySettings, loadJobspyFixture, query } from "./helpers";

const settings = jobspySettings();

describe("channel metadata", () => {
  it("follows the spec: families, kinds and ids", () => {
    expect(createLinkedinGuestChannel({ settings: () => settings })).toMatchObject({ id: "linkedin-guest", family: "linkedin", kind: "guest", usesQueries: true });
    expect(createIndeedChannel({ settings: () => settings })).toMatchObject({ id: "indeed", family: "indeed", usesQueries: true });
    expect(createJobspyGoogleChannel({ settings: () => settings })).toMatchObject({ id: "jobspy-google", family: "google", usesQueries: true });
  });

  it("registers with config blocks; jobspy-google is disabled by default, the others enabled", () => {
    const registry = new ChannelRegistry();
    registerBuiltinChannels(registry);
    const config = shippedChannels();
    expect(registry.has("linkedin-guest") && registry.has("indeed") && registry.has("jobspy-google")).toBe(true);
    expect(registry.isEnabled("linkedin-guest", config)).toBe(true);
    expect(registry.isEnabled("indeed", config)).toBe(true);
    expect(registry.isEnabled("jobspy-google", config)).toBe(false);
    expect(registry.settingsFor("indeed", config)?.throttle).toEqual({ minDelayMs: 2000, maxDelayMs: 5000 });
  });
});

describe("collect", () => {
  it.each([
    ["indeed", createIndeedChannel, "indeed"],
    ["linkedin", createLinkedinGuestChannel, "linkedin"],
    ["google", createJobspyGoogleChannel, "google"],
  ] as const)("%s: asks the sidecar for its site and returns raw postings that parse", async (name, create, site) => {
    const fixture = loadJobspyFixture(name);
    const { ctx, calls } = jobspyContext(() => httpResponse(200, fixture));
    const channel = create({ settings: () => settings });
    const raw = await channel.collect(query({ maxResults: 100 }), ctx);
    expect(calls[0]?.body).toMatchObject({ site, location: "Berlin", hours_old: 24 });
    expect(raw).toHaveLength(fixture.jobs.length);
    const expectedId = String(fixture.jobs[0]?.id);
    expect(raw[0]).toMatchObject({ externalId: site === "linkedin" ? expectedId.replace(/^li-/, "") : expectedId });
    const parsed = raw.flatMap((r) => {
      try {
        return [channel.parse(r.payload)];
      } catch {
        return [];
      }
    });
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("never returns more than the query allows", async () => {
    const { ctx } = jobspyContext(() => httpResponse(200, loadJobspyFixture("indeed")));
    const raw = await createIndeedChannel({ settings: () => settings }).collect(query({ maxResults: 2 }), ctx);
    expect(raw).toHaveLength(2);
  });

  it("normalizes guest LinkedIn ids before deduplicating and leaves the stored payload untouched", async () => {
    const jobs = [
      { id: "li-4476000001", site: "linkedin", title: "first" },
      { id: "4476000001", site: "linkedin", title: "duplicate" },
    ];
    const { ctx } = jobspyContext(() => httpResponse(200, { site: "linkedin", count: 2, jobs }));
    const raw = await createLinkedinGuestChannel({ settings: () => settings }).collect(query(), ctx);
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ externalId: "4476000001", payload: jobs[0] });
  });

  it("propagates the sidecar's rate limit as rate_limited", async () => {
    const { ctx } = jobspyContext(() => httpResponse(429, { code: "rate_limited", message: "429" }));
    await expect(createLinkedinGuestChannel({ settings: () => settings }).collect(query(), ctx)).rejects.toMatchObject({ code: "rate_limited" });
  });
});
