import { describe, expect, it } from "vitest";

import { describeSalary } from "@/lib/dashboard/salary";
import { signalAmountLabel } from "@/lib/dashboard/signal-label";
import { nextScheduledCycle } from "@/lib/dashboard/next-cycle";
import { asContract, asGermanLevel, asJobLanguage, parseLocations, parseSalary } from "@/lib/db/queries/parse";
import type { JobSalary } from "@/lib/domain/types";

import { shippedSchedule } from "../channels/helpers";
import { asSalary } from "../helpers/salary";

describe("signalAmountLabel", () => {
  it("formats ranges, upper bounds and single amounts", () => {
    expect(signalAmountLabel({ min: 85000, max: 105000, currency: "EUR" }, "en")).toBe("€85–105k");
    expect(signalAmountLabel({ max: 120000, currency: "EUR" }, "en")).toBe("≤ €120k");
    expect(signalAmountLabel({ amount: 86400, currency: "EUR" }, "zh")).toBe("€86.4k");
  });
  it("keeps one decimal only for a range narrower than 10k, like formatSalary", () => {
    expect(signalAmountLabel({ min: 139320, max: 163400, currency: "EUR" }, "en")).toBe("€139–163k");
    expect(signalAmountLabel({ min: 92500, max: 100000, currency: "EUR" }, "en")).toBe("€92.5–100k");
  });
  it("returns null when nothing readable is there (C3: no guessing)", () => {
    expect(signalAmountLabel({ percent: 10 }, "en")).toBeNull();
    expect(signalAmountLabel("x", "en")).toBeNull();
    expect(signalAmountLabel(null, "en")).toBeNull();
  });
});

const salary = (over: Partial<JobSalary> = {}): JobSalary => asSalary({
  raw: "85-105k per year",
  currency: "EUR",
  period: "year",
  min: 85000,
  max: 105000,
  perYear: { min: 85000, max: 105000 },
  eurPerYear: { min: 85000, max: 105000 },
  periodAssumed: false,
  origin: "text",
  qualityStatus: "valid",
  reasonCodes: [],
  ...over,
});

describe("describeSalary (every salary text is formatSalary's)", () => {
  const base = { raw: "85-105k per year", periodAssumed: false, otherRegion: null, includesVariable: false, eurApprox: null };
  it("normalizes with currency and period", () => {
    expect(describeSalary(salary(), "en")).toEqual({ normalized: "€85–105k /yr", ...base });
    expect(describeSalary(salary(), "zh").normalized).toBe("€85–105k /年");
  });
  it("prefers the per-year amounts of a monthly salary", () => {
    const monthly = salary({ min: 7200, max: 7200, period: "month", perYear: { min: 86400, max: 86400 }, raw: "7.200 € pro Monat" });
    expect(describeSalary(monthly, "en").normalized).toBe("≈ €86k /yr"); // converted: an estimate, whole k
  });
  it("falls back to the stated amounts and period without per-year numbers", () => {
    const hourly = salary({ min: 60, max: 80, period: "hour", perYear: null, eurPerYear: null });
    expect(describeSalary(hourly, "en").normalized).toBe("€60–80 /h");
  });
  it("labels one-sided bounds", () => {
    const capped = salary({ min: null, max: 120000, perYear: { min: null, max: 120000 } });
    expect(describeSalary(capped, "en").normalized).toBe("up to €120k /yr");
    expect(describeSalary(capped, "zh").normalized).toBe("最高 €120k /年");
  });
  it("writes the EUR figure of another currency in whole k, behind ≈", () => {
    const usd = salary({ currency: "USD", min: 150000, max: 180000, perYear: { min: 150000, max: 180000 }, eurPerYear: { min: 139320, max: 163400 } });
    expect(describeSalary(usd, "zh")).toMatchObject({ normalized: "$150–180k /年", eurApprox: "≈ €139–163k /年" });
  });
  it("flags an assumed period and keeps only the raw text when there are no numbers", () => {
    expect(describeSalary(salary({ periodAssumed: true }), "en").periodAssumed).toBe(true);
    const textOnly = salary({ min: null, max: null, perYear: null, eurPerYear: null, raw: "negotiable" });
    expect(describeSalary(textOnly, "en")).toEqual({ normalized: null, eurApprox: null, raw: "negotiable", periodAssumed: false, otherRegion: null, includesVariable: false });
  });
});

describe("parse helpers", () => {
  it("parseSalary: null is undisclosed; JSON that does not match the stored shape reads as null too", () => {
    expect(parseSalary(null)).toBeNull();
    expect(parseSalary(salary())).toMatchObject({ min: 85000, max: 105000 });
    expect(parseSalary("weird")).toBeNull();
    expect(parseSalary({ min: 1 })).toBeNull();
  });
  it("parseLocations drops unreadable entries and puts the primary first", () => {
    const berlin = { label: "Berlin, DE", city: "Berlin", countryCode: "DE", isPrimary: false };
    const koeln = { label: "Köln", city: "Köln", countryCode: "DE", isPrimary: true };
    expect(parseLocations([berlin, 5, { city: "x" }, koeln])).toEqual([koeln, berlin]);
    expect(parseLocations("nope")).toEqual([]);
  });
  it("narrows text columns to the pipeline vocabulary, unknown otherwise (C3)", () => {
    expect(asContract("fixed_term")).toBe("fixed_term");
    expect(asContract("whatever")).toBe("unknown");
    expect(asGermanLevel("B2")).toBe("B2");
    expect(asGermanLevel("fluent")).toBe("unknown");
    expect(asJobLanguage("de")).toBe("de");
    expect(asJobLanguage("xx")).toBe("unknown");
  });
});

describe("nextScheduledCycle", () => {
  it("picks the soonest enabled slot in the schedule's time zone", () => {
    const schedule = shippedSchedule();
    // Wednesday 2026-10-07 10:00 Berlin (08:00 UTC): the next slot is the 17:00 evening run
    const next = nextScheduledCycle(schedule, new Date("2026-10-07T08:00:00Z"));
    expect(next?.kind).toBe("weekday_evening");
    expect(next?.at.toISOString()).toBe("2026-10-07T15:00:00.000Z");
  });
  it("skips disabled cycles", () => {
    const base = shippedSchedule();
    const schedule = { ...base, cycles: { ...base.cycles, weekday_evening: { ...base.cycles.weekday_evening, enabled: false } } };
    const next = nextScheduledCycle(schedule, new Date("2026-10-07T08:00:00Z"));
    expect(next?.kind).toBe("weekday_morning");
    expect(next?.at.toISOString()).toBe("2026-10-08T05:00:00.000Z");
  });
});
