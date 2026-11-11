import { z } from "zod";

import { includeInput, loadBlocks } from "@/lib/capabilities/blocks";
import { getJobDetail } from "@/lib/db/queries/job-detail";
import { loadTrapCounts } from "@/lib/db/repos/traps";
import { cleanDescriptionStrict } from "@/lib/traps/clean";
import { getJobBlocks } from "@/lib/mcp/job-blocks";
import type { JobBlockSource } from "@/lib/mcp/job-blocks/source";

import { ToolFailure, type McpContext } from "../context";
import { getJobOutput, getJobOutputFor, toJobDetailDto, type DescriptionDto, type GetJobOutput } from "../dto";
import { availableDescription, jdQuoteGuard, quoteGuard, shortFieldCleaner, unavailableDescription } from "../guard";
import { readTraps } from "./shared";

export function getJobInput(ctx: Pick<McpContext, "text">) {
  return z.strictObject({
    job_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(ctx.text("params.jobId")),
    include: includeInput(getJobBlocks, ctx.text("params.include")),
  });
}

export type GetJobArgs = z.infer<ReturnType<typeof getJobInput>>;

/**
 * One job in detail. The JD is given only after the AI-trap findings were removed (`cleanDescriptionStrict`): when trap detection
 * is off, traps.yaml cannot be read, the job was not scanned under the current rules or its findings cannot be read, the JD is
 * withheld and the result says why, and so are the signal quotes. A quote that overlaps a finding is that finding's marker. With
 * findings, the trap header comes first in the notices.
 */
export async function getJob(ctx: McpContext, args: GetJobArgs): Promise<GetJobOutput> {
  const detail = await getJobDetail(ctx.db, args.job_id);
  if (!detail) throw new ToolFailure("not_found", ctx.text("errors.notFound", { id: args.job_id }));

  const [strict, counts] = await Promise.all([cleanDescriptionStrict(ctx.db, { jobId: detail.id, description: detail.description }, { settings: ctx.traps }), loadTrapCounts(ctx.db, [detail.id])]);
  const limit = ctx.settings.limits.max_description_chars;
  const notices: string[] = [];
  let description: DescriptionDto;
  if (strict.ok) {
    description = availableDescription(strict.text, limit);
    if (strict.removed > 0) notices.push(ctx.text("notice.traps", { count: strict.removed }));
    if (description.truncated) notices.push(ctx.text("description.truncated", { limit, total: description.total_chars ?? 0 }));
  } else {
    description = unavailableDescription(strict.reason, ctx.text("description.unavailable"));
  }
  notices.push(ctx.text("notice.thirdParty"));

  const clean = shortFieldCleaner(readTraps(ctx));
  const guard = jdQuoteGuard(strict, detail.description);
  const source: JobBlockSource = { detail, strict, clean, quote: (quote, offset) => {
    const guarded = guard(quote, offset);
    return guarded === null ? null : clean(guarded);
  } };
  const job = toJobDetailDto(detail, { traps: counts.get(detail.id) ?? null, description, quote: quoteGuard(strict, detail.description) }, clean);
  const blocks = await loadBlocks(getJobBlocks, ctx, source, args.include);
  const derived = getJobOutput.parse({ notices, job, ...blocks });
  if ((derived.translation?.items.length ?? 0) > 0 || derived.breakdown?.content != null || (derived.company?.fields.length ?? 0) > 0 || derived.salary?.lookup?.available || (derived.match?.fit_reasons.length ?? 0) > 0 || (derived.match?.gaps.length ?? 0) > 0 || Object.keys(derived.match?.summaries ?? {}).length > 0) notices.push(ctx.text("notice.derived"));
  if ([derived.translation, derived.breakdown, derived.company, derived.salary?.lookup, derived.match].some((block) => block?.available === false && block.reason !== null)) notices.push(ctx.text("notice.derivedWithheld"));
  return getJobOutputFor(ctx.permissions ?? new Set()).parse({ notices, job, ...blocks });
}
