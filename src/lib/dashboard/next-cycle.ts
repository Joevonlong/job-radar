import { Cron } from "croner";

import type { ScheduledCycleKind } from "@/lib/channels/query";
import type { ScheduleConfig } from "@/lib/config";
import { SCHEDULED_KINDS } from "@/lib/cycle/schedule";

export interface NextCycle {
  kind: ScheduledCycleKind;
  at: Date;
}

/** The soonest upcoming slot of the enabled cycles in schedule.yaml, or null when none is enabled. */
export function nextScheduledCycle(schedule: ScheduleConfig, now: Date): NextCycle | null {
  let best: NextCycle | null = null;
  for (const kind of SCHEDULED_KINDS) {
    const cycle = schedule.cycles[kind];
    if (!cycle.enabled) continue;
    const job = new Cron(cycle.cron, { timezone: schedule.timezone, paused: true });
    try {
      const at = job.nextRun(now);
      if (at && (best === null || at.getTime() < best.at.getTime())) best = { kind, at };
    } finally {
      job.stop();
    }
  }
  return best;
}
