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
import { getDb, type Db } from "@/lib/db/client";
import { createCycle, createSkippedCycle, finishCycle, type CycleKind } from "@/lib/db/repos/cycles";

import { withCycleLock } from "./lock";
import { listCycleSteps, type CycleStepName, type CycleStepContext } from "./steps";

export interface RunCycleOptions {
  /** Only run these channels (the CLI's `--channel`). Disabled or unknown ids simply do nothing. */
  channelIds?: readonly string[];
  /** Collect and report in memory: no cycle, run, raw posting, usage or circuit writes; no lock; later steps skipped. */
  dryRun?: boolean;
  /** For a `catchup`: the scheduled kind it replaces, which decides the look-back window. */
  windowKind?: ScheduledCycleKind;
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
  dryRun: boolean;
  startedAt: string;
  durationMs: number;
  aborted: boolean;
  steps: StepSummary[];
  reason?: string;
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
 * or waits, when `schedule.skip_if_running` is false.
 */
export async function runCycle(kind: CycleKind, options: RunCycleOptions = {}): Promise<CycleRunResult> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? createLogger({ fields: {} });
  const db: Db | null = options.db !== undefined ? options.db : dryRun ? null : getDb();
  if (db === null && !dryRun) throw new Error("runCycle: a database is required unless dryRun is set");

  // A change another process made (the web saving the market) counts from this cycle on, not from the next restart.
  // freshenConfig never throws (a bad file keeps its last good value), so the cycle always goes on.
  freshenConfig(logger);
  // Only channels / search / schedule are snapshotted for the whole cycle; the steps read the other configs when they
  // need them, so a change made mid-cycle can reach a later step of this cycle (accepted: the next cycle is consistent).
  const config = {
    channels: options.config?.channels ?? loadConfig("channels"),
    search: options.config?.search ?? loadConfig("search"),
    schedule: options.config?.schedule ?? loadConfig("schedule"),
  };
  const baseSummary = {
    version: 1 as const,
    kind,
    windowKind: options.windowKind ?? null,
    dryRun,
    startedAt: now().toISOString(),
  };

  const execute = async (writeDb: Db | null, readDb: Db | null): Promise<CycleRunResult> => {
    const startedMs = now().getTime();
    const registry = options.registry ?? defaultRegistry;
    const store: ChannelStateStore = dryRun ? createMemoryStateStore(readDb ? createDbStateStore(readDb) : null) : createDbStateStore(writeDb as Db);
    const known = (channelId: string): KnownPostings => (readDb ? createDbKnownPostings(readDb, channelId) : NO_KNOWN_POSTINGS);
    const cycleRow = !dryRun && writeDb ? await createCycle(writeDb, { kind }) : null;
    const signal = options.signal ?? new AbortController().signal;
    const steps: StepSummary[] = [];
    const results: Partial<Record<CycleStepName, unknown>> = {};
    let finalStatus: Exclude<CycleStatus, "skipped"> = "failed";
    let setupError: string | undefined;

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
        if (signal.aborted) {
          steps.push({ name, status: "skipped", durationMs: 0, reason: "cycle cancelled" });
          continue;
        }
        if (dryRun && name !== "collect") {
          steps.push({ name, status: "skipped", durationMs: 0, reason: "dry run" });
          continue;
        }
        try {
          const outcome = await fn(stepContext);
          if (outcome?.result !== undefined) results[name] = outcome.result;
          steps.push({
            name,
            status: outcome?.status ?? "ok",
            durationMs: elapsed(),
            ...(outcome?.result === undefined ? {} : { result: outcome.result }),
          });
        } catch (error) {
          logger.error("cycle step failed", { step: name, error: errorText(error) });
          steps.push({ name, status: "failed", durationMs: elapsed(), error: errorText(error) });
        }
      }

      const collect = steps.find((s) => s.name === "collect");
      if (signal.aborted) finalStatus = "failed";
      else if (collect?.status === "failed") finalStatus = "failed";
      else if (steps.some((s) => s.status === "failed" || s.status === "partial")) finalStatus = "partial";
      else finalStatus = "succeeded";
    } catch (error) {
      setupError = errorText(error);
      logger.error("cycle aborted by an internal error", { error: setupError });
      finalStatus = "failed";
    }

    const summary: CycleSummary = {
      ...baseSummary,
      durationMs: now().getTime() - startedMs,
      aborted: signal.aborted,
      steps,
      ...(setupError === undefined ? {} : { reason: setupError }),
    };
    if (cycleRow && writeDb) {
      await finishCycle(writeDb, cycleRow.id, { status: finalStatus, summary });
    }
    if (setupError !== undefined) throw new Error(`cycle failed: ${setupError}`);
    return { cycleId: cycleRow?.id ?? null, kind, status: finalStatus, summary, results };
  };

  // a dry run reads persisted state through `db` but gets no writable handle and takes no lock
  if (dryRun) return execute(null, db);
  if (db === null) throw new Error("runCycle: a database is required unless dryRun is set"); // unreachable (checked above); narrows the type

  const locked = await withCycleLock(db, config.schedule.skip_if_running ? "try" : "wait", () => execute(db, db));
  if (locked.acquired) return locked.value;

  logger.warn("cycle skipped: another cycle is running", { kind });
  const summary: CycleSummary = { ...baseSummary, durationMs: 0, aborted: false, steps: [], reason: "another cycle is running (lock held)" };
  const row = await createSkippedCycle(db, { kind, summary });
  return { cycleId: row.id, kind, status: "skipped", summary, results: {} };
}
