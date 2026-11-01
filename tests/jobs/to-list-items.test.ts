import { createFormatter, createTranslator } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { toListItems } from "@/components/jobs/to-list-items";
import type { JobCard } from "@/lib/db/queries/types";
import en from "../../messages/en.json";

vi.mock("next-intl/server", () => ({
  getFormatter: () => createFormatter({ locale: "en", timeZone: "UTC" }),
  getLocale: () => "en",
  getTranslations: (namespace: "dashboard" | "ghostJobs") => createTranslator({ locale: "en", messages: en, namespace }),
}));

const firstSeenAt = new Date("2026-08-01T12:00:00Z");
const lastListedAt = new Date("2026-09-01T12:00:00Z");
const now = new Date("2026-10-01T12:00:00Z");
const options = { now, timezone: "UTC", visa: false, ghost: false };
const card = (over: Partial<JobCard> = {}): JobCard => ({
  id: 1, title: "Engineer", companyId: 1, companyName: "Example", locations: [], workplace: "unknown",
  contract: "unknown", isAgency: false, germanLevelRequired: "unknown", status: "closed", closedReason: "gone",
  linkCheck: null, postedAt: null, firstSeenAt, lastSeenAt: now, lastListedAt, relistedAt: null, relistCount: 0, salaryDisclosed: false,
  salary: null, skills: [], sources: [], applicationStatus: null, favorite: null, rank: null, summary: null,
  signals: [], seen: true, ...over,
});

describe("archive row times", () => {
  it.each(["manual", "gone", "dormant"] as const)("uses source time for %s, first seen for the title and unchanged freshness", async (closedReason) => {
    const [item] = await toListItems([card({ closedReason })], options);
    const format = createFormatter({ locale: "en", timeZone: "UTC" });
    expect(item?.timeLabel).toBe(`Last listed ${format.relativeTime(lastListedAt, now)}`);
    expect(item?.timeTitle).toBe(format.dateTime(firstSeenAt, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }));
    expect(item?.firstSeenHours).toBe((now.getTime() - firstSeenAt.getTime()) / 3_600_000);
  });

  it("does not invent a date for jobs without sources", async () => {
    expect((await toListItems([card({ lastListedAt: null })], options))[0]?.timeLabel).toBe(en.dashboard.jobs.lastListedUnknown);
  });

  it("keeps the existing time label for non-archived reasons", async () => {
    const format = createFormatter({ locale: "en", timeZone: "UTC" });
    for (const closedReason of [null, "phrase", "possibly"] as const) {
      expect((await toListItems([card({ closedReason })], options))[0]?.timeLabel).toBe(`seen ${format.relativeTime(firstSeenAt, now)}`);
    }
  });
});

describe("posted date column", () => {
  it("is posted_at: the day, a short relative time and the full sentence", async () => {
    const [item] = await toListItems([card({ closedReason: null, postedAt: new Date("2026-09-27T09:30:00Z") })], options);
    expect(item?.posted).toEqual({ day: "Sep 27", ago: "4 d", title: "Posted 2026-09-27 09:30 (4 days ago)", known: true });
  });

  it("a day without a time keeps its UTC day", async () => {
    const [item] = await toListItems([card({ closedReason: null, postedAt: new Date("2026-09-27T00:00:00Z") })], { ...options, timezone: "America/New_York" });
    expect(item?.posted).toMatchObject({ day: "Sep 27", ago: "4 d", title: "Posted 2026-09-27 (4 days ago)", known: true });
  });

  it("without a posted date it falls back to the first-seen day, marked unknown", async () => {
    const [item] = await toListItems([card({ closedReason: null, postedAt: null })], options);
    expect(item?.posted).toEqual({ day: "Aug 1", ago: "", title: "Posted date unknown, first seen 2026-08-01 12:00", known: false });
  });

  it("does not change the sort-relevant time label", async () => {
    const [item] = await toListItems([card({ closedReason: null, postedAt: new Date("2026-09-27T09:30:00Z") })], options);
    expect(item?.timeLabel).toBe(createFormatter({ locale: "en", timeZone: "UTC" }).relativeTime(new Date("2026-09-27T09:30:00Z"), now));
  });
});
