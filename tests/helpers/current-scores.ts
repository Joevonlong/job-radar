import type { Executor } from "@/lib/db/executor";
import { invalidateCurrentScores, rebuildCurrentScores } from "@/lib/db/repos/current-scores";
/** Fixtures deliberately write raw score rows; rebuild before exercising production read queries. */
export async function withRebuiltCurrentScores<T>(db: Executor, write: PromiseLike<T>): Promise<T> {
  const result = await write;
  invalidateCurrentScores(db);
  await rebuildCurrentScores(db, { batchJobs: 1000 });
  return result;
}
