import { z } from "zod";
import { loadActivityDetailData, loadActivityListData } from "@/lib/activity/data";
import { activitySearchSchema } from "@/lib/activity/search";
import { MCP_MAX_RESULTS_CAP } from "@/lib/config/schemas/mcp";
import { ToolFailure, type McpContext } from "../context";
import { activityLogOutput, toActivityRootDto, toActivitySpanDto, toActivityEventDto } from "../dto/ops";
import { resultLimit } from "./shared";

export function getActivityLogInput(ctx: Pick<McpContext, "text">) {
  return z.strictObject({
    root_id: z.uuid().optional().describe(ctx.text("ops.params.rootId")), page: z.number().int().safe().positive().optional().describe(ctx.text("ops.params.page")),
    limit: z.number().int().min(1).max(MCP_MAX_RESULTS_CAP).optional().describe(ctx.text("params.limit")),
    scope: z.enum(["cycle", "request", "system"]).optional().describe(ctx.text("ops.params.scope")), status: z.enum(["active", "failed", "partial"]).optional().describe(ctx.text("ops.params.status")),
    from: z.iso.date().optional().describe(ctx.text("ops.params.from")), to: z.iso.date().optional().describe(ctx.text("ops.params.to")),
    level: z.enum(["info", "warn", "error"]).optional().describe(ctx.text("ops.params.level")), issues_only: z.boolean().optional().describe(ctx.text("ops.params.issues")),
  }).refine((args) => (args.from === undefined && args.to === undefined) || (args.from !== undefined && args.to !== undefined && args.from <= args.to), { message: ctx.text("ops.errors.range") });
}
export async function getActivityLog(ctx: McpContext, args: z.infer<ReturnType<typeof getActivityLogInput>>) {
  const limit = resultLimit(ctx, args.limit);
  const params = activitySearchSchema.parse({ type: args.scope, status: args.status, page: args.page, level: args.level, issues: args.issues_only ? "1" : undefined, range: args.from ? "custom" : undefined, from: args.from, to: args.to });
  const options = { db: ctx.db, pageSize: limit, newestFirst: true };
  const empty = { notices: [], page: params.page, total: 0, returned: 0, truncated: false, roots: [], detail: null };
  if (args.root_id) {
    const data = await loadActivityDetailData(args.root_id, params, options);
    if (data.state === "error") throw new ToolFailure("database", ctx.text("ops.errors.activityUnavailable"));
    if (data.state !== "ready") return activityLogOutput.parse({ ...empty, state: data.state });
    const spans = data.spans.slice().reverse().slice(0, limit).map(toActivitySpanDto);
    const events = data.events.rows.map(toActivityEventDto);
    return activityLogOutput.parse({ ...empty, state: "ready", page: data.url.page, total: data.events.total, returned: events.length, truncated: data.events.total > events.length || data.spans.length > spans.length,
      detail: { root: toActivityRootDto(data.root), spans, spans_truncated: data.spans.length > spans.length, events, events_total: data.events.total } });
  }
  const data = await loadActivityListData(params, options);
  if (data.state === "error") throw new ToolFailure("database", ctx.text("ops.errors.activityUnavailable"));
  if (data.state !== "ready") return activityLogOutput.parse({ ...empty, state: data.state });
  const roots = data.rows.map(toActivityRootDto);
  return activityLogOutput.parse({ ...empty, state: "ready", page: data.url.page, total: data.total, returned: roots.length, truncated: data.total > roots.length, roots });
}
