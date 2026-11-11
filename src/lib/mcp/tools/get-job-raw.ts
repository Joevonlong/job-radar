import { z } from "zod";

import { getRawPostingsForJob } from "@/lib/db/queries/raw-postings";
import { ToolFailure, type McpContext } from "../context";
import { getJobRawOutput, toRawPostingDtos } from "../dto/raw";
import { readTextCleaner } from "../read-guard";
import { readTraps } from "./shared";

export function getJobRawInput(ctx: Pick<McpContext, "text">) {
  return z.strictObject({
    job_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(ctx.text("params.jobId")),
  });
}

export async function getJobRaw(ctx: McpContext, args: z.infer<ReturnType<typeof getJobRawInput>>) {
  const rows = await getRawPostingsForJob(ctx.db, args.job_id);
  if (rows === null) throw new ToolFailure("not_found", ctx.text("errors.notFound", { id: args.job_id }));
  const limit = ctx.settings.limits.max_raw_chars;
  const clean = readTextCleaner(readTraps(ctx), ctx.text("notice.redacted"));
  const sources = toRawPostingDtos(rows, limit, clean);
  const truncated = sources.some((source) => source.truncated);
  const notices = [ctx.text("notice.rawThirdParty"), ctx.text("notice.thirdParty")];
  if (truncated) notices.push(ctx.text("notice.rawTruncated", { limit }));
  return getJobRawOutput.parse({ notices, job_id: args.job_id, sources, truncated });
}
