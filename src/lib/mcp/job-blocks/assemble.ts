import type { z } from "zod";

import { loadBlocks, type FieldBlock } from "@/lib/capabilities/blocks";
import { getJobDetails, type JobDetail } from "@/lib/db/queries/job-detail";
import { loadTrapCounts } from "@/lib/db/repos/traps";
import { cleanDescriptionsStrict, type StrictCleanResult } from "@/lib/traps/clean";

import type { McpContext } from "../context";
import { releasedJobDetail, toJobDetailDto, type GetJobOutput } from "../dto/jobs";
import type { SyncJobAssembly } from "../dto/sync";
import { availableDescription, jdQuoteGuard, quoteGuard, shortFieldCleaner, unavailableDescription } from "../guard";
import { readTextCleaner } from "../read-guard";
import { readTraps } from "../tools/shared";

import type { jobBlockSettings } from "./settings";
import type { JobBlockSource } from "./source";

/** Base facts and all field blocks share the supplied executor, including when it is a sync snapshot. */
export async function assembleJobBlocks<Output extends GetJobOutput | SyncJobAssembly>(
  ctx: McpContext,
  jobIds: readonly number[],
  options: {
    blocks: readonly FieldBlock<JobBlockSource>[];
    include: readonly string[] | undefined;
    output: z.ZodType<Output>;
    inTransaction: boolean;
    blockSettings?: ReturnType<typeof jobBlockSettings>;
  },
): Promise<Map<number, Output>> {
  const details = await getJobDetails(ctx.db, jobIds);
  if (details.size === 0) return new Map();
  const inputs = [...details.values()].map((detail) => ({ jobId: detail.id, description: detail.description }));
  const counts = await loadTrapCounts(ctx.db, [...details.keys()]);
  const cleaned = await cleanDescriptionsStrict(ctx.db, inputs, { settings: ctx.traps, inTransaction: options.inTransaction });
  const traps = readTraps(ctx);
  const clean = shortFieldCleaner(traps);
  const cleanText = readTextCleaner(traps, ctx.text("notice.redacted"));
  const permissions = ctx.permissions ?? new Set();
  const limit = ctx.settings.limits.max_description_chars;
  const results = await Promise.all([...details.values()].map(async (detail): Promise<[number, Output]> => {
    const strict = cleaned.get(detail.id)!;
    const { description, notices } = descriptionAndNotices(ctx, strict, limit);
    const source = blockSource(detail, strict, clean, cleanText, options.blockSettings);
    const job = toJobDetailDto(detail, { traps: counts.get(detail.id) ?? null, description, quote: quoteGuard(strict, detail.description) }, clean);
    if (job.application?.next_action != null) job.application.next_action = source.clean(job.application.next_action);
    const blocks = await loadBlocks(options.blocks, ctx, source, options.include);
    const value = options.output.parse({ notices, job: releasedJobDetail(job, permissions), ...blocks });
    addDerivedNotices(ctx, value);
    return [detail.id, value];
  }));
  return new Map(results);
}

function blockSource(detail: JobDetail, strict: StrictCleanResult, clean: (text: string) => string, cleanText: (text: string) => string, settings: JobBlockSource["settings"]): JobBlockSource {
  const guard = jdQuoteGuard(strict, detail.description);
  return { detail, strict, settings, clean: cleanText, quote: (quote, offset) => {
    const guarded = guard(quote, offset);
    return guarded === null ? null : clean(guarded);
  } };
}

function descriptionAndNotices(ctx: McpContext, strict: StrictCleanResult, limit: number) {
  const description = strict.ok
    ? availableDescription(strict.text, limit)
    : unavailableDescription(strict.reason, ctx.text("description.unavailable"));
  const notices: string[] = [];
  if (strict.ok && strict.removed > 0) notices.push(ctx.text("notice.traps", { count: strict.removed }));
  if (description.truncated) notices.push(ctx.text("description.truncated", { limit, total: description.total_chars ?? 0 }));
  notices.push(ctx.text("notice.thirdParty"));
  return { description, notices };
}

function addDerivedNotices(ctx: McpContext, value: GetJobOutput | SyncJobAssembly): void {
  if ((value.translation?.items.length ?? 0) > 0 || value.breakdown?.content != null || (value.company?.fields.length ?? 0) > 0 ||
    value.salary?.lookup?.available || (value.match?.fit_reasons.length ?? 0) > 0 || (value.match?.gaps.length ?? 0) > 0 ||
    Object.keys(value.match?.summaries ?? {}).length > 0) value.notices.push(ctx.text("notice.derived"));
  if ([value.translation, value.breakdown, value.company, value.salary?.lookup, value.match]
    .some((block) => block?.available === false && block.reason !== null)) value.notices.push(ctx.text("notice.derivedWithheld"));
}
