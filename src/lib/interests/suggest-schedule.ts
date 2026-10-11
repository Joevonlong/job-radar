import { Cron } from "croner";

import type { ChannelLogger } from "@/lib/channels/types";
import type { SuggestConfig } from "@/lib/config";
import { latestSlotAtOrBefore } from "@/lib/cycle/schedule";
import type { Db } from "@/lib/db/client";
import { findLatestControlRequest, findOpenControlRequest, insertControlRequest } from "@/lib/db/repos/control-requests";

/**
 * Leave a `run_suggest` request for whoever runs AI (the runner today, the host AI worker later). One that is
 * still pending or running is reused, so a slow run never piles up requests. Returns the request id.
 */
export async function enqueueSuggestRequest(db: Db): Promise<{ id: number; existing: boolean }> {
  const open = await findOpenControlRequest(db, "run_suggest");
  if (open) return { id: open.id, existing: true };
  const row = await insertControlRequest(db, { kind: "run_suggest", payload: {} });
  return { id: row.id, existing: false };
}

/** True when the latest slot of `cron` has passed and no `run_suggest` was requested since (the runner was down at the slot). */
export function isSuggestOverdue(input: { now: Date; cron: string; timeZone: string; lastRequestedAt: Date | null }): boolean {
  const slot = latestSlotAtOrBefore(input.cron, input.timeZone, input.now);
  if (slot === null) return false;
  return input.lastRequestedAt === null || input.lastRequestedAt.getTime() < slot.getTime();
}

/** Checks the catch-up rule against the database: was the weekly run missed? */
export async function isWeeklySuggestOverdue(db: Db, config: SuggestConfig, timeZone: string, now: Date): Promise<boolean> {
  if (!config.enabled) return false;
  const last = await findLatestControlRequest(db, "run_suggest");
  return isSuggestOverdue({ now, cron: config.cron, timeZone, lastRequestedAt: last?.requestedAt ?? null });
}

export interface SuggestScheduler {
  /** Replace the job with one built from the new config (hot reload). */
  reschedule(config: SuggestConfig, timeZone: string): void;
  nextRun(): Date | null;
  stop(): void;
}

export interface SuggestSchedulerOptions {
  config: SuggestConfig;
  timeZone: string;
  logger: ChannelLogger;
  /** Called at each slot (the runner enqueues a request). Errors are logged, never thrown into croner. */
  onTrigger: () => void | Promise<void>;
}

/** One croner job on `suggest.cron` (in the schedule's time zone), none while `suggest.enabled` is off. */
export function createSuggestScheduler(options: SuggestSchedulerOptions): SuggestScheduler {
  let job: Cron | null = null;
  const start = (config: SuggestConfig, timeZone: string): void => {
    if (!config.enabled) return;
    job = new Cron(
      config.cron,
      {
        timezone: timeZone,
        protect: true,
        catch: (error) => options.logger.error("scheduled suggestion request failed", { error: error instanceof Error ? error.message : String(error) }),
      },
      async () => {
        options.logger.info("schedule fired", { kind: "suggest" });
        await options.onTrigger();
      },
    );
  };
  start(options.config, options.timeZone);
  return {
    reschedule(config, timeZone) {
      job?.stop();
      job = null;
      start(config, timeZone);
    },
    nextRun: () => job?.nextRun() ?? null,
    stop() {
      job?.stop();
      job = null;
    },
  };
}
