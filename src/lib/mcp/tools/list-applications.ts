import { z } from "zod";

import { MCP_MAX_RESULTS_CAP } from "@/lib/config/schemas/mcp";
import { listPipelineEntries, type PipelineEntry } from "@/lib/db/queries/pipeline";
import { APPLICATION_STATUSES, type ApplicationStatus } from "@/lib/db/repos/applications";

import type { McpContext } from "../context";
import { listApplicationsOutput, toApplicationItemDto, type ListApplicationsOutput } from "../dto";
import { shortFieldCleaner } from "../guard";
import { readTraps, resultLimit, truncationNotice } from "./shared";

const DAY_MS = 86_400_000;

export function listApplicationsInput(ctx: Pick<McpContext, "text">) {
  const t = ctx.text;
  return z.strictObject({
    status: z
      .array(z.enum(APPLICATION_STATUSES as [ApplicationStatus, ...ApplicationStatus[]]))
      .min(1)
      .max(APPLICATION_STATUSES.length)
      .optional()
      .describe(t("params.status")),
    stale_only: z.boolean().optional().describe(t("params.staleOnly")),
    limit: z.number().int().min(1).max(MCP_MAX_RESULTS_CAP).optional().describe(t("params.limit")),
  });
}

export type ListApplicationsArgs = z.infer<ReturnType<typeof listApplicationsInput>>;

/**
 * Waiting longer than the daily reminder's thresholds (notify.yaml `reminders`): `interested` for more than N days without applying,
 * `applied` for more than M days without an answer. The same rule as the reminder's query (`listStaleApplications`), applied to the
 * board's entries so one result shape serves both.
 */
export function isStale(entry: Pick<PipelineEntry, "application">, now: Date, days: { interested: number; applied: number }): boolean {
  const { status, statusChangedAt } = entry.application;
  if (status === "interested") return statusChangedAt.getTime() < now.getTime() - days.interested * DAY_MS;
  if (status === "applied") return statusChangedAt.getTime() < now.getTime() - days.applied * DAY_MS;
  return false;
}

/** The user's applications (the pipeline board), best rank first; `stale_only` lists the longest waiting first. Never notes or resume paths. */
export async function listApplications(ctx: McpContext, args: ListApplicationsArgs): Promise<ListApplicationsOutput> {
  const now = ctx.now();
  const days = args.stale_only ? ctx.reminderDays() : null;
  let entries = await listPipelineEntries(ctx.db);
  if (args.status) {
    const wanted = new Set<string>(args.status);
    entries = entries.filter((entry) => wanted.has(entry.application.status));
  }
  if (days) {
    entries = entries.filter((entry) => isStale(entry, now, days)).sort((a, b) => a.application.statusChangedAt.getTime() - b.application.statusChangedAt.getTime() || a.application.id - b.application.id);
  }
  const limit = resultLimit(ctx, args.limit);
  const clean = shortFieldCleaner(readTraps(ctx));
  const applications = entries.slice(0, limit).map((entry) => toApplicationItemDto(entry, now, clean));
  const truncated = entries.length > applications.length;
  const notices = [ctx.text("notice.thirdParty"), ...(truncated ? [truncationNotice(ctx, applications.length, entries.length, limit)] : [])];
  return listApplicationsOutput.parse({ notices, total: entries.length, returned: applications.length, truncated, applications } satisfies ListApplicationsOutput);
}
