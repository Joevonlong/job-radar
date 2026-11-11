import type { Permission } from "@/lib/agent-access/permissions";
import { blockShape } from "@/lib/capabilities/blocks";
import { applicationNotesBlocks, applicationNotesDto } from "../tracking-blocks";
/** Application status, history and list outputs omit notes and local paths. */
import { z } from "zod";

import type { JobCard } from "@/lib/db/queries/types";
import type { Application, ApplicationEvent } from "@/lib/db/repos/applications";

import { iso, isoOf, isoOrNull, linkDto, notices, toLinkDto, type CleanText } from "./shared";

export const applicationDto = z.strictObject({
  status: z.string(),
  status_changed_at: iso,
  next_action: z.string().nullable(),
  next_action_at: iso.nullable(),
  interview_rounds: z.number().int(),
});

export const historyDto = z.strictObject({ from: z.string().nullable(), to: z.string(), at: iso });

export const applicationItemDto = z.strictObject({
  job_id: z.number().int(),
  title: z.string(),
  company: z.string(),
  status: z.string(),
  status_changed_at: iso,
  days_in_status: z.number().int(),
  next_action: z.string().nullable(),
  next_action_at: iso.nullable(),
  interview_rounds: z.number().int(),
  rank_value: z.number().nullable(),
  job_status: z.string(),
  links: z.array(linkDto),
  /** Status changes, newest first (no notes). */
  history: z.array(historyDto),
});
export type ApplicationItemDto = z.infer<typeof applicationItemDto>;

export const listApplicationsOutput = z.strictObject({
  notices,
  total: z.number().int(),
  returned: z.number().int(),
  truncated: z.boolean(),
  applications: z.array(applicationItemDto.extend({ notes: applicationNotesDto.optional() })),
});
export type ListApplicationsOutput = z.infer<typeof listApplicationsOutput>;

export function toApplicationDto(application: Application | null): z.infer<typeof applicationDto> | null {
  if (!application) return null;
  return {
    status: application.status,
    status_changed_at: isoOf(application.statusChangedAt),
    next_action: application.nextAction,
    next_action_at: isoOrNull(application.nextActionAt),
    interview_rounds: application.interviewRounds,
  };
}

const DAY_MS = 86_400_000;

export function toApplicationItemDto(entry: { job: JobCard; application: Application; events: readonly ApplicationEvent[] }, now: Date, clean: CleanText): ApplicationItemDto {
  const { job, application } = entry;
  return applicationItemDto.parse({
    job_id: job.id,
    title: clean(job.title),
    company: clean(job.companyName),
    status: application.status,
    status_changed_at: isoOf(application.statusChangedAt),
    days_in_status: Math.max(0, Math.floor((now.getTime() - application.statusChangedAt.getTime()) / DAY_MS)),
    next_action: application.nextAction === null ? null : clean(application.nextAction),
    next_action_at: isoOrNull(application.nextActionAt),
    interview_rounds: application.interviewRounds,
    rank_value: job.rank?.rankValue ?? null,
    job_status: job.status,
    links: job.sources.map((source) => toLinkDto(source, clean)),
    history: entry.events.map((event) => ({ from: event.fromStatus, to: event.toStatus, at: isoOf(event.at) })),
  } satisfies ApplicationItemDto);
}

export function listApplicationsOutputFor(permissions: ReadonlySet<Permission>): z.ZodType<ListApplicationsOutput> {
  return listApplicationsOutput.extend({ applications: z.array(z.strictObject({ ...applicationItemDto.shape, ...blockShape(applicationNotesBlocks, permissions) })) });
}
