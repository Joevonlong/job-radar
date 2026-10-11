// @vitest-environment node
import { describe, expect, it } from "vitest";

import { insightsSchema } from "@/lib/config/schemas/insights";
import { buildInsightsView, scoreBand } from "@/lib/insights/view";

import { shippedYaml } from "../config/helpers";
import { emptyData } from "./helpers";

const config = insightsSchema.parse(shippedYaml("insights.yaml"));
const window = { from: "2026-10-01", to: "2026-10-03" };

describe("buildInsightsView", () => {
  it("is empty without jobs and application activity", () => {
    const view = buildInsightsView({ data: emptyData(), config, rangeDays: 3, window, pushLine: 70 });
    expect(view.empty).toBe(true);
    expect(view.kpi.change).toBeNull();
    expect(view.kpi.passRate).toBeNull();
    expect(view.kpi.passRateChangePt).toBeNull();
    expect(view.conversion).toEqual({ fetched: 0, passed: 0, pushable: 0, applied: 0, pushLine: 70 });
    expect(view.kpi.salaryRate).toBeNull();
    // a day without jobs is still a column
    expect(view.daily.columns.map((c) => c.day)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });

  it("is not empty when only the funnel moved", () => {
    const data = emptyData();
    data.funnel.exits.archived = 1;
    expect(buildInsightsView({ data, config, rangeDays: 3, window, pushLine: 70 }).empty).toBe(false);
  });

  it("draws no funnel stage that is hidden and empty", () => {
    const data = emptyData();
    data.funnel = { newJobs: 3, reached: { interested: 2, preparing: 0, applied: 1, interviewing: 0, offer: 0 }, exits: { rejected: 0, withdrawn: 0, archived: 0 } };
    const keys = (hidden: string[]) => buildInsightsView({ data, config, rangeDays: 3, window, pushLine: 70, hiddenStatuses: hidden }).funnel.rows.map((r) => r.key);
    expect(keys([])).toEqual(["new", "interested", "preparing", "applied", "interviewing", "offer"]);
    expect(keys(["preparing", "interviewing", "interested"])).toEqual(["new", "interested", "applied", "offer"]);
  });

  it("fills histogram gaps, trims empty salary ends and keeps every score bucket", () => {
    const data = emptyData();
    data.salary.buckets = [{ index: 6, count: 2 }, { index: 8, count: 1 }, { index: 15, count: 1 }];
    data.scores.buckets = [{ index: 12, count: 3 }];
    const view = buildInsightsView({ data, config, rangeDays: 3, window, pushLine: 70 });
    expect(view.salary.bars.map((b) => [b.index, b.count])).toEqual([[6, 2], [7, 0], [8, 1], [9, 0], [10, 0], [11, 0], [12, 0], [13, 0], [14, 0], [15, 1]]);
    expect(view.salary.bars[0]).toMatchObject({ from: 60_000, to: 70_000 });
    expect(view.salary.bars.at(-1)).toMatchObject({ from: 150_000, to: null });
    expect(view.scores.bars).toHaveLength(21);
    expect(view.scores.bars[12]).toMatchObject({ from: 60, to: 65, count: 3, band: "mid" });
    expect(view.scores.bars.at(-1)).toMatchObject({ from: 100, to: null });
  });

  it("works out shares, conversion and the change against the previous window", () => {
    const data = emptyData();
    data.daily = [{ day: "2026-10-02", passed: 3, filtered: 1, avgRank: 80 }];
    data.previousTotal = 2;
    data.previousPassed = 2;
    data.scores.atPushLine = 2;
    data.sources = [{ family: "ats", total: 4, passed: 3 }];
    data.funnel = { newJobs: 3, reached: { interested: 2, preparing: 1, applied: 1, interviewing: 0, offer: 0 }, exits: { rejected: 0, withdrawn: 0, archived: 0 } };
    const view = buildInsightsView({ data, config, rangeDays: 3, window, pushLine: 70 });
    expect(view.kpi).toMatchObject({ total: 4, passed: 3, change: 1, passRate: 0.75, previousPassRate: 1, passRateChangePt: -25 });
    expect(view.daily.columns.find((c) => c.day === "2026-10-02")?.avgRank).toBe(80);
    expect(view.conversion).toEqual({ fetched: 4, passed: 3, pushable: 2, applied: 1, pushLine: 70 });
    expect(view.sources.rows[0]).toMatchObject({ passRate: 0.75 });
    expect(view.funnel.rows.map((r) => r.conversion)).toEqual([null, 2 / 3, 0.5, 1, 0, null]);
    // more marked interested than new jobs appeared: some came from before the window, so no share
    data.funnel = { ...data.funnel, reached: { ...data.funnel.reached, interested: 5 } };
    expect(buildInsightsView({ data, config, rangeDays: 3, window, pushLine: 70 }).funnel.rows[1]?.conversion).toBeNull();
    expect(view.funnel.rows[0]?.width).toBe(1);
  });

  it("colours rank buckets by the dashboard's score bands", () => {
    expect([0, 49, 50, 69, 70, 84, 85, 100].map(scoreBand)).toEqual(["low", "low", "mid", "mid", "good", "good", "top", "top"]);
  });
});
