import type { TrapsConfig } from "@/lib/config/schemas/traps";
import { getJob } from "@/lib/db/repos/jobs";
import { cleanDescriptionStrict } from "@/lib/traps/clean";

import type { McpContext } from "../context";
import { jdQuoteGuard } from "../guard";

/** Each referenced job's JD quotes follow its current trap scan; absent jobs have no quotable evidence. */
export async function loadJobQuoteGuard(
  ctx: Pick<McpContext, "db" | "traps">,
  jobIds: readonly number[],
): Promise<(jobId: number, quote: string) => string | null> {
  const guards = new Map<number, ReturnType<typeof jdQuoteGuard>>();
  await Promise.all([...new Set(jobIds)].map(async (jobId) => {
    const job = await getJob(ctx.db, jobId);
    if (!job) return;
    const strict = await cleanDescriptionStrict(ctx.db, { jobId, description: job.description }, { settings: ctx.traps });
    guards.set(jobId, jdQuoteGuard(strict, job.description));
  }));
  return (jobId, quote) => guards.get(jobId)?.(quote, null) ?? null;
}

/** traps.yaml, or null when it cannot be read (short fields then only lose their invisible characters). */
export function readTraps(ctx: Pick<McpContext, "traps">): TrapsConfig | null {
  try {
    return ctx.traps();
  } catch {
    return null;
  }
}

/** How many items one call returns: what the caller asked for, never more than mcp.yaml `limits.max_results`. */
export function resultLimit(ctx: Pick<McpContext, "settings">, asked: number | undefined): number {
  const cap = ctx.settings.limits.max_results;
  return Math.min(asked ?? cap, cap);
}

export function truncationNotice(ctx: Pick<McpContext, "text">, returned: number, total: number, limit: number): string {
  return ctx.text("notice.truncated", { returned, total, limit });
}
