import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Specs that write `scores` (or delete scored jobs) with plain SQL bypass `scoreTransaction`, so the lists, Today and
 * the board, which read `job_current_scores`, would not see the change. Call this right after such a write (and after
 * putting the rows back): scripts/e2e-refresh-current-scores.ts runs the product's refresh for exactly these jobs.
 */
export async function refreshCurrentScores(jobIds: readonly number[]): Promise<void> {
  const url = process.env.E2E_DATABASE_URL;
  if (!url || !new URL(url).pathname.slice(1).startsWith("jobradar_e2e")) throw new Error("A disposable E2E_DATABASE_URL is required");
  if (jobIds.length === 0) return;
  await run("pnpm", ["exec", "tsx", "scripts/e2e-refresh-current-scores.ts", ...jobIds.map(String)], {
    env: {
      ...process.env,
      DATABASE_URL: url,
      JOB_RADAR_CONFIG_DIR: process.env.E2E_CONFIG_DIR ?? "",
      JOB_RADAR_DEFAULTS_DIR: process.env.E2E_DEFAULTS_DIR ?? "",
      JOB_RADAR_PROFILE_DIR: process.env.E2E_PROFILE_DIR ?? "",
    },
  });
}
