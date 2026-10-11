// @vitest-environment node
import { describe, expect, it } from "vitest";

import { insightsSchema } from "@/lib/config/schemas/insights";
import { insightsHref, jobsHref } from "@/lib/insights/links";
import { addDays, dayInZone, eachDay, previousWindow, resolveRangeDays, windowEnding } from "@/lib/insights/range";
import { loadJobsSearchParams } from "@/lib/jobs/search-params";

import { shippedYaml } from "../config/helpers";

describe("range", () => {
  it("takes the calendar day in the schedule's time zone", () => {
    const instant = new Date("2026-10-06T22:30:00Z");
    expect(dayInZone(instant, "Europe/Berlin")).toBe("2026-10-07");
    expect(dayInZone(instant, "UTC")).toBe("2026-10-06");
    expect(dayInZone(instant, "America/Los_Angeles")).toBe("2026-10-06");
  });

  it("moves days across month, year and leap boundaries", () => {
    expect(addDays("2026-10-01", -1)).toBe("2026-09-30");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(eachDay("2026-02-27", "2026-03-02")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
  });

  it("builds a window ending today and the one before it", () => {
    const window = windowEnding("2026-10-07", 7);
    expect(window).toEqual({ from: "2026-10-01", to: "2026-10-07" });
    expect(previousWindow(window, 7)).toEqual({ from: "2026-09-24", to: "2026-09-30" });
    expect(eachDay(window.from, window.to)).toHaveLength(7);
  });

  it("only accepts a range the config offers", () => {
    expect(resolveRangeDays(90, [7, 30, 90], 30)).toBe(90);
    expect(resolveRangeDays(5, [7, 30, 90], 30)).toBe(30);
    expect(resolveRangeDays(null, [7, 30, 90], 30)).toBe(30);
  });
});

describe("links", () => {
  it("writes filters the /jobs page parses back", async () => {
    const href = jobsHref({ range: { from: "2026-10-01", to: "2026-10-07" }, source: "ats", city: "München", workplace: "remote", salary: true, filtered: true, high: true });
    const query = new URLSearchParams(href.split("?")[1]);
    const parsed = await loadJobsSearchParams(query);
    expect(parsed).toMatchObject({ from: "2026-10-01", to: "2026-10-07", source: ["ats"], city: ["München"], workplace: ["remote"], salary: true, filtered: true, high: true });
    // the counts include closed jobs: the list names every job status, so /jobs does not hide them
    expect(parsed.status).toEqual(["active", "possibly_closed", "closed"]);
  });

  it("a filtered-out count opens the filtered jobs only", async () => {
    const href = jobsHref({ range: { from: "2026-10-06", to: "2026-10-06" }, filteredOnly: true });
    expect(await loadJobsSearchParams(new URLSearchParams(href.split("?")[1]))).toMatchObject({ filteredOnly: true, filtered: null });
  });

  it("names only the statuses without filters, and /insights has no parameter for the default range", () => {
    expect(jobsHref({})).toBe("/jobs?status=active&status=possibly_closed&status=closed");
    expect(insightsHref(30, 30)).toBe("/insights");
    expect(insightsHref(7, 30)).toBe("/insights?range=7");
  });
});

describe("insights.yaml", () => {
  const parse = (edit: (raw: Record<string, unknown>) => void) => {
    const raw = structuredClone(shippedYaml("insights.yaml"));
    edit(raw);
    return insightsSchema.safeParse(raw);
  };

  it("ships 7 / 30 / 90 days with Berlin and München", () => {
    const config = insightsSchema.parse(shippedYaml("insights.yaml"));
    expect(config.ranges_days).toEqual([7, 30, 90]);
    expect(config.default_range_days).toBe(30);
    expect(config.cities).toEqual(["Berlin", "München"]);
  });

  it("rejects a default that is not offered, unsorted ranges and inverted caps", () => {
    expect(parse((raw) => (raw.default_range_days = 14)).success).toBe(false);
    expect(parse((raw) => (raw.ranges_days = [30, 7])).success).toBe(false);
    expect(parse((raw) => (raw.ranges_days = [7, 7])).success).toBe(false);
    expect(parse((raw) => (raw.score_bucket_cap = 5)).success).toBe(false);
    expect(parse((raw) => (raw.salary_bucket_cap = 10_000)).success).toBe(false);
    expect(parse((raw) => (raw.surprise = 1)).success).toBe(false);
  });

  it("accepts no listed cities", () => {
    expect(parse((raw) => (raw.cities = [])).success).toBe(true);
  });
});
