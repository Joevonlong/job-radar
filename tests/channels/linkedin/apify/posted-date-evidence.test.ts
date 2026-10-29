// @vitest-environment node
import { describe, expect, it } from "vitest";

import { postedBefore, postedDateEvidence } from "@/lib/channels/linkedin/apify/posted-date";

const EVENING = "2026-10-26T16:03:31.000Z";
const MORNING = "2026-10-26T05:30:00.000Z";

describe("Apify posted date evidence", () => {
  it.each([
    { name: "placeholder midnight without a label", record: { postedDate: "2026-10-26T00:00:00Z" }, end: "2026-10-27T00:00:00Z", flags: ["date_day_precision"] },
    { name: "bare date", record: { postedDate: "2026-10-26" }, end: "2026-10-27T00:00:00Z", flags: ["date_day_precision"] },
    { name: "exact non-midnight time without a label", record: { postedDate: "2026-10-26T01:00:00Z" }, end: "2026-10-26T01:00:00Z", flags: [] },
    { name: "real midnight confirmed by hours", record: { postedDate: "2026-10-26T00:00:00Z", postedTimeAgo: "3 hours ago" }, end: "2026-10-26T00:00:00Z", flags: [] },
    { name: "missing date", record: {}, end: null, flags: ["date_missing"] },
    { name: "null date", record: { postedDate: null }, end: null, flags: ["date_missing"] },
    { name: "unparseable date", record: { postedDate: "not a date" }, end: null, flags: ["date_unparsed"] },
    { name: "unrecognized date format", record: { postedDate: "2026-10" }, end: null, flags: ["date_unparsed"] },
    { name: "non-midnight time with an unparseable label", record: { postedDate: "2026-10-26T01:00:00Z", postedTimeAgo: "Just now" }, end: "2026-10-27T00:00:00Z", flags: ["date_unconfirmed"] },
    { name: "non-midnight time with a null label", record: { postedDate: "2026-10-26T01:00:00Z", postedTimeAgo: null }, end: "2026-10-27T00:00:00Z", flags: ["date_unconfirmed"] },
    { name: "conflicting relative label", record: { postedDate: "2026-10-26T01:00:00Z", postedTimeAgo: "1 minute ago" }, end: "2026-10-27T00:00:00Z", flags: ["date_conflict"] },
  ])("reports $name without changing the source record", ({ record, end, flags }) => {
    const original = structuredClone(record);
    const evidence = postedDateEvidence(record, Date.parse("2026-10-26T03:30:00Z"));
    expect(evidence).toEqual({ end: end === null ? null : Date.parse(end), flags });
    expect(record).toEqual(original);
  });
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

describe("Apify window evidence preserves existing precision decisions", () => {
  it.each(CASES)("$name", ({ now = EVENING, postedDate, postedTimeAgo, keptInTenHours }) => {
    const observedAt = Date.parse(now);
    const record = { postedDate, postedTimeAgo };
    const { end } = postedDateEvidence(record, observedAt);
    const tenHourCutoff = observedAt - 10 * 3_600_000;
    expect(postedBefore(record, tenHourCutoff, observedAt)).toBe(!keptInTenHours);
    for (const cutoff of [observedAt - 169 * 3_600_000, tenHourCutoff, observedAt, ...(end === null ? [] : [end - 1, end, end + 1])]) {
      expect(postedBefore(record, cutoff, observedAt)).toBe(end !== null && end < cutoff);
    }
  });
});
