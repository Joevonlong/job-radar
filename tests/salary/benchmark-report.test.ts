// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { SalaryBenchmarkRow } from "@/lib/db/repos/salary-benchmarks";
import { translatorFor } from "@/lib/i18n/node";
import { benchmarkJson, formatBenchmarkText } from "@/lib/salary/benchmark-report";

const result = { groups: 1, postings: 3, currency: "EUR" };
const rows: SalaryBenchmarkRow[] = [{ id: 1, roleFamily: "engineer", seniority: "senior", geoLevel: "country", geoKey: "DE", currency: "EUR", n: 3, nAi: 0, median: 90000, quantiles: [82000, 84000, 86000, 88000, 90000, 92000, 94000, 96000, 98000], refreshedAt: new Date("2026-10-01T00:00:00Z") }];

describe("benchmark report", () => {
  it.each(["en", "zh"] as const)("prints posting-only summary and group lines in %s", (locale) => {
    const t = translatorFor(locale, "salary");
    const text = formatBenchmarkText(result, rows, t);
    const [summary, group] = text.split("\n");
    expect(summary).toBe(locale === "en" ? "Salary benchmark (EUR): 1 groups from 3 postings." : "薪资基准（EUR）：1 个组，来自 3 个岗位。");
    expect(summary).not.toMatch(/\{ai\}|AI/i);
    expect(group).toContain("n=   3");
    expect(group).toContain("p10 82000  p50 90000  p90 98000");
    expect(group).not.toContain("(ai");
    expect(text.split("\n")).toHaveLength(2);
    expect(formatBenchmarkText(null, [], t)).toBe(t("cli.disabled"));
  });

  it("omits AI fields from JSON, including older result objects passed at runtime", () => {
    const json = benchmarkJson({ ...result, ...{ aiObservations: 4 } }, rows);
    expect(json.result).toEqual(result);
    expect(json.groups).toEqual([{ family: "engineer", seniority: "senior", geoLevel: "country", geoKey: "DE", currency: "EUR", n: 3, median: 90000, quantiles: rows[0]?.quantiles }]);
    expect(JSON.stringify(json)).not.toMatch(/aiObservations|nAi/);
    expect(benchmarkJson(null, [])).toEqual({ result: null, groups: [] });
  });
});
