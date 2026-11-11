import { z } from "zod";
import { MCP_MAX_RESULTS_CAP } from "@/lib/config/schemas/mcp";
import { reloadConfig } from "@/lib/config";
import { loadInsightsView } from "@/lib/insights/load";
import { ToolFailure, type McpContext } from "../context";
import { insightsOutputFor } from "../dto/insights";
import { readTextCleaner } from "../read-guard";
import { limitReadOutput, readNotices } from "./read-shared";
import { readTraps, resultLimit } from "./shared";

export function getInsightsInput(ctx: Pick<McpContext, "text">) {
  return z.strictObject({ range: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().describe(ctx.text("params.insightsRange")), limit: z.number().int().min(1).max(MCP_MAX_RESULTS_CAP).optional().describe(ctx.text("params.limit")) });
}
export async function getInsights(ctx: McpContext, args: z.infer<ReturnType<typeof getInsightsInput>>) {
  if (args.range !== undefined && !reloadConfig("insights").ranges_days.includes(args.range)) throw new ToolFailure("invalid_input", ctx.text("errors.insightsRange"));
  const view = await loadInsightsView(args.range ?? null, ctx.now(), ctx.text.locale ?? "en", ctx.db);
  const clean = readTextCleaner(readTraps(ctx), ctx.text("notice.redacted"));
  const profile = ctx.permissions?.has("profile:read") ?? false;
  const limit = resultLimit(ctx, args.limit);
  const histogram = (row: { from: number; to: number | null; count: number }) => ({ from: row.from, to: row.to, count: row.count });
  return limitReadOutput(ctx, insightsOutputFor(ctx.permissions ?? new Set()), {
    notices: readNotices(ctx, 0, 0, limit, false), truncated: false, range_days: view.rangeDays, window: { from: view.window.from, to: view.window.to }, text_withheld: null,
    kpi: { total: view.kpi.total, previous_total: view.kpi.previousTotal, change: view.kpi.change, passed: view.kpi.passed, pass_rate: view.kpi.passRate, previous_pass_rate: view.kpi.previousPassRate, pass_rate_change_pt: view.kpi.passRateChangePt, salary_rate: view.kpi.salaryRate, avg_rank: view.kpi.avgRank },
    daily: view.daily.columns.map((row) => ({ day: row.day, passed: row.passed, filtered: row.filtered, avg_rank: row.avgRank })),
    sources: [...view.sources.rows].sort((a, b) => b.total - a.total).map((row) => ({ family: clean(row.family), total: row.total, passed: row.passed, pass_rate: row.passRate })),
    ...(profile ? { cities: [...view.cities.rows].sort((a, b) => b.count - a.count).map((row) => ({ kind: row.kind, city: row.city === null ? null : clean(row.city), count: row.count, share: row.share })) } : {}),
    salary: { passed: view.salary.passed, disclosed: view.salary.disclosed, comparable: view.salary.comparable, rate: view.salary.rate, median_per_year: view.salary.medianEurPerYear, currency: clean(view.salary.currency), bars: view.salary.bars.map(histogram) },
    signals: { passed: view.signals.passed, without_signal: view.signals.withoutSignal, high_value: view.signals.highPay, avg_rank: view.signals.avgRank, ...(profile ? { categories: [...view.signals.tiers].sort((a, b) => b.jobs - a.jobs).map((row) => ({ id: clean(row.tier), label: clean(row.label), jobs: row.jobs, share: row.share, avg_rank: row.avgRank })) } : {}) },
    scores: { scored: view.scores.scored, pending: view.scores.pending, avg_rank: view.scores.avgRank, bars: view.scores.bars.map(histogram) },
    conversion: { fetched: view.conversion.fetched, passed: view.conversion.passed, pushable: view.conversion.pushable },
    ...(ctx.permissions?.has("match:read") ? { match: { filters: [...view.filters.rows].sort((a, b) => b.jobs - a.jobs).map((row) => ({ code: clean(row.code), jobs: row.jobs, share: row.share })) } } : {}),
    ...(ctx.permissions?.has("tracking:read") ? { tracking: { applied: view.kpi.applied, funnel: view.funnel.rows.map((row) => ({ stage: row.key, count: row.count, conversion: row.conversion })), exits: { rejected: view.funnel.exits.rejected, withdrawn: view.funnel.exits.withdrawn, archived: view.funnel.exits.archived } } } : {}),
  }, limit, ["daily", "salary.bars", "scores.bars", "tracking.funnel"]);
}
