import { z } from "zod";
import { loadBlocks } from "@/lib/capabilities/blocks";
import { MCP_MAX_RESULTS_CAP } from "@/lib/config/schemas/mcp";
import { getJobDetails } from "@/lib/db/queries/job-detail";
import { ToolFailure, type McpContext } from "../context";
import { getApplicationOutputFor } from "../dto/read-tracking";
import { loadTrackingByJob } from "../job-blocks/tracking";
import { readTextCleaner } from "../read-guard";
import { applicationDetailNotesBlocks } from "../tracking-blocks";
import { limitReadOutput, readNotices } from "./read-shared";
import { readTraps, resultLimit } from "./shared";

export function getApplicationInput(ctx: Pick<McpContext, "text">) {
  return z.strictObject({ job_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(ctx.text("params.jobId")), limit: z.number().int().min(1).max(MCP_MAX_RESULTS_CAP).optional().describe(ctx.text("params.limit")) });
}
export async function getApplication(ctx: McpContext, args: z.infer<ReturnType<typeof getApplicationInput>>) {
  const items = await assembleApplications(ctx, [args.job_id], resultLimit(ctx, args.limit));
  const item = items.get(args.job_id);
  if (item === undefined) throw new ToolFailure("not_found", ctx.text("errors.applicationNotFound", { id: args.job_id }));
  return item;
}

export async function assembleApplications(ctx: McpContext, jobIds: readonly number[], limit: number, include?: readonly string[]) {
  if (jobIds.length === 0) return new Map<number, z.infer<ReturnType<typeof getApplicationOutputFor>>>();
  const details = await getJobDetails(ctx.db, jobIds);
  const applications = [...details.values()].flatMap((detail) => detail.application ? [{ detail, application: detail.application }] : []);
  const clean = readTextCleaner(readTraps(ctx), ctx.text("notice.redacted"));
  const tracking = await loadTrackingByJob(ctx, applications.map(({ detail }) => detail), clean);
  const blocks = include === undefined ? applicationDetailNotesBlocks : applicationDetailNotesBlocks.filter(({ key }) => include.includes(key));
  const output = getApplicationOutputFor(ctx.permissions ?? new Set());
  const items = await Promise.all(applications.map(async ({ detail, application }) => {
    const fields = await loadBlocks(blocks, ctx, { application, events: detail.applicationEvents, clean }, include);
    const total = detail.applicationEvents.length;
    const returned = Math.min(total, limit);
    const value = limitReadOutput(ctx, output, {
      notices: readNotices(ctx, returned, total, limit, false), total, returned, truncated: total > limit,
      job_id: detail.id, title: clean(detail.title), company: clean(detail.company.name), text_withheld: null,
      tracking: tracking.get(detail.id)!, ...fields,
    }, limit);
    return [detail.id, value] as const;
  }));
  return new Map(items);
}
