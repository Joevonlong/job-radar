// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApifyChannel } from "@/lib/channels/linkedin/apify";

import { ENV, apifyConfig, berlinQuery, fakeApify, harness, response } from "./helpers";

const EVENING = "2026-10-26T16:03:31.000Z";
const MORNING = "2026-10-26T05:30:00.000Z";
const JOB = { id: "7000001", title: "Platform Engineer", companyName: "Example Company" };

beforeEach(() => {
  vi.stubGlobal("fetch", () => { throw new Error("Network forbidden in the offline date-window tests"); });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface WindowCase {
  name: string;
  now?: string;
  postedDate?: unknown;
  postedTimeAgo?: unknown;
  keptInTenHours: boolean;
}

const CASES: WindowCase[] = [
  { name: "today's placeholder midnight conflicts with a fresh relative label", postedDate: "2026-10-26T00:00:00.000Z", postedTimeAgo: "1 minute ago", keptInTenHours: true },
  { name: "yesterday's placeholder day overlaps the morning window", now: MORNING, postedDate: "2026-10-25T00:00:00.000Z", postedTimeAgo: "1 minute ago", keptInTenHours: true },
  { name: "yesterday's placeholder day is wholly outside the evening window", postedDate: "2026-10-25T00:00:00.000Z", postedTimeAgo: "1 minute ago", keptInTenHours: false },
  { name: "today's bare date stays day precision even with an hourly label", postedDate: "2026-10-26", postedTimeAgo: "16 hours ago", keptInTenHours: true },
  { name: "yesterday's bare date overlaps the morning window", now: MORNING, postedDate: "2026-10-25", keptInTenHours: true },
  { name: "yesterday's bare date is wholly outside the evening window", postedDate: "2026-10-25", keptInTenHours: false },
  { name: "an exact recent timestamp agrees with its relative label", postedDate: "2026-10-26T16:02:31.000Z", postedTimeAgo: "1 minute ago", keptInTenHours: true },
  { name: "an exact old timestamp agrees with its relative label", postedDate: "2026-10-26T05:03:31.000Z", postedTimeAgo: "11 hours ago", keptInTenHours: false },
  { name: "an exact old timestamp needs no relative label", postedDate: "2026-10-26T05:03:31.000Z", keptInTenHours: false },
  { name: "an exact timestamp at the cutoff is retained", postedDate: "2026-10-26T06:03:31.000Z", keptInTenHours: true },
  { name: "an exact timestamp just before the cutoff is excluded", postedDate: "2026-10-26T06:03:30.999Z", keptInTenHours: false },
  { name: "one second after midnight is still a precise non-midnight time", postedDate: "2026-10-26T00:00:01.000Z", keptInTenHours: false },
  { name: "one millisecond after midnight is still a precise non-midnight time", postedDate: "2026-10-26T00:00:00.001Z", keptInTenHours: false },
  { name: "a genuine midnight agrees with five hours ago", now: MORNING, postedDate: "2026-10-26T00:00:00.000Z", postedTimeAgo: "5 hours ago", keptInTenHours: true },
  { name: "a confirmed previous midnight is not extended to the end of its day", now: MORNING, postedDate: "2026-10-25T00:00:00.000Z", postedTimeAgo: "29 hours ago", keptInTenHours: false },
  { name: "the lower bound of a relative hour interval confirms midnight", now: "2026-10-26T05:00:00.000Z", postedDate: "2026-10-25T00:00:00.000Z", postedTimeAgo: "29 hours ago", keptInTenHours: false },
  { name: "the upper bound of a relative hour interval no longer confirms midnight", now: "2026-10-26T05:00:00.000Z", postedDate: "2026-10-25T00:00:00.000Z", postedTimeAgo: "28 hours ago", keptInTenHours: true },
  { name: "a midnight with a rounded-down minute label is confirmed", now: MORNING, postedDate: "2026-10-25T00:00:00.000Z", postedTimeAgo: "1770 minutes ago", keptInTenHours: false },
  { name: "a midnight with a second label is confirmed", now: MORNING, postedDate: "2026-10-25T00:00:00.000Z", postedTimeAgo: "106200 seconds ago", keptInTenHours: false },
  { name: "a midnight without a relative field is unconfirmed", postedDate: "2026-10-26T00:00:00.000Z", keptInTenHours: true },
  { name: "a null relative field cannot confirm midnight", postedDate: "2026-10-26T00:00:00.000Z", postedTimeAgo: null, keptInTenHours: true },
  { name: "a non-string relative field cannot confirm midnight", postedDate: "2026-10-26T00:00:00.000Z", postedTimeAgo: 16, keptInTenHours: true },
  { name: "an unsupported relative label cannot confirm midnight", postedDate: "2026-10-26T00:00:00.000Z", postedTimeAgo: "just now", keptInTenHours: true },
  { name: "an empty relative label cannot confirm midnight", postedDate: "2026-10-26T00:00:00.000Z", postedTimeAgo: "", keptInTenHours: true },
  { name: "a day label cannot confirm hour precision", now: MORNING, postedDate: "2026-10-25T00:00:00.000Z", postedTimeAgo: "1 day ago", keptInTenHours: true },
  { name: "an older conflicting relative label does not overwrite the supplied day", postedDate: "2026-10-26T00:00:00.000Z", postedTimeAgo: "3 weeks ago", keptInTenHours: true },
  { name: "a conflicting non-midnight timestamp uses only its day for filtering", postedDate: "2026-10-26T05:03:31.000Z", postedTimeAgo: "1 minute ago", keptInTenHours: true },
  { name: "a conflicting older label also removes confidence in the precise time", postedDate: "2026-10-26T05:03:31.000Z", postedTimeAgo: "3 days ago", keptInTenHours: true },
  { name: "Just now cannot confirm a non-midnight time", postedDate: "2026-10-26T05:03:31.000Z", postedTimeAgo: "Just now", keptInTenHours: true },
  { name: "a localized label cannot confirm a non-midnight time", postedDate: "2026-10-26T05:03:31.000Z", postedTimeAgo: "vor 1 Minute", keptInTenHours: true },
  { name: "an open-ended label cannot confirm a non-midnight time", postedDate: "2026-10-26T05:03:31.000Z", postedTimeAgo: "30+ days ago", keptInTenHours: true },
  { name: "an empty label cannot confirm a non-midnight time", postedDate: "2026-10-26T05:03:31.000Z", postedTimeAgo: "", keptInTenHours: true },
  { name: "a null label cannot confirm a non-midnight time", postedDate: "2026-10-26T05:03:31.000Z", postedTimeAgo: null, keptInTenHours: true },
  { name: "a non-string label cannot confirm a non-midnight time", postedDate: "2026-10-26T05:03:31.000Z", postedTimeAgo: 11, keptInTenHours: true },
  { name: "an unsupported label still excludes a whole day outside the window", postedDate: "2026-10-25T05:03:31.000Z", postedTimeAgo: "Just now", keptInTenHours: false },
  { name: "an offset midnight without confirmation retains its source day", postedDate: "2026-10-26T00:00:00+02:00", keptInTenHours: true },
  { name: "an offset midnight confirmed by an hourly label stays exact", now: MORNING, postedDate: "2026-10-25T00:00:00+02:00", postedTimeAgo: "31 hours ago", keptInTenHours: false },
  { name: "a non-midnight source time stays exact even when it converts to UTC midnight", postedDate: "2026-10-26T01:00:00+01:00", keptInTenHours: false },
  { name: "a negative-offset instant at the cutoff is retained", postedDate: "2026-10-26T02:33:31-03:30", keptInTenHours: true },
  { name: "a negative-offset fractional instant before the cutoff is excluded", postedDate: "2026-10-26T02:33:30.999-03:30", keptInTenHours: false },
  { name: "missing date fields cannot exclude a job", keptInTenHours: true },
  { name: "a relative field alone cannot supply a date", postedTimeAgo: "1 minute ago", keptInTenHours: true },
  { name: "a null date cannot exclude a job", postedDate: null, postedTimeAgo: "1 minute ago", keptInTenHours: true },
  { name: "an invalid date cannot exclude a job", postedDate: "not a date", postedTimeAgo: "1 minute ago", keptInTenHours: true },
  { name: "a non-string date cannot exclude a job", postedDate: 1792972800000, postedTimeAgo: "1 minute ago", keptInTenHours: true },
  { name: "a parseable but unrecognized date format cannot establish precision", postedDate: "2026-10", keptInTenHours: true },
];

describe.each([10, 24])("Apify date precision with a %i-hour window", (windowHours) => {
  it.each(CASES)("$name", async ({ now = EVENING, postedDate, postedTimeAgo, keptInTenHours }) => {
    const item = { ...JOB, postedDate, postedTimeAgo };
    const apify = fakeApify([response(201, [item])]);
    const channel = createApifyChannel({ pricePer1kUsd: () => 0.4, environment: ENV, now: () => new Date(now) });
    const { ctx } = await harness(channel, apify);
    const postings = await channel.collect(berlinQuery({ windowHours, maxResults: 1 }), ctx);

    // A 24-hour query already matches the actor's discrete range, so it has no additional local cutoff.
    expect(postings).toHaveLength(windowHours === 24 || keptInTenHours ? 1 : 0);
    expect(ctx.budget.snapshot().records).toBe(1);
    expect(apify.requests).toHaveLength(1);
  });
});

describe("observation and week boundaries", () => {
  it.each(["2026-10-26T00:00:00.000Z", "2026-10-26T00:03:31.000Z"])("keeps the source day when a delayed response makes its relative label stale: %s", async (postedDate) => {
    let observedAt = "2026-10-26T11:03:31.000Z";
    const item = { ...JOB, postedDate, postedTimeAgo: "11 hours ago" };
    const apify = fakeApify([() => {
      observedAt = EVENING;
      return response(201, [item]);
    }]);
    const channel = createApifyChannel({ pricePer1kUsd: () => 0.4, environment: ENV, now: () => new Date(observedAt) });
    const { ctx } = await harness(channel, apify);
    const postings = await channel.collect(berlinQuery({ windowHours: 10, maxResults: 1 }), ctx);

    expect(postings).toHaveLength(1);
    expect(postings[0]?.payload).toEqual(item);
    expect(postings[0]?.postedAt?.toISOString()).toBe(postedDate);
    expect(channel.parse(item).postedAt?.toISOString()).toBe(postedDate);
  });

  it.each([
    { windowHours: 167, range: "week", kept: [0, 4] },
    { windowHours: 168, range: "week", kept: [0, 1, 2, 3, 4, 5] },
    { windowHours: 169, range: "month", kept: [0, 1, 2, 4] },
  ])("applies local precision only below the actor range for $windowHours hours", async ({ windowHours, range, kept }) => {
    const items = [
      "2026-10-19T17:03:31.000Z", // exactly 167 hours old
      "2026-10-19T17:03:30.999Z",
      "2026-10-19T15:03:31.000Z", // exactly 169 hours old
      "2026-10-19T15:03:30.999Z",
      "2026-10-19", // the source day overlaps both local cutoffs
      "2026-10-18",
    ].map((postedDate, index) => ({ ...JOB, id: String(7_000_001 + index), postedDate }));
    const config = apifyConfig((block) => {
      block.date_posted = { day: "day", week: "week", month: "month", any: "" };
    });
    const apify = fakeApify([response(201, items)]);
    const channel = createApifyChannel({ pricePer1kUsd: () => 0.4, environment: ENV, now: () => new Date(EVENING) });
    const { ctx } = await harness(channel, apify, { config });
    const postings = await channel.collect(berlinQuery({ windowHours, maxResults: items.length }), ctx);

    expect(postings.map((posting) => posting.payload)).toEqual(kept.map((index) => items[index]));
    expect(apify.requests[0]?.body.datePosted).toBe(range);
    expect(ctx.budget.snapshot().records).toBe(items.length);
  });
});

describe("offline evening replay", () => {
  it.each([
    { name: "ISO placeholder midnight", postedDate: "2026-10-26T00:00:00.000Z", stored: "2026-10-26T00:00:00.000Z" },
    { name: "bare-date control", postedDate: "2026-10-26", stored: "2026-10-26T00:00:00.000Z" },
    { name: "exact-time control", postedDate: "2026-10-26T16:02:31.000Z", stored: "2026-10-26T16:02:31.000Z" },
    { name: "conflicting non-midnight time", postedDate: "2026-10-26T05:03:31.000Z", stored: "2026-10-26T05:03:31.000Z" },
    { name: "negative-offset instant", postedDate: "2026-10-26T12:02:31-04:00", stored: "2026-10-26T16:02:31.000Z" },
    { name: "fractional-seconds instant", postedDate: "2026-10-26T16:02:30.1250Z", stored: "2026-10-26T16:02:30.125Z" },
  ])("retains and bills $name without deriving a precise postedAt from relative text", async ({ postedDate, stored }) => {
    const item = { ...JOB, postedDate, postedTimeAgo: "1 minute ago" };
    const apify = fakeApify([response(201, [item])]);
    const channel = createApifyChannel({ pricePer1kUsd: () => 0.4, environment: ENV, now: () => new Date(EVENING) });
    const config = apifyConfig((block) => {
      block.price_per_1k_usd = 0.4;
      block.run_start_usd = 0.001;
    });
    const { ctx, logs } = await harness(channel, apify, { config });
    const postings = await channel.collect(berlinQuery({ windowHours: 10, maxResults: 1 }), ctx);

    expect(postings).toHaveLength(1);
    expect(postings[0]?.payload).toEqual(item);
    expect(postings[0]?.postedAt?.toISOString()).toBe(stored);
    expect(channel.parse(item).postedAt?.toISOString()).toBe(stored);
    expect(ctx.budget.snapshot().records).toBe(1);
    expect(ctx.budget.snapshot().usd).toBeCloseTo(0.0014, 9);
    expect(logs.find((entry) => entry.message === "apify records not stored")).toBeUndefined();
    expect(apify.requests).toHaveLength(1);
  });

  it("preserves a valid leap day in collection and normalization", async () => {
    const item = { ...JOB, postedDate: "2024-02-29" };
    const channel = createApifyChannel({ pricePer1kUsd: () => 0.4, environment: ENV, now: () => new Date(EVENING) });
    const { ctx } = await harness(channel, fakeApify([response(201, [item])]));
    const postings = await channel.collect(berlinQuery({ windowHours: 24 }), ctx);

    expect(postings[0]?.payload).toEqual(item);
    expect(postings[0]?.postedAt?.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(channel.parse(item).postedAt?.toISOString()).toBe("2024-02-29T00:00:00.000Z");
  });
});

describe.each([10, 24])("unknown posting dates with a %i-hour window", (windowHours) => {
  it.each([
    {},
    { postedDate: null },
    { postedDate: 1792972800000 },
    { postedDate: { year: 2026, month: 10, day: 26 } },
    { postedDate: "not a date" },
    { postedDate: "2026-10" },
    { postedDate: "2026-02-30" },
    { postedDate: "2026-02-29" },
    { postedDate: "2026-02-30T05:03:31Z" },
    { postedDate: "2026-10-26T25:03:31Z" },
    { postedDate: "2026-10-26T05:03:31" },
    { postedDate: "2026/10/26" },
  ])("retains the payload without inventing postedAt: %j", async (fields) => {
    const item = { ...JOB, ...fields, postedTimeAgo: "1 minute ago" };
    const channel = createApifyChannel({ pricePer1kUsd: () => 0.4, environment: ENV, now: () => new Date(EVENING) });
    const { ctx } = await harness(channel, fakeApify([response(201, [item])]));
    const postings = await channel.collect(berlinQuery({ windowHours }), ctx);

    expect(postings).toHaveLength(1);
    expect(postings[0]?.payload).toEqual(item);
    expect.soft(postings[0]?.postedAt).toBeNull();
    expect.soft(channel.parse(item).postedAt).toBeNull();
  });
});
