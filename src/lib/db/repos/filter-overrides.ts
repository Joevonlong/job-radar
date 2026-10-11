import { eq, inArray } from "drizzle-orm";

import type { Executor } from "../executor";
import { filterOverrideEnum, jobFilterOverrides } from "../schema";

export type FilterOverrideAction = (typeof filterOverrideEnum.enumValues)[number];

/** The user's filter decisions for these jobs (jobs without one are absent from the map). */
export async function getFilterOverrides(db: Executor, jobIds: readonly number[]): Promise<Map<number, FilterOverrideAction>> {
  if (jobIds.length === 0) return new Map();
  const rows = await db
    .select({ jobId: jobFilterOverrides.jobId, action: jobFilterOverrides.action })
    .from(jobFilterOverrides)
    .where(inArray(jobFilterOverrides.jobId, [...jobIds]));
  return new Map(rows.map((r) => [r.jobId, r.action]));
}

export async function getFilterOverride(db: Executor, jobId: number): Promise<FilterOverrideAction | null> {
  const [row] = await db.select({ action: jobFilterOverrides.action }).from(jobFilterOverrides).where(eq(jobFilterOverrides.jobId, jobId)).limit(1);
  return row?.action ?? null;
}

/** Store (or replace) the decision for a job. */
export async function setFilterOverride(db: Executor, jobId: number, action: FilterOverrideAction): Promise<void> {
  await db
    .insert(jobFilterOverrides)
    .values({ jobId, action })
    .onConflictDoUpdate({ target: jobFilterOverrides.jobId, set: { action } });
}

/** Take the decision back: the rules decide again. */
export async function clearFilterOverride(db: Executor, jobId: number): Promise<void> {
  await db.delete(jobFilterOverrides).where(eq(jobFilterOverrides.jobId, jobId));
}
