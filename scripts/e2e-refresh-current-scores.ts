/**
 * Refresh the display projection (job_current_scores) of the given jobs in the disposable e2e database, with the same
 * library code as the product's score writers. Started by e2e/current-scores.ts after a spec wrote `scores` with plain
 * SQL; a separate tsx process because the Playwright loader cannot load the config and message modules it needs.
 *
 *   DATABASE_URL=<e2e database> tsx scripts/e2e-refresh-current-scores.ts <job id>...
 */
import { createConnection } from "../src/lib/db/client";
import { repairCurrentScores } from "../src/lib/db/repos/current-scores";

const url = process.env.DATABASE_URL ?? "";
if (!url || !new URL(url).pathname.slice(1).startsWith("jobradar_e2e")) throw new Error("e2e-refresh-current-scores requires a disposable e2e DATABASE_URL");
const jobIds = process.argv.slice(2).map((arg) => {
  const id = Number(arg);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`not a job id: ${arg}`);
  return id;
});
const { sql, db } = createConnection(url, { max: 1 });
try {
  await repairCurrentScores(db, jobIds);
} finally {
  await sql.end({ timeout: 5 });
}
