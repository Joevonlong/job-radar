import { loadBlocks } from "@/lib/capabilities/blocks";
import { applicationNotesBlocks } from "../tracking-blocks";
import { readSourceUrl, readTextAccess, readTextCleaner } from "../read-guard";
import { readJobTexts } from "@/lib/db/queries/read-texts";
import { listApplicationsOutputFor } from "../dto/tracking";
import { z } from "zod";

import { MCP_MAX_RESULTS_CAP } from "@/lib/config/schemas/mcp";
import { listPipelineEntries, type PipelineEntry } from "@/lib/db/queries/pipeline";
import { APPLICATION_STATUSES, type ApplicationStatus } from "@/lib/db/repos/applications";

import type { McpContext } from "../context";
import { toApplicationItemDto, type ListApplicationsOutput } from "../dto";
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

/** The user's applications (the pipeline board), best rank first; `stale_only` lists the longest waiting first. Application notes require notes permission. */
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
  const clean = readTextCleaner(readTraps(ctx), ctx.text("notice.redacted"));
  const selected = entries.slice(0, limit);
  const texts = new Map((await readJobTexts(ctx.db, selected.map((entry) => entry.job.id))).map((job) => [job.jobId, job]));
  let withheld = false;
  const applications = await Promise.all(selected.map(async (entry) => {
    const text = texts.get(entry.job.id);
    const access = await readTextAccess(ctx, text ? [text] : []);
    withheld ||= access.reason !== null;
    const item = toApplicationItemDto(entry, now, clean);
    return { ...item, title: access.text(entry.job.title) ?? "", company: access.text(entry.job.companyName) ?? "", links: access.reason !== null ? [] : entry.job.sources.map((source) => ({ source: access.text(source.family) ?? "", url: readSourceUrl(source.url, access), apply_url: readSourceUrl(source.applyUrl, access) })), ...await loadBlocks(applicationNotesBlocks, ctx, { ...entry, clean }, undefined) };
  }));
  const truncated = entries.length > applications.length;
  const notices = [ctx.text("notice.thirdParty"), ...(withheld ? [ctx.text("notice.derivedWithheld")] : []), ...(truncated ? [truncationNotice(ctx, applications.length, entries.length, limit)] : [])];
  return listApplicationsOutputFor(ctx.permissions ?? new Set()).parse({ notices, total: entries.length, returned: applications.length, truncated, applications } satisfies ListApplicationsOutput);
}
