import { z } from "zod";
import { loadBlocks } from "@/lib/capabilities/blocks";
import { MCP_MAX_RESULTS_CAP } from "@/lib/config/schemas/mcp";
import { getJobDetail } from "@/lib/db/queries/job-detail";
import { ToolFailure, type McpContext } from "../context";
import { getApplicationOutputFor } from "../dto/read-tracking";
import { loadTracking } from "../job-blocks/tracking";
import { readTextAccess } from "../read-guard";
import { applicationDetailNotesBlocks } from "../tracking-blocks";
import { limitReadOutput, readNotices } from "./read-shared";
import { resultLimit } from "./shared";

export function getApplicationInput(ctx: Pick<McpContext, "text">) {
  return z.strictObject({ job_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(ctx.text("params.jobId")), limit: z.number().int().min(1).max(MCP_MAX_RESULTS_CAP).optional().describe(ctx.text("params.limit")) });
}
export async function getApplication(ctx: McpContext, args: z.infer<ReturnType<typeof getApplicationInput>>) {
  const detail = await getJobDetail(ctx.db, args.job_id);
  if (detail?.application == null) throw new ToolFailure("not_found", ctx.text("errors.applicationNotFound", { id: args.job_id }));
  const anchor = { jobId: detail.id, description: detail.description };
  const access = await readTextAccess(ctx, [anchor]);
  const tracking = await loadTracking(ctx, { detail, clean: access.clean });
  const notes = await loadBlocks(applicationDetailNotesBlocks, ctx, { application: detail.application, events: detail.applicationEvents, clean: access.clean }, undefined);
  const limit = resultLimit(ctx, args.limit);
  const total = detail.applicationEvents.length;
  return limitReadOutput(ctx, getApplicationOutputFor(ctx.permissions ?? new Set()), { notices: readNotices(ctx, Math.min(total, limit), total, limit, access.reason !== null), total, returned: Math.min(total, limit), truncated: total > limit, job_id: detail.id, title: access.text(detail.title), company: access.text(detail.company.name), text_withheld: access.reason, tracking, ...notes }, limit);
}
