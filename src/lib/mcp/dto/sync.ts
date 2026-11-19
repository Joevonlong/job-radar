import { z } from "zod";

import type { Permission } from "@/lib/agent-access/permissions";
import { blockShape } from "@/lib/capabilities/blocks";
import { syncJobBlocks } from "@/lib/mcp/job-blocks";

import { syncCompanyBlockDto, syncSalaryBlockDto } from "./job-analysis";
import { getJobOutput, jobDetailDtoFor } from "./jobs";
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

function jobChangeItem(job: z.ZodType<z.infer<typeof syncJobDto>>) {
  const common = { job_id: z.int().positive(), changed_at: z.iso.datetime().nullable() };
  return z.discriminatedUnion("removed", [
    z.strictObject({ ...common, removed: z.literal(false), job }),
    z.strictObject({ ...common, removed: z.literal(true), job: z.null() }),
  ]);
}

export const listJobChangesOutput = syncPageDto.extend({ items: z.array(jobChangeItem(syncJobDto)) });
export type ListJobChangesOutput = z.infer<typeof listJobChangesOutput>;

export function listJobChangesOutputFor(permissions: ReadonlySet<Permission>): z.ZodType<ListJobChangesOutput> {
  const job = permissions.has("tracking:read") ? syncJobDto.shape.job : jobDetailDtoFor(permissions);
  return syncPageDto.extend({ items: z.array(jobChangeItem(z.strictObject({ job, ...blockShape(syncJobBlocks, permissions) }))) });
}
