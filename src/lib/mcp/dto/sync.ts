import { z } from "zod";

import type { Permission } from "@/lib/agent-access/permissions";
import { blockShape } from "@/lib/capabilities/blocks";
import { syncJobBlocks } from "@/lib/mcp/job-blocks";

import { syncCompanyBlockDto, syncSalaryBlockDto } from "./job-analysis";
import { getJobOutput, jobDetailDtoFor } from "./jobs";
import { applicationReadItemDto, applicationReadItemDtoFor, favoriteItemDto, favoriteItemDtoFor } from "./read-tracking";
import { notices } from "./shared";

export const syncPageDto = z.strictObject({
  notices,
  next_cursor: z.string(),
  has_more: z.boolean(),
  held_back: z.int().nonnegative().nullable(),
  phase: z.enum(["snapshot", "changes"]),
  snapshot_complete: z.boolean(),
  generation: z.uuid(),
});

const syncJobAssemblyDto = getJobOutput.extend({ company: syncCompanyBlockDto.optional(), salary: syncSalaryBlockDto.optional() });
export type SyncJobAssembly = z.infer<typeof syncJobAssemblyDto>;
const syncJobDto = syncJobAssemblyDto.omit({ notices: true });

export function syncJobAssemblyDtoFor(permissions: ReadonlySet<Permission>): z.ZodType<SyncJobAssembly> {
  return z.strictObject({ notices, job: jobDetailDtoFor(permissions), ...blockShape(syncJobBlocks, permissions) });
}

const entityChangeFields = { job_id: z.int().positive(), changed_at: z.iso.datetime().nullable() };

function jobChangeItem(job: z.ZodType<z.infer<typeof syncJobDto>>) {
  return z.discriminatedUnion("removed", [
    z.strictObject({ ...entityChangeFields, removed: z.literal(false), job }),
    z.strictObject({ ...entityChangeFields, removed: z.literal(true), job: z.null() }),
  ]);
}

export const listJobChangesOutput = syncPageDto.extend({ items: z.array(jobChangeItem(syncJobDto)) });
export type ListJobChangesOutput = z.infer<typeof listJobChangesOutput>;

export function listJobChangesOutputFor(permissions: ReadonlySet<Permission>): z.ZodType<ListJobChangesOutput> {
  const job = permissions.has("tracking:read") ? syncJobDto.shape.job : jobDetailDtoFor(permissions);
  return syncPageDto.extend({ items: z.array(jobChangeItem(z.strictObject({ job, ...blockShape(syncJobBlocks, permissions) }))) });
}

function trackingChangeItem(application: z.ZodType<z.infer<typeof applicationReadItemDto>>, favorite: z.ZodType<z.infer<typeof favoriteItemDto>>) {
  const appFields = { ...entityChangeFields, kind: z.literal("application") };
  const favFields = { ...entityChangeFields, kind: z.literal("favorite") };
  return z.discriminatedUnion("kind", [
    z.discriminatedUnion("removed", [
      z.strictObject({ ...appFields, removed: z.literal(false), application }),
      z.strictObject({ ...appFields, removed: z.literal(true), application: z.null() }),
    ]),
    z.discriminatedUnion("removed", [
      z.strictObject({ ...favFields, removed: z.literal(false), favorite }),
      z.strictObject({ ...favFields, removed: z.literal(true), favorite: z.null() }),
    ]),
  ]);
}

export const listApplicationChangesOutput = syncPageDto.extend({ items: z.array(trackingChangeItem(applicationReadItemDto, favoriteItemDto)) });
export type ListApplicationChangesOutput = z.infer<typeof listApplicationChangesOutput>;

export function listApplicationChangesOutputFor(permissions: ReadonlySet<Permission>): z.ZodType<ListApplicationChangesOutput> {
  return syncPageDto.extend({ items: z.array(trackingChangeItem(applicationReadItemDtoFor(permissions), favoriteItemDtoFor(permissions))) });
}
