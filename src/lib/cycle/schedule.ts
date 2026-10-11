import { Cron } from "croner";

import type { ScheduledCycleKind } from "@/lib/channels/query";
import type { ChannelLogger } from "@/lib/channels/types";
import type { ScheduleConfig } from "@/lib/config";

/** Cycle kinds in schedule.yaml, in the order they are listed there. */
export const SCHEDULED_KINDS = ["weekday_morning", "weekday_evening", "weekend"] as const satisfies readonly ScheduledCycleKind[];

/** croner cuts off milliseconds: look one second past `now` so a slot at exactly `now` counts as due. */
const SLOT_LOOKAHEAD_MS = 1000;

/** The latest slot of `cron` (in `timezone`) at or before `now`, or null if there is none. */
export function latestSlotAtOrBefore(cron: string, timezone: string, now: Date): Date | null {
  const job = new Cron(cron, { timezone, paused: true });
  try {
    const slots = job.previousRuns(2, new Date(now.getTime() + SLOT_LOOKAHEAD_MS));
    return slots.find((slot) => slot.getTime() <= now.getTime()) ?? null;
  } finally {
    job.stop();
  }
}

export interface MissedCycle {
  kind: ScheduledCycleKind;
  /** The slot that was missed. */
  slot: Date;
}

/** Which scheduled cycle is overdue, with its slot: the latest slot (of all enabled cycles) with no cycle started since. */
export function findMissedCycle(now: Date, schedule: ScheduleConfig, lastCycleStartedAt: Date | null): MissedCycle | null {
  let latest: MissedCycle | null = null;
  for (const kind of SCHEDULED_KINDS) {
    const cycle = schedule.cycles[kind];
    if (!cycle.enabled) continue;
    const slot = latestSlotAtOrBefore(cycle.cron, schedule.timezone, now);
    if (slot && (latest === null || slot.getTime() > latest.slot.getTime())) latest = { kind, slot };
  }
  if (latest === null) return null;
  if (lastCycleStartedAt !== null && lastCycleStartedAt.getTime() >= latest.slot.getTime()) return null;
  return latest;
}

/**
 * Catch-up decision (pure): the kind of the most recent scheduled cycle that should have started by
 * `now` but has not — no cycle (of any kind) started at or after its slot — or null when nothing is
 * overdue. `lastCycleStartedAt` is the start of the latest cycle that actually ran.
 */
export function missedCycle(now: Date, schedule: ScheduleConfig, lastCycleStartedAt: Date | null): ScheduledCycleKind | null {
  return findMissedCycle(now, schedule, lastCycleStartedAt)?.kind ?? null;
}

export interface ScheduledJobInfo {
  kind: ScheduledCycleKind;
  cron: string;
  timezone: string;
  nextRun: Date | null;
}

export interface Scheduler {
  /** Replace all jobs with those of `schedule` (hot reload). */
  reschedule(schedule: ScheduleConfig): void;
  describe(): ScheduledJobInfo[];
  stop(): void;
}

export interface SchedulerOptions {
  schedule: ScheduleConfig;
  /** Called at each slot. Errors are logged, never thrown into croner. */
  onTrigger: (kind: ScheduledCycleKind) => void | Promise<void>;
  logger: ChannelLogger;
}

/** One croner job per enabled cycle, interpreted in the schedule's time zone. */
export function createScheduler(options: SchedulerOptions): Scheduler {
  let jobs: Array<{ kind: ScheduledCycleKind; cron: string; timezone: string; job: Cron }> = [];

  const stopAll = (): void => {
    for (const { job } of jobs) job.stop();
    jobs = [];
  };

  const start = (schedule: ScheduleConfig): void => {
    for (const kind of SCHEDULED_KINDS) {
      const cycle = schedule.cycles[kind];
      if (!cycle.enabled) continue;
      const job = new Cron(
        cycle.cron,
        {
          timezone: schedule.timezone,
          // never overlap a still-running trigger of the same job (the advisory lock covers other jobs)
          protect: true,
          catch: (error) => options.logger.error("scheduled cycle failed", { kind, error: error instanceof Error ? error.message : String(error) }),
        },
        async () => {
          options.logger.info("schedule fired", { kind });
          await options.onTrigger(kind);
        },
      );
      jobs.push({ kind, cron: cycle.cron, timezone: schedule.timezone, job });
    }
  };

  start(options.schedule);

  return {
    reschedule(schedule) {
      stopAll();
      start(schedule);
    },
    describe: () => jobs.map(({ kind, cron, timezone, job }) => ({ kind, cron, timezone, nextRun: job.nextRun() })),
    stop: stopAll,
  };
}

/** "2026-10-08 07:00 Europe/Berlin" (wall clock in the schedule's time zone) plus the UTC instant. */
export function formatSlot(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${parts} ${timezone} (${date.toISOString()})`;
}
