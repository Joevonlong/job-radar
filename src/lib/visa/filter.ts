/** Whether the /jobs "Visa" filter applies (server only). */
import type { Executor } from "@/lib/db/executor";
import { checkTableReady } from "@/lib/db/repos/job-checks";

import { visaVisible } from "./settings";

/**
 * The filter shows (`visaVisible`: the check is on, and `always`, or `auto` for a user who needs sponsorship) and the `job_visa`
 * table exists. Otherwise a `visa=` in the URL or a saved view is ignored but kept.
 */
export async function visaFilterAvailable(db: Executor): Promise<boolean> {
  return visaVisible() && (await checkTableReady(db, "job_visa"));
}
