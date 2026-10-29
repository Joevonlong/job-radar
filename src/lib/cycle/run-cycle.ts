import { activityErrorCode, noopRecorder, spanScope } from "@/lib/activity";
import type { ActivityRecorder } from "@/lib/activity/types";
import { BudgetTracker, monthKey } from "@/lib/channels/budget";
import type { CascadeSpec } from "@/lib/channels/cascade";
import { CircuitBreaker } from "@/lib/channels/circuit";
import { NO_KNOWN_POSTINGS } from "@/lib/channels/context";
import type { FetchLike, SleepFn } from "@/lib/channels/http";
import type { HostResolver } from "@/lib/net/public-url";
import { createLogger } from "@/lib/channels/logger";
import type { ScheduledCycleKind } from "@/lib/channels/query";
import { defaultRegistry, type ChannelRegistry } from "@/lib/channels/registry";
import { createDbKnownPostings, createDbStateStore, createMemoryStateStore, type ChannelStateStore } from "@/lib/channels/store";
import type { ChannelLogger, KnownPostings } from "@/lib/channels/types";
import { freshenConfig, loadConfig, type ChannelsConfig, type ScheduleConfig, type SearchConfig } from "@/lib/config";
import { cycleCovers } from "@/lib/control/cycle-coverage";
import { getDb, type Db } from "@/lib/db/client";
import { createCycle, createSkippedCycle, failOrphanedCycles, finishCycle, listRunningCycles, type CycleKind } from "@/lib/db/repos/cycles";

import { findCycleLockHolder, withCycleLock, type CycleLockHolder } from "./lock";
import { startWaitingForLock } from "./lock-waiters";
import { stepActivityOutcome } from "./step-activity";
import { listCycleSteps, type CycleStepName, type CycleStepContext } from "./steps";

export interface RunCycleOptions {
  activity?: ActivityRecorder;
  activityRequestId?: number;
  /** Hands request logging over to the cycle root, even if later setup or finish writes throw. */
  onCycleRootCreated?: () => void;
  /** Only run these channels (the CLI's `--channel`). Disabled or unknown ids simply do nothing. */
  channelIds?: readonly string[];
  /** Collect and report in memory: no cycle, run, raw posting, usage or circuit writes; no lock; later steps skipped. */
  dryRun?: boolean;
  /** For a `catchup`: the scheduled kind it replaces, which decides the look-back window. */
  windowKind?: ScheduledCycleKind;
  /** Manual backfill look-back in hours; each query's window is at least this. */
  backfillHours?: number;
  /** Cancels the cycle (runner shutdown): pending steps are skipped, in-flight requests aborted. */
  signal?: AbortSignal;
  /**
   * Defaults to the shared pool. A dry run never writes through it: when given (the CLI passes a read-only one),
   * the dry run starts from the persisted month usage, circuit state and stored postings; without one it starts from empty state.
   */
  db?: Db | null;
  registry?: ChannelRegistry;
  /** Cascade families; defaults to `linkedin.cascade` from sources.yaml. */
  cascades?: readonly CascadeSpec[];
  /** Config overrides (defaults to the loaded, hot-reloaded files). */
  config?: Partial<{ channels: ChannelsConfig; search: SearchConfig; schedule: ScheduleConfig }>;
  logger?: ChannelLogger;
  now?: () => Date;
  fetch?: FetchLike;
  sleep?: SleepFn;
  random?: () => number;
  /** Host name resolver for the link check (tests inject one; default: the system resolver). */
  resolveHost?: HostResolver;
  /** The clock and the sleep of the wait for the lock (`partial_cycle_wait`); tests inject them. Default: the real ones. */
  lockWait?: LockWaitClock;
}

/** What waiting for the cycle lock runs on. `sleep` resolves false when `signal` aborts first. */
export interface LockWaitClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean>;
}

export interface StepSummary {
  name: CycleStepName;
  status: "ok" | "partial" | "failed" | "skipped";
  durationMs: number;
  result?: unknown;
  error?: string;
  reason?: string;
}

/** Shape of `cycles.summary_json`. */
export interface CycleSummary {
  version: 1;
  kind: CycleKind;
  windowKind: ScheduledCycleKind | null;
  /** Manual backfill look-back in hours, when requested. */
  backfillHours?: number;
  /** The channels the cycle was limited to (`RunCycleOptions.channelIds`); null = every enabled channel. */
  channelIds: string[] | null;
  dryRun: boolean;
  startedAt: string;
  durationMs: number;
  aborted: boolean;
  steps: StepSummary[];
  reason?: string;
  /** A skipped cycle: the running cycle that already covers its channels (null or absent: none known to). */
  coveredBy?: number | null;
}

export type CycleStatus = "succeeded" | "partial" | "failed" | "skipped";

export interface CycleRunResult {
  /** null for dry runs. For a skipped cycle: the id of the `skipped` row. */
  cycleId: number | null;
  kind: CycleKind;
  status: CycleStatus;
  summary: CycleSummary;
  /** Raw result of each step that ran (for dry runs: the collect report). */
  results: Partial<Record<CycleStepName, unknown>>;
}

/** Cascade families from sources.yaml. */
export function cascadesFromConfig(config: ChannelsConfig): CascadeSpec[] {
  return [{ family: "linkedin", order: config.linkedin.cascade }];
}

function errorText(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : "unknown error").slice(0, 500);
}

/**
 * One processing cycle: steps `collect → pipeline → signals → ai → notify →
 * maintenance`, each timed and summarised in `cycles.summary_json`. A failing step does not stop the
 * later ones (they work from what is in the database). Only one cycle runs at a time across
 * processes (Postgres advisory lock); a second caller records a `skipped` cycle and returns —
 * or waits, when `schedule.skip_if_running` is false. With `skip_if_running`, a cycle other than a `manual` one that
 * finds the lock held by a cycle limited to channels it needs as well (a "collect now" of one channel) waits for it
 * instead, at most `schedule.partial_cycle_wait.max_minutes`, then runs; a skipped cycle names the running cycle that
 * covers it in `summary.coveredBy`. The running cycle is the one that holds the lock (its row records the lock
 * session's backend pid), not just any row left `running`.
 */
export async function runCycle(kind: CycleKind, options: RunCycleOptions = {}): Promise<CycleRunResult> {
  const dryRun = options.dryRun ?? false;
  const recorder = dryRun ? noopRecorder : options.activity ?? noopRecorder;
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? createLogger({ fields: {} });
  const db: Db | null = options.db !== undefined ? options.db : dryRun ? null : getDb();
  if (db === null && !dryRun) throw new Error("runCycle: a database is required unless dryRun is set");

  // A change another process made (the web saving the market) counts from this cycle on, not from the next restart.
  // freshenConfig never throws (a bad file keeps its last good value), so the cycle always goes on.
  freshenConfig(logger);
  // Only channels / search / schedule are snapshotted for the whole cycle; the steps read the other configs when they
  // need them, so a change made mid-cycle can reach a later step of this cycle (accepted: the next cycle is consistent).
  const config: { channels: ChannelsConfig; search: SearchConfig; schedule: ScheduleConfig } = {
    channels: options.config?.channels ?? loadConfig("channels"),
    search: options.config?.search ?? loadConfig("search"),
    schedule: options.config?.schedule ?? loadConfig("schedule"),
  };
  const channelIds = options.channelIds ? [...options.channelIds] : null;
  const baseSummary = {
    version: 1 as const,
    kind,
    windowKind: options.windowKind ?? null,
    ...(options.backfillHours !== undefined ? { backfillHours: options.backfillHours } : {}),
    channelIds,
    dryRun,
    startedAt: now().toISOString(),
  };

  const execute = async (writeDb: Db | null, readDb: Db | null, holder?: CycleLockHolder): Promise<CycleRunResult> => {
    const signal = holder?.signal ?? options.signal ?? new AbortController().signal;
    // Owning the lock proves that the previous body ended. Recover a crashed CLI or a failed finish write before
    // creating this cycle, so channel tests, deployment drain and delegated work do not wait for a runner restart.
    if (writeDb && !dryRun) {
      signal.throwIfAborted();
      await failOrphanedCycles(writeDb, "previous cycle ended without finishing its row");
    }
    const lockPid = holder?.pid;
    const startedMs = now().getTime();
    // a cycle that waited for the lock starts now, not when it was asked for
    const runSummary = { ...baseSummary, startedAt: new Date(startedMs).toISOString() };
    const registry = options.registry ?? defaultRegistry;
    const store: ChannelStateStore = dryRun ? createMemoryStateStore(readDb ? createDbStateStore(readDb) : null) : createDbStateStore(writeDb as Db);
    const known = (channelId: string): KnownPostings => (readDb ? createDbKnownPostings(readDb, channelId) : NO_KNOWN_POSTINGS);
    // recorded at once: a cycle that finds the lock taken reads which channels this one covers, and whether it is the holder
    const cycleRow = !dryRun && writeDb ? await createCycle(writeDb, { kind, summary: { ...runSummary, ...(lockPid ? { lockPid } : {}) } }) : null;
    const root = cycleRow ? recorder.cycleRoot(cycleRow.id, { requestId: options.activityRequestId }) : noopRecorder.cycleRoot(0);
    if (options.backfillHours !== undefined) root.note("info", "backfill", { hours: options.backfillHours });
    const rootScope = spanScope(root, "interrupted", "not_recorded");
    try {
      if (cycleRow) options.onCycleRootCreated?.();
      const steps: StepSummary[] = [];
      const results: Partial<Record<CycleStepName, unknown>> = {};
      let finalStatus: Exclude<CycleStatus, "skipped"> = "failed";
      let setupError: string | undefined;
      let setupErrorCode: string | undefined;

      try {
        if (!dryRun) {
          await store.upsertChannels(
            registry.list().map((c) => ({
              id: c.id,
              family: c.family,
              kind: c.kind,
              enabled: registry.isEnabled(c.id, config.channels),
            })),
          );
        }
        const breaker = new CircuitBreaker(
          store,
          () => ({
            failures: config.channels.circuit_breaker.failures,
            cooldownMs: config.channels.circuit_breaker.cooldown_hours * 3_600_000,
          }),
          now,
        );
        const budget = await BudgetTracker.create({
          store,
          month: monthKey(now(), config.schedule.timezone),
          globalCapUsd: config.channels.paid_total_monthly_budget_usd,
          settingsFor: (id) => registry.settingsFor(id, config.channels),
        });
        const stepContext: CycleStepContext = {
          cycle: { id: cycleRow?.id ?? null, kind },
          windowKind: options.windowKind ?? null,
          ...(options.backfillHours !== undefined ? { backfillHours: options.backfillHours } : {}),
          dryRun,
          db: writeDb,
          signal,
          logger: logger.child({ cycle: cycleRow?.id ?? "dry-run", kind }),
          now,
          config,
          channels: {
            registry,
            cascades: options.cascades ?? cascadesFromConfig(config.channels),
            store,
            known,
            breaker,
            budget,
            selected: options.channelIds ?? null,
            runtime: {
              ...(options.fetch ? { fetch: options.fetch } : {}),
              ...(options.sleep ? { sleep: options.sleep } : {}),
              ...(options.random ? { random: options.random } : {}),
              ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}),
            },
          },
          results,
        };

        for (const [name, fn] of listCycleSteps()) {
          const stepStart = now().getTime();
          const elapsed = (): number => now().getTime() - stepStart;
          const step = root.child(`step.${name}`);
          const scope = spanScope(step);
          try {
            if (signal.aborted) {
              scope.set("skipped", "cycle_cancelled");
              steps.push({ name, status: "skipped", durationMs: 0, reason: "cycle cancelled" });
              continue;
            }
            if (dryRun && name !== "collect") {
              steps.push({ name, status: "skipped", durationMs: 0, reason: "dry run" });
              continue;
            }
            try {
              const outcome = await fn({ ...stepContext, activity: step });
              scope.set(...stepActivityOutcome(outcome));
              if (outcome?.result !== undefined) results[name] = outcome.result;
              steps.push({
                name,
                status: outcome?.status ?? "ok",
                durationMs: elapsed(),
                ...(outcome?.result === undefined ? {} : { result: outcome.result }),
              });
            } catch (error) {
              scope.error(error);
              logger.error("cycle step failed", { step: name, error: errorText(error) });
              steps.push({ name, status: "failed", durationMs: elapsed(), error: errorText(error) });
            }
          } finally { scope.close(); }
        }

        const collect = steps.find((s) => s.name === "collect");
        if (signal.aborted) finalStatus = "failed";
        else if (collect?.status === "failed") finalStatus = "failed";
        else if (steps.some((s) => s.status === "failed" || s.status === "partial")) finalStatus = "partial";
        else finalStatus = "succeeded";
      } catch (error) {
        setupError = errorText(error);
        setupErrorCode = activityErrorCode(error);
        logger.error("cycle aborted by an internal error", { error: setupError });
        finalStatus = "failed";
      }

      const summary: CycleSummary = {
        ...runSummary,
        durationMs: now().getTime() - startedMs,
        aborted: signal.aborted,
        steps,
        ...(setupError === undefined ? {} : { reason: setupError }),
      };
      if (cycleRow && writeDb) {
        await finishCycle(writeDb, cycleRow.id, { status: finalStatus, summary });
      }
      rootScope.set(signal.aborted ? "interrupted" : finalStatus === "succeeded" ? "ok" : finalStatus, signal.aborted ? "cycle_cancelled" : setupErrorCode);
      if (setupError !== undefined) throw new Error(`cycle failed: ${setupError}`);
      return { cycleId: cycleRow?.id ?? null, kind, status: finalStatus, summary, results };
    } finally { rootScope.close(); }
  };

  // a dry run reads persisted state through `db` but gets no writable handle and takes no lock
  if (dryRun) return execute(null, db);
  if (db === null) throw new Error("runCycle: a database is required unless dryRun is set"); // unreachable (checked above); narrows the type

  if (!config.schedule.skip_if_running) {
    const locked = await withCycleLock(db, "wait", (holder) => execute(db, db, holder), { signal: options.signal });
    if (locked.acquired) return locked.value;
  }

  const skip = async (reason: string, coveredBy: number | null, reasonCode: "another_cycle_running" | "cycle_cancelled" | "covered_by_running_cycle"): Promise<CycleRunResult> => {
    logger.warn("cycle skipped: another cycle is running", { kind, coveredBy: coveredBy ?? "none" });
    const summary: CycleSummary = { ...baseSummary, durationMs: 0, aborted: false, steps: [], reason, coveredBy };
    const row = await createSkippedCycle(db, { kind, summary });
    const root = recorder.cycleRoot(row.id, { requestId: options.activityRequestId });
    if (options.backfillHours !== undefined) root.note("info", "backfill", { hours: options.backfillHours });
    try {
      options.onCycleRootCreated?.();
      if (coveredBy !== null) root.note("info", "covered_by", { cycle_id: coveredBy });
      return { cycleId: row.id, kind, status: "skipped", summary, results: {} };
    } finally { root.finish("skipped", { reasonCode }); }
  };
  // A manual cycle never waits: the control poller is serial, so it would hold up every other request (its handler reports a covering cycle instead).
  const wait = kind === "manual" ? null : config.schedule.partial_cycle_wait;
  const clock = options.lockWait ?? { now: () => Date.now(), sleep: sleepUnlessAborted };
  const signal = options.signal;
  const cascades = options.cascades ?? cascadesFromConfig(config.channels);
  let deadline: number | null = null;
  let stopWaiting: (() => void) | null = null;
  let lockJustFreed = 0;
  try {
    for (;;) {
      if (deadline !== null && signal?.aborted) return await skip("cancelled while waiting for another cycle", null, "cycle_cancelled");
      const locked = await withCycleLock(db, "try", async (holder) => {
        stopWaiting?.();
        if (deadline !== null && options.config === undefined) {
          // it may have waited long: the files as they are now, as for any cycle that starts
          freshenConfig(logger);
          config.channels = loadConfig("channels");
          config.search = loadConfig("search");
          config.schedule = loadConfig("schedule");
        }
        return execute(db, db, holder);
      }, { signal: options.signal });
      if (locked.acquired) return locked.value;
      // Only the cycle whose dedicated session holds the lock counts: a row a crash left `running` covers nothing.
      const holderPid = await findCycleLockHolder(db);
      if (holderPid === null && lockJustFreed < 3) {
        lockJustFreed += 1; // released between the try and the look: try again at once
        continue;
      }
      const holder = holderPid === null ? undefined : (await listRunningCycles(db)).find((cycle) => cycle.lockPid === holderPid);
      // A running cycle that does everything this one would (every channel, or a superset of its channels) makes it redundant.
      if (holder !== undefined && cycleCovers(holder.channelIds, channelIds, cascades)) return await skip("another cycle is running (lock held)", holder.id, "covered_by_running_cycle");
      if (wait === null || wait.max_minutes === 0) return await skip("another cycle is running (lock held)", null, "another_cycle_running");
      // The holder is limited to other channels (or has not recorded its row yet): wait for it, re-checking every poll.
      if (deadline === null) {
        deadline = clock.now() + wait.max_minutes * 60_000;
        stopWaiting = startWaitingForLock();
        logger.info("cycle waits: a cycle limited to some channels is running", { kind, holder: holder?.id ?? "unknown" });
      }
      const left = deadline - clock.now();
      if (left <= 0) return await skip(`another cycle limited to some channels was still running after ${wait.max_minutes} min`, null, "another_cycle_running");
      if (!(await clock.sleep(Math.min(wait.poll_seconds * 1000, left), signal))) return await skip("cancelled while waiting for another cycle", null, "cycle_cancelled");
    }
  } finally {
    stopWaiting?.();
  }
}

/** Wait `ms`; false when `signal` aborts first (the runner is shutting down). */
function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
