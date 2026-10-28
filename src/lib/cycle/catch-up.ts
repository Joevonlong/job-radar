import type { ScheduleConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { getLatestRunStartedAt } from "@/lib/db/repos/cycles";

import { findMissedCycle, type MissedCycle } from "./schedule";

export interface CatchUpDecision {
  /** The overdue scheduled cycle, or null when nothing is overdue (or catch-up is off). */
  missed: MissedCycle | null;
  /** Start of the newest cycle that actually ran, or null. */
  lastCycleStartedAt: Date | null;
  /** schedule.yaml `catch_up` was false: nothing was evaluated. */
  disabled: boolean;
}

/**
 * Runner start-up decision: did a scheduled cycle fall in the gap while the runner was off? Reads the
 * newest started cycle of every channel from the database (one limited to some channels did not do a slot's work) and
 * compares it with the latest slot of each enabled cycle.
 */
export async function decideCatchUp(db: Db, schedule: ScheduleConfig, now: Date): Promise<CatchUpDecision> {
  if (!schedule.catch_up) return { missed: null, lastCycleStartedAt: null, disabled: true };
  const lastCycleStartedAt = await getLatestRunStartedAt(db);
  return { missed: findMissedCycle(now, schedule, lastCycleStartedAt), lastCycleStartedAt, disabled: false };
}
