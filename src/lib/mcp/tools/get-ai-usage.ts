import { z } from "zod";
import { loadAiUsageData } from "@/lib/ai-usage/load";
import { AI_USAGE_RANGE_KINDS } from "@/lib/ai-usage/range";
import { AI_PROVIDER_IDS, AI_TASK_NAMES } from "@/lib/config/ai-options";
import { MCP_MAX_RESULTS_CAP } from "@/lib/config/schemas/mcp";
import { ToolFailure, type McpContext } from "../context";
import { aiUsageOutput, toAiUsageDto } from "../dto/ops";
import { resultLimit } from "./shared";

export function getAiUsageInput(ctx: Pick<McpContext, "text">) {
  return z.strictObject({
    range: z.enum(AI_USAGE_RANGE_KINDS).optional().describe(ctx.text("ops.params.range")), from: z.iso.date().optional().describe(ctx.text("ops.params.from")), to: z.iso.date().optional().describe(ctx.text("ops.params.to")),
    provider: z.enum(AI_PROVIDER_IDS).optional().describe(ctx.text("ops.params.provider")), task: z.enum([...AI_TASK_NAMES, "probe"]).optional().describe(ctx.text("ops.params.task")),
    limit: z.number().int().min(1).max(MCP_MAX_RESULTS_CAP).optional().describe(ctx.text("params.limit")),
  }).refine((args) => args.range === "custom" ? args.from !== undefined && args.to !== undefined && args.from <= args.to : args.from === undefined && args.to === undefined, { message: ctx.text("ops.errors.range") });
}
export async function getAiUsage(ctx: McpContext, args: z.infer<ReturnType<typeof getAiUsageInput>>) {
  const data = await loadAiUsageData({ range: args.range ?? null, from: args.from ?? null, to: args.to ?? null, provider: args.provider ?? null, task: args.task ?? null, model: null, metric: null, page: null }, { db: ctx.db });
  if (data.range.invalid) throw new ToolFailure("invalid_input", ctx.text("ops.errors.range"));
  const knownModelIds = new Set(Object.values(data.catalog?.providers ?? {}).flatMap((provider) => provider.models.map((model) => model.id)));
  const usage = toAiUsageDto(data.groups, knownModelIds);
  const limit = resultLimit(ctx, args.limit);
  const byDay = usage.by_day.slice(0, limit);
  const byTask = usage.by_task.slice(0, limit);
  const byModel = usage.by_model.slice(0, limit);
  return aiUsageOutput.parse({ notices: [], from: data.range.from, to: data.range.to, time_zone: data.timeZone, returned: byDay.length + byTask.length + byModel.length,
    truncated: usage.by_day.length > limit || usage.by_task.length > limit || usage.by_model.length > limit, totals: usage.totals, by_day: byDay, by_task: byTask, by_model: byModel });
}
