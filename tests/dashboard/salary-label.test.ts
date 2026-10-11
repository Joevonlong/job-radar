// @vitest-environment node
import { describe, expect, it } from "vitest";

import { annualSalaryLabel } from "@/lib/dashboard/salary";
import { pickListSummary } from "@/lib/dashboard/summary";
import { normalizeSalary } from "@/lib/pipeline/salary";
import type { JobSalary } from "@/lib/domain/types";

import { draft, shippedPipeline } from "../pipeline/helpers";
import { asSalary } from "../helpers/salary";

const salary = (over: Partial<JobSalary> = {}): JobSalary => asSalary({
  raw: "x",
  currency: "EUR",
  period: "year",
  min: null,
  max: null,
  perYear: null,
  eurPerYear: null,
  periodAssumed: false,
  origin: "text",
  qualityStatus: "valid",
  reasonCodes: [],
  ...over,
});

describe("annualSalaryLabel (the 💰 text of a list row)", () => {
  it("writes the normalized annual EUR range, symbol and k once", () => {
    expect(annualSalaryLabel(salary({ eurPerYear: { min: 85000, max: 105000 } }), "en")).toBe("€85–105k");
    expect(annualSalaryLabel(salary({ eurPerYear: { min: 92000, max: 94000 } }), "zh")).toBe("€92–94k");
    expect(annualSalaryLabel(salary({ eurPerYear: { min: 71000, max: 91700 } }), "en")).toBe("€71–92k");
  });

  it("writes one figure, a cap and a floor", () => {
    expect(annualSalaryLabel(salary({ eurPerYear: { min: 90000, max: 90000 } }), "en")).toBe("€90k");
    expect(annualSalaryLabel(salary({ eurPerYear: { min: null, max: 120000 } }), "en")).toBe("≤ €120k");
    expect(annualSalaryLabel(salary({ eurPerYear: { min: 80000, max: null } }), "en")).toBe("≥ €80k");
  });

  it("uses the per-year amounts, not the stated ones: a monthly salary reads as per year", () => {
    expect(annualSalaryLabel(salary({ period: "month", min: 7200, max: 7200, perYear: { min: 86400, max: 86400 }, eurPerYear: { min: 86400, max: 86400 } }), "en")).toBe("≈ €86k");
  });

  it("hides a salary that is under review (never shown, not even as raw text)", () => {
    expect(annualSalaryLabel(salary({ qualityStatus: "review", eurPerYear: { min: 720, max: 720 } }), "en")).toBeNull();
  });

  it("falls back to the posting's own currency per year when there is no EUR figure, and to nothing without numbers", () => {
    expect(annualSalaryLabel(salary({ currency: "USD", perYear: { min: 182000, max: 250200 }, eurPerYear: null }), "en")).toBe("$182–250k");
    expect(annualSalaryLabel(salary({ currency: "USD", perYear: null, eurPerYear: null, min: 100, max: 120, period: "hour" }), "en")).toBeNull();
    expect(annualSalaryLabel(null, "en")).toBeNull();
  });
});

describe("pickListSummary", () => {
  it("picks the UI language, then the AI output language, then English, then any", () => {
    const both = { texts: { zh: "中文摘要", en: "English summary" }, outputLang: "zh" };
    expect(pickListSummary(both, "zh")).toBe("中文摘要");
    expect(pickListSummary(both, "en")).toBe("English summary");
    expect(pickListSummary({ texts: { zh: "中文摘要" }, outputLang: "zh" }, "en")).toBe("中文摘要");
    expect(pickListSummary({ texts: { en: "English summary" }, outputLang: "zh" }, "zh")).toBe("English summary");
    expect(pickListSummary({ texts: { fr: "Résumé", de: "Zusammenfassung" }, outputLang: "de" }, "zh")).toBe("Zusammenfassung");
    expect(pickListSummary(null, "en")).toBeNull();
  });
});

describe("annualSalaryLabel on salaries read by the pipeline ", () => {
  const config = shippedPipeline();
  const label = (over: Parameters<typeof draft>[0]) => annualSalaryLabel(normalizeSalary(draft(over), config), "en");

  it("shows a structured annual range", () => {
    expect(label({ salaryText: "EUR 85,000 - 105,000" })).toBe("€85–105k");
  });

  it("shows a salary read from a description clause", () => {
    expect(label({ description: "Salary: up to €120,000 per year.\nWe offer a relocation budget of €2,500." })).toBe("≤ €120k");
  });

  it("shows nothing for a benefit number (no salary read) and nothing for a needs-review salary", () => {
    expect(label({ description: "Relocation support: up to €2,500." })).toBeNull();
    expect(label({ salaryText: "EUR 5 per year" })).toBeNull();
  });
});
