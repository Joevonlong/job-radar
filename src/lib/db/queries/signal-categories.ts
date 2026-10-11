import { countDistinct, count, sql } from "drizzle-orm";

import type { Db } from "../client";
import { signals } from "../schema";

/** Stored signals and the jobs that have them, per category id (what deleting a category hides). */
export interface CategorySignalCount {
  signals: number;
  jobs: number;
}

/** `signals` grouped by category id (`tier`), every id that has rows, active or not. */
export async function countSignalsByCategory(db: Db): Promise<Map<string, CategorySignalCount>> {
  const rows = await db
    .select({ id: signals.tier, signals: count(), jobs: countDistinct(signals.jobId) })
    .from(signals)
    .groupBy(signals.tier)
    .orderBy(sql`1`);
  return new Map(rows.map((row) => [row.id, { signals: Number(row.signals), jobs: Number(row.jobs) }]));
}
