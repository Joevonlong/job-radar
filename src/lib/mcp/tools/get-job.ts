import { z } from "zod";

import { includeInput } from "@/lib/capabilities/blocks";
import { getJobBlocks } from "@/lib/mcp/job-blocks";
import { assembleJobBlocks } from "@/lib/mcp/job-blocks/assemble";

import { ToolFailure, type McpContext } from "../context";
import { getJobOutputFor, type GetJobOutput } from "../dto";

export function getJobInput(ctx: Pick<McpContext, "text">) {
  return z.strictObject({
    job_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(ctx.text("params.jobId")),
    include: includeInput(getJobBlocks, ctx.text("params.include")),
  });
}

export type GetJobArgs = z.infer<ReturnType<typeof getJobInput>>;

/** The JD and derived text are covered by the current trap scan, and tracking fields require tracking permission. */
export async function getJob(ctx: McpContext, args: GetJobArgs): Promise<GetJobOutput> {
  const jobs = await assembleJobBlocks(ctx, [args.job_id], {
    blocks: getJobBlocks,
    include: args.include,
    output: getJobOutputFor(ctx.permissions ?? new Set()),
    inTransaction: false,
  });
  const job = jobs.get(args.job_id);
  if (!job) throw new ToolFailure("not_found", ctx.text("errors.notFound", { id: args.job_id }));
  return job;
}
