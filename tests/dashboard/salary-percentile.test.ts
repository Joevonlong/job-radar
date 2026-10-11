// @vitest-environment node
import { describe, expect, it } from "vitest";

import { listSalary, rowSalaryPercentile } from "@/lib/dashboard/salary";
import { summarizeMonthSalaries } from "@/lib/domain/salary";
import type { JobSalary } from "@/lib/domain/types";
import { asSalary } from "../helpers/salary";

const salary = (over: Partial<JobSalary> = {}): JobSalary => asSalary({
  raw: "x",
  currency: "EUR",
  period: "year",
  min: 90000,
  max: 110000,
  perYear: { min: 90000, max: 110000 },
  eurPerYear: { min: 90000, max: 110000 },
  periodAssumed: false,
  origin: "text",
  qualityStatus: "valid",
  reasonCodes: [],
  ...over,
});

const figures = (...values: number[]) => values.map((figure, index) => ({ id: index + 1, figure }));

describe("summarizeMonthSalaries (the one percentile rule of the list and the detail page)", () => {
  const month = figures(50000, 60000, 70000, 80000, 90000, 100000, 110000, 120000, 130000, 140000);

  it("is the share of the other jobs this one pays more than", () => {
    expect(summarizeMonthSalaries(month, { jobId: 0, figure: 95000, minSample: 5 }).percentile).toBe(50);
    expect(summarizeMonthSalaries(month, { jobId: 0, figure: 135000, minSample: 5 }).percentile).toBe(90);
    expect(summarizeMonthSalaries(month, { jobId: 0, figure: 40000, minSample: 5 }).percentile).toBe(0);
    expect(summarizeMonthSalaries(month, { jobId: 0, figure: 150000, minSample: 5 }).percentile).toBe(100);
  });

  it("leaves the job itself out of the denominator and does not count ties as lower", () => {
    // job 6 (100k) among the ten: of the other nine, five are below
    expect(summarizeMonthSalaries(month, { jobId: 6, figure: 100000, minSample: 5 }).percentile).toBeCloseTo((5 / 9) * 100);
    expect(summarizeMonthSalaries(figures(100000, 100000, 100000, 100000, 100000), { jobId: 1, figure: 100000, minSample: 5 }).percentile).toBe(0);
  });

  it("says nothing below the minimum sample, for a job without a figure, or when there are no other jobs", () => {
    expect(summarizeMonthSalaries(figures(1, 2, 3, 4), { jobId: 0, figure: 3, minSample: 5 })).toEqual({ count: 4, median: null, percentile: null });
    expect(summarizeMonthSalaries(month, { jobId: 0, figure: null, minSample: 5 }).percentile).toBeNull();
    expect(summarizeMonthSalaries(figures(80000), { jobId: 1, figure: 80000, minSample: 1 })).toEqual({ count: 1, median: 80000, percentile: null });
    expect(summarizeMonthSalaries([], { jobId: 1, figure: 80000, minSample: 1 })).toEqual({ count: 0, median: null, percentile: null });
  });

  it("gives the median: the middle figure, or the mean of the two middle ones", () => {
    expect(summarizeMonthSalaries(figures(60000, 80000, 100000, 120000, 140000), { jobId: 0, figure: null, minSample: 5 }).median).toBe(100000);
    expect(summarizeMonthSalaries(figures(60000, 80000, 100000, 120000), { jobId: 0, figure: null, minSample: 4 }).median).toBe(90000);
  });
});

describe("rowSalaryPercentile", () => {
  const month = { figures: figures(50000, 60000, 70000, 80000, 90000, 100000), minSample: 5, currency: "EUR" };
  it("uses the job's annual EUR figure and is null for the three non-plain salary states", () => {
    expect(rowSalaryPercentile({ id: 99, salary: salary({ eurPerYear: { min: 85000, max: 95000 } }) }, month)).toBe((4 / 6) * 100);
    expect(rowSalaryPercentile({ id: 99, salary: null }, month)).toBeNull(); // not disclosed
    expect(rowSalaryPercentile({ id: 99, salary: salary({ qualityStatus: "review" }) }, month)).toBeNull();
    expect(rowSalaryPercentile({ id: 99, salary: salary({ otherRegion: "currency" }) }, month)).toBeNull(); // another region's pay
    expect(rowSalaryPercentile({ id: 99, salary: salary() }, undefined)).toBeNull();
  });
});

describe("listSalary: the three non-plain states", () => {
  it("undisclosed: no salary, or one under review, has no axis figures", () => {
    expect(listSalary(null, "en", "EUR")).toBeNull();
    expect(listSalary(salary({ qualityStatus: "review" }), "en", "EUR")).toBeNull();
    expect(listSalary(salary({ eurPerYear: null }), "en", "EUR")).toBeNull();
  });

  it("other region: flagged, with the posting's own currency figure", () => {
    const result = listSalary(
      salary({ currency: "USD", min: 140000, max: 170000, perYear: { min: 140000, max: 170000 }, eurPerYear: { min: 129000, max: 156000 }, otherRegion: "currency" }),
      "en",
      "EUR",
    );
    expect(result).toEqual({ min: 129000, max: 156000, otherRegion: true, approx: true, figure: "$140–170k" });
  });

  it("a plain EUR salary has no separate figure and is not another region's", () => {
    expect(listSalary(salary(), "en", "EUR")).toEqual({ min: 90000, max: 110000, otherRegion: false, approx: false, figure: null });
  });
});
