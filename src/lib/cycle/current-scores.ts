import type { SpanHandle } from "@/lib/activity/types";
import type { Db } from "@/lib/db/client";
import { checkCurrentScores, currentScoresTableExists, repairCurrentScores, recordCurrentScoresCheck } from "@/lib/db/repos/current-scores";

/** Maintenance convergence for direct SQL, old binaries, imports and cascaded deletes. */
export async function maintainCurrentScores(db: Db, activity?: SpanHandle) {
  if (!(await currentScoresTableExists(db))) return { skipped: true, differences: 0, remaining: 0 };
  const ids = await checkCurrentScores(db);
  if (ids.length > 0) await repairCurrentScores(db, ids);
  const remaining = ids.length > 0 ? (await checkCurrentScores(db)).length : 0;
  const result = { differences: ids.length, remaining };
  await recordCurrentScoresCheck(db, result);
  if (ids.length > 0) activity?.note(remaining ? "error" : "warn", "current_scores_repaired", result);
  return result;
}
