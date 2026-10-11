// @vitest-environment node
import { describe, expect, it } from "vitest";

import { formatExperienceRange, isValidExperienceRange } from "@/lib/domain/experience";
import { locationsInCountry, preferredLocationLabels } from "@/lib/domain/geography";
import { comparableAnnualRange, salaryRangeOverlaps } from "@/lib/domain/salary";
import { isSeniority } from "@/lib/domain/seniority";
import { jobSalarySchema, type JobLocation, type JobSalary } from "@/lib/domain/types";
import { asSalary } from "../helpers/salary";

const salary = (over: Partial<JobSalary> = {}): JobSalary => asSalary({
  raw: "EUR 90,000-120,000",
  currency: "EUR",
  period: "year",
  min: 90_000,
  max: 120_000,
  perYear: { min: 90_000, max: 120_000 },
  eurPerYear: { min: 90_000, max: 120_000 },
  periodAssumed: false,
  origin: "text",
  qualityStatus: "valid",
  reasonCodes: [],
  ...over,
});

describe("comparable salary evidence (ported from the legacy salary tests)", () => {
  it("requires both disclosed endpoints rather than inventing a range endpoint", () => {
    expect(comparableAnnualRange(salary({ min: 90_000, max: null, eurPerYear: { min: 90_000, max: null } }), "EUR")).toBeNull();
    expect(comparableAnnualRange(salary({ min: null, max: 120_000, eurPerYear: { min: null, max: 120_000 } }), "EUR")).toBeNull();
  });

  it("accepts only a valid complete EUR / year range", () => {
    expect(comparableAnnualRange(salary(), "EUR")).toEqual({ min: 90_000, max: 120_000, currency: "EUR", period: "year" });
    expect(comparableAnnualRange(salary({ eurPerYear: { min: 120_000, max: 90_000 } }), "EUR")).toBeNull();
    expect(comparableAnnualRange(salary({ qualityStatus: "review" }), "EUR")).toBeNull();
    expect(comparableAnnualRange(salary({ eurPerYear: null }), "EUR")).toBeNull();
    expect(comparableAnnualRange(null, "EUR")).toBeNull();
  });

  it("checks overlap with a requested range", () => {
    expect(salaryRangeOverlaps(salary(), "EUR", 100_000, 150_000)).toBe(true);
    expect(salaryRangeOverlaps(salary(), "EUR", 130_000)).toBe(false);
    expect(salaryRangeOverlaps(salary(), "EUR", undefined, 80_000)).toBe(false);
    expect(salaryRangeOverlaps(null, "EUR")).toBe(true);
    expect(salaryRangeOverlaps(null, "EUR", 1)).toBe(false);
  });

  it("validates the stored shape", () => {
    expect(jobSalarySchema.safeParse(salary()).success).toBe(true);
    expect(jobSalarySchema.safeParse({ ...salary(), period: "fortnight" }).success).toBe(false);
  });
});

describe("country-scoped geography (ported from the legacy geography tests)", () => {
  const locations: JobLocation[] = [
    { label: "Amsterdam, Netherlands", city: "Amsterdam", countryCode: "NL", isPrimary: true },
    { label: "Berlin, Germany", city: "Berlin", countryCode: "DE", isPrimary: false },
    { label: "München, Germany", city: "München", countryCode: "DE", isPrimary: false },
  ];

  it("keeps full detail geography while exposing only locations in the selected market", () => {
    expect(locationsInCountry(locations, "DE").map((l) => l.city)).toEqual(["Berlin", "München"]);
    expect(locations).toHaveLength(3);
  });

  it("prioritises selected-market locations in compact cards", () => {
    expect(preferredLocationLabels(locations, "DE", 2)).toEqual(["Berlin", "München"]);
    expect(preferredLocationLabels(locations, "DE", 1)).toEqual(["Berlin"]);
    expect(preferredLocationLabels(locations, "FR", 1)).toEqual(["Amsterdam"]);
  });
});

describe("experience and seniority helpers", () => {
  it("formats and validates experience ranges", () => {
    expect(formatExperienceRange(null, null)).toBe("Not explicitly stated");
    expect(formatExperienceRange(3, null)).toBe("3+ years");
    expect(formatExperienceRange(null, 5)).toBe("Up to 5 years");
    expect(formatExperienceRange(3, 5)).toBe("3–5 years");
    expect(formatExperienceRange(3, 3)).toBe("3 years");
    expect(isValidExperienceRange(5, 3)).toBe(false);
    expect(isValidExperienceRange(null, 3)).toBe(true);
  });

  it("recognises seniority values", () => {
    expect(isSeniority("senior")).toBe(true);
    expect(isSeniority("wizard")).toBe(false);
    expect(isSeniority(null)).toBe(false);
  });
});
