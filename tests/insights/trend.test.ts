import { describe, expect, it } from "vitest";

import { MIN_TREND_POINTS, trendStart, trendState, trendValues } from "@/lib/insights/trend";

describe("the KPI trend rule", () => {
  it("needs two days with data for a line; one day or none says so in words", () => {
    expect(MIN_TREND_POINTS).toBe(2);
    expect(trendState([null, null, null])).toBe("insufficient");
    expect(trendState([null, 80, null])).toBe("insufficient");
    expect(trendState([null, 80, null, 90])).toBe("line");
    expect(trendState([90, 80])).toBe("line");
  });

  it("holes are bridged, not broken: a series with gaps is still a line as soon as it has two data days", () => {
    const sparse = [null, 89, null, null, null, 92, null];
    expect(trendState(sparse)).toBe("line");
    expect(trendValues(sparse)).toEqual(sparse);
  });

  it("`present` decides what counts as data; days that do not count become gaps, never zeros", () => {
    const positive = (value: number | null) => value !== null && value > 0;
    expect(trendState([0, 0, 3, 0], positive)).toBe("insufficient");
    expect(trendState([0, 2, 3, 0], positive)).toBe("line");
    expect(trendValues([0, 2, 3, 0], positive)).toEqual([null, 2, 3, null]);
  });

  it("the three lines start on the same day, the first with any job, so none is squeezed into the last few pixels", () => {
    const positive = (value: number | null) => value !== null && value > 0;
    const totals = [0, 0, 0, 0, 4, 0, 6];
    const passRates = [null, null, null, null, 75, null, 83];
    const from = trendStart(totals, positive);
    expect(from).toBe(4);
    // same days in each series: the line of every KPI runs over the same x-range
    expect(totals.slice(from)).toHaveLength(passRates.slice(from).length);
    expect(trendStart([0, 0], positive)).toBe(0);
    expect(trendStart([], positive)).toBe(0);
  });
});
