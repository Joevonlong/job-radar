/** Whether the /jobs "Ghost jobs" filter applies (server only). */
import type { Executor } from "@/lib/db/executor";
import { checkTableReady } from "@/lib/db/repos/job-checks";

import { ghostEnabled } from "./settings";

/**
 * The check is on (ui.yaml `job_checks.ghost.enabled`) and the `job_ghost` table exists. Otherwise a `ghost=` in the URL or a saved
 * view is ignored but kept.
 */
export async function ghostFilterAvailable(db: Executor): Promise<boolean> {
  return ghostEnabled() && (await checkTableReady(db, "job_ghost"));
}
