import { z } from "zod";
import { MCP_MAX_RESULTS_CAP } from "@/lib/config/schemas/mcp";
import { loadTodayData } from "@/lib/dashboard/today-data";
import { MAX_FILTER_VALUE_CHARS } from "@/lib/jobs/constants";
import { localLanguageName } from "@/lib/market/view";
import type { McpContext } from "../context";
import { todayOutput } from "../dto/read-jobs";
import { readTextCleaner } from "../read-guard";
import { readTraps, resultLimit } from "./shared";
import { limitReadOutput, readCards, readNotices } from "./read-shared";

export function getTodayInput(ctx: Pick<McpContext, "text">) {
  return z.strictObject({ view: z.string().min(1).max(MAX_FILTER_VALUE_CHARS).optional().describe(ctx.text("params.view")), quick: z.enum(["high", "salary", "following"]).optional().describe(ctx.text("params.quick")), include_filtered: z.boolean().optional().describe(ctx.text("params.includeFiltered")), hide_language: z.boolean().optional().describe(ctx.text("params.hideLanguage")), high_value: z.boolean().optional().describe(ctx.text("params.highValue")), limit: z.number().int().min(1).max(MCP_MAX_RESULTS_CAP).optional().describe(ctx.text("params.limit")) });
}
export async function getToday(ctx: McpContext, args: z.infer<ReturnType<typeof getTodayInput>>) {
  const data = await loadTodayData(ctx.db, { view: args.view, quick: args.quick, filtered: args.include_filtered, hideLang: args.hide_language, high: args.high_value }, { now: ctx.now(), timezone: ctx.timezone(), languageEnabled: localLanguageName(ctx.text.locale ?? "en") !== null });
  const limit = resultLimit(ctx, args.limit);
  const jobs = await readCards(ctx, data.cards.slice(0, limit));
  const clean = readTextCleaner(readTraps(ctx), ctx.text("notice.redacted"));
  return limitReadOutput(ctx, todayOutput, { notices: readNotices(ctx, jobs.length, data.cards.length, limit, jobs.some((job) => job.text_withheld !== null)), total: data.cards.length, returned: jobs.length, truncated: data.cards.length > jobs.length, view: data.active ? clean(data.active.id) : null, quick: data.active ? null : data.quick, quick_counts: { all: data.quickCounts.all, high: data.quickCounts.high, salary: data.quickCounts.salary, following: data.quickCounts.following }, jobs }, limit);
}
