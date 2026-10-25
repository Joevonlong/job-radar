/** Pure text and JSON output of the salary benchmark command. */
import type { SalaryBenchmarkRow } from "@/lib/db/repos/salary-benchmarks";

import type { BenchmarkRefreshResult } from "./benchmark";

type ReportTranslator = (key: "cli.disabled" | "cli.summary", values?: Record<string, string | number>) => string;

export function formatBenchmarkText(result: BenchmarkRefreshResult | null, rows: readonly SalaryBenchmarkRow[], t: ReportTranslator): string {
  if (!result) return t("cli.disabled");
  const summary = t("cli.summary", { groups: result.groups, postings: result.postings, currency: result.currency });
  const groups = rows.map((row) => {
    const q = Array.isArray(row.quantiles) ? row.quantiles : [];
    return `${row.roleFamily.padEnd(22)} ${row.seniority.padEnd(10)} ${`${row.geoLevel}:${row.geoKey}`.padEnd(28)} n=${String(row.n).padStart(4)}  p10 ${String(q[0] ?? "-")}  p50 ${String(row.median)}  p90 ${String(q[8] ?? "-")}`;
  });
  return [summary, ...groups].join("\n");
}

export function benchmarkJson(result: BenchmarkRefreshResult | null, rows: readonly SalaryBenchmarkRow[]) {
  return {
    result: result ? { groups: result.groups, postings: result.postings, currency: result.currency } : null,
    groups: rows.map((row) => ({ family: row.roleFamily, seniority: row.seniority, geoLevel: row.geoLevel, geoKey: row.geoKey, currency: row.currency, n: row.n, median: row.median, quantiles: row.quantiles })),
  };
}
