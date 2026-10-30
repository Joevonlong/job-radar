// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createFixtureChannel } from "@/lib/channels/fixture";
import { ChannelError } from "@/lib/channels/errors";
import { stubContext } from "./helpers";
import { normalizedPostingDraftSchema, rawPostingInputSchema, type NormalizedPostingDraft } from "@/lib/channels/types";

const draft: NormalizedPostingDraft = {
  title: "Applied AI Engineer",
  companyName: "Acme GmbH",
  locations: [{ label: "Berlin, Germany", city: "Berlin", countryCode: "DE" }],
  workplace: "hybrid",
  description: "Build things.",
  applyUrl: "https://jobs.example.test/1",
  sourceUrl: null,
};

describe("normalizedPostingDraftSchema", () => {
  it("accepts a minimal draft and one with every optional field", () => {
    expect(normalizedPostingDraftSchema.safeParse(draft).success).toBe(true);
    const full = {
      ...draft,
      contractHint: "permanent",
      seniorityHint: "senior",
      salaryText: "85-105k",
      salary: { min: 85000, max: 105000, currency: "EUR", period: "year", raw: "85-105k" },
      descriptionLanguage: "en",
      postedAt: new Date("2026-10-01T00:00:00Z"),
      isAgency: false,
      extra: { board: "x" },
    };
    expect(normalizedPostingDraftSchema.safeParse(full).success).toBe(true);
  });

  it("rejects empty titles, bad urls, bad country codes and unknown workplaces", () => {
    for (const bad of [
      { ...draft, title: "  " },
      { ...draft, companyName: "" },
      { ...draft, applyUrl: "javascript:alert(1)" },
      { ...draft, sourceUrl: "not a url" },
      { ...draft, locations: [{ label: "x", city: null, countryCode: "Germany" }] },
      { ...draft, workplace: "anywhere" },
    ]) {
      expect(normalizedPostingDraftSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("requires applyUrl and sourceUrl to be present (null when unknown) and keeps salary honest", () => {
    const { applyUrl, ...withoutApply } = draft;
    void applyUrl;
    expect(normalizedPostingDraftSchema.safeParse(withoutApply).success).toBe(false);
    const salary = (s: object) => normalizedPostingDraftSchema.safeParse({ ...draft, salary: s }).success;
    expect(salary({ min: null, max: 120000, currency: "EUR", period: "year", raw: "up to 120k" })).toBe(true);
    expect(salary({ min: null, max: null, currency: "EUR", period: "year", raw: "" })).toBe(false);
    expect(salary({ min: 5, max: 1, currency: "EUR", period: "year", raw: "" })).toBe(false);
    expect(salary({ min: 1, max: 5, currency: "euro", period: "year", raw: "" })).toBe(false);
  });
});

describe("rawPostingInputSchema", () => {
  it("accepts JSON-serializable payloads and rejects the rest", () => {
    const ok = { externalId: "1", url: null, payload: { a: [1, 2, { b: null }] } };
    expect(rawPostingInputSchema.safeParse(ok).success).toBe(true);
    expect(rawPostingInputSchema.safeParse({ ...ok, payload: undefined }).success).toBe(false);
    expect(rawPostingInputSchema.safeParse({ ...ok, payload: { n: 10n } }).success).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(rawPostingInputSchema.safeParse({ ...ok, payload: cyclic }).success).toBe(false);
    expect(rawPostingInputSchema.safeParse({ ...ok, externalId: " " }).success).toBe(false);
  });
});

describe("fixture channel parse output", () => {
  it("validates against the draft schema", async () => {
    const channel = createFixtureChannel();
    const records = await channel.collect(
      { id: "q", keywords: [], keywordGroup: "g", location: null, remote: false, remoteScope: null, company: null, windowHours: 24, maxResults: 10 },
      stubContext(),
    );
    expect(records.length).toBe(5);
    for (const record of records) {
      expect(normalizedPostingDraftSchema.safeParse(channel.parse(record.payload)).success).toBe(true);
    }
    expect(() => channel.parse({ nope: true })).toThrow(ChannelError);
  });
});
