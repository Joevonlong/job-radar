import { sql, type SQL } from "drizzle-orm";

import { scores } from "../schema";
import type { ScoreTx } from "./current-scores";

/**
 * One global row-lock order for every write that changes more than one `scores` row in a transaction: ascending
 * `scores.id`. A score transaction can hold many row locks until its commit (a filter batch, a bonus reconcile, a
 * profile or prompt stale-mark); two of them taking the same rows in different orders (job id order against the
 * physical scan order) form a lock cycle. Single-row writes need nothing: holding one row cannot close a cycle.
 */

/**
 * `scores.id in (select id from scores where <where> order by id for update)`: the rows matching `where`, locked in
 * ascending id order before the outer UPDATE touches them. Columns in `where` resolve to the inner `scores`.
 */
export function inScoreLockOrder(where: SQL | undefined): SQL {
  return sql`${scores.id} in (select ${scores.id} from ${scores} where ${where ?? sql`true`} order by ${scores.id} for update)`;
}

/** Lock every `scores` row of the given jobs in ascending id order (before a delete that cascades to them). */
export async function lockScoreRowsOfJobs(tx: ScoreTx, jobIds: readonly number[]): Promise<void> {
  if (jobIds.length === 0) return;
  await tx.execute(sql`select ${scores.id} from ${scores} where ${scores.jobId} = any(${`{${jobIds.join(",")}}`}::bigint[]) order by ${scores.id} for update`);
}

/** The items sorted by their score id: apply row-by-row updates in lock order. */
export function inScoreIdOrder<T>(items: readonly T[], scoreId: (item: T) => number): T[] {
  return [...items].sort((a, b) => scoreId(a) - scoreId(b));
}
