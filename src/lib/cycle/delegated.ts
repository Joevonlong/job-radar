import { BudgetTracker, monthKey } from "@/lib/channels/budget";
import { CircuitBreaker } from "@/lib/channels/circuit";
import { defaultRegistry, type ChannelRegistry } from "@/lib/channels/registry";
import { createDbStateStore } from "@/lib/channels/store";
import type { ChannelLogger } from "@/lib/channels/types";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { applyDelegatedSteps, getCycle, type Cycle, type DelegatedStepSummary } from "@/lib/db/repos/cycles";
import { aiLateStep, aiMainStep } from "@/lib/ai/step";
import { notifyStep } from "@/lib/notify/step";

import { cascadesFromConfig } from "./run-cycle";
import type { CycleStepContext, CycleStepFn, CycleStepName } from "./steps";

/** Steps of a cycle whose work moves to the ai-worker with `ai.yaml: execution: host`, in running order. */
export const DELEGATED_STEP_NAMES = ["ai", "notify"] as const satisfies readonly CycleStepName[];

export interface DelegatedRunOptions {
  db: Db;
  cycleId: number;
  signal: AbortSignal;
  logger: ChannelLogger;
  now?: () => Date;
  /** Channels the notify step asks for budgets (default: the shared registry; the ai-worker registers the built-in channels). */
  registry?: ChannelRegistry;
  /** The real steps (default: `aiStep` / `notifyStep`); tests pass ones built with a fake router / Telegram. */
  steps?: Partial<Record<(typeof DELEGATED_STEP_NAMES)[number] | "late", CycleStepFn>>;
}

export interface DelegatedRunResult {
  cycle: Cycle;
  /** What was written back into the cycle summary, `ai` then `notify`. */
  steps: DelegatedStepSummary[];
}

function errorText(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : "unknown error").slice(0, 500);
}

/** The step results the container runner already stored in the cycle summary (`collect`, `pipeline`, ...), keyed by step name. */
export function storedStepResults(summaryJson: unknown): Partial<Record<CycleStepName, unknown>> {
  const results: Partial<Record<CycleStepName, unknown>> = {};
  if (typeof summaryJson !== "object" || summaryJson === null || !("steps" in summaryJson) || !Array.isArray(summaryJson.steps)) return results;
  for (const entry of summaryJson.steps as unknown[]) {
    if (typeof entry !== "object" || entry === null || !("name" in entry) || typeof entry.name !== "string") continue;
    if ("result" in entry && entry.result !== undefined) results[entry.name as CycleStepName] = entry.result;
  }
  return results;
}

/** The step context the ai-worker runs the delegated steps with, rebuilt from the cycle row the runner left behind. */
async function createStepContext(options: DelegatedRunOptions, cycle: Cycle): Promise<CycleStepContext> {
  const now = options.now ?? (() => new Date());
  const registry = options.registry ?? defaultRegistry;
  const config = { channels: loadConfig("channels"), search: loadConfig("search"), schedule: loadConfig("schedule") };
  const store = createDbStateStore(options.db);
  const breaker = new CircuitBreaker(
    store,
    () => ({ failures: config.channels.circuit_breaker.failures, cooldownMs: config.channels.circuit_breaker.cooldown_hours * 3_600_000 }),
    now,
  );
  const budget = await BudgetTracker.create({
    store,
    month: monthKey(now(), config.schedule.timezone),
    globalCapUsd: config.channels.paid_total_monthly_budget_usd,
    settingsFor: (id) => registry.settingsFor(id, config.channels),
  });
  return {
    cycle: { id: cycle.id, kind: cycle.kind },
    windowKind: null,
    dryRun: false,
    db: options.db,
    signal: options.signal,
    logger: options.logger.child({ cycle: cycle.id, kind: cycle.kind }),
    now,
    config,
    channels: { registry, cascades: cascadesFromConfig(config.channels), store, breaker, budget, selected: null, runtime: {} },
    results: storedStepResults(cycle.summaryJson),
  };
}

/**
 * Run the `ai` and `notify` steps of a finished cycle (the work `execution: host` moved to the ai-worker): the
 * step context is rebuilt from the cycle row, `notify` sees the fresh `ai` result like it does in a normal cycle,
 * and both outcomes replace the `delegated` placeholders in the cycle summary. A step that throws is recorded as
 * failed; the next one still runs. Returns null when the cycle does not exist (any more).
 */
export async function runDelegatedSteps(options: DelegatedRunOptions): Promise<DelegatedRunResult | null> {
  const cycle = await getCycle(options.db, options.cycleId);
  if (!cycle) return null;
  const now = options.now ?? (() => new Date());
  const ctx = await createStepContext(options, cycle);
  const summaries: DelegatedStepSummary[] = [];
  for (const name of DELEGATED_STEP_NAMES) {
    // Without a test override the `ai` step stops before the late sub-tasks (translation); they run after the push.
    const fn = options.steps?.[name] ?? (name === "ai" ? aiMainStep : notifyStep);
    const started = now().getTime();
    if (options.signal.aborted) {
      summaries.push({ name, status: "skipped", durationMs: 0, reason: "ai-worker stopped" });
      continue;
    }
    try {
      const outcome = await fn(ctx);
      const result = outcome?.result;
      if (result !== undefined) (ctx.results as Partial<Record<CycleStepName, unknown>>)[name] = result;
      summaries.push({ name, status: outcome?.status ?? "ok", durationMs: now().getTime() - started, ...(result === undefined ? {} : { result }) });
    } catch (error) {
      options.logger.error("delegated step failed", { cycle: cycle.id, step: name, error: errorText(error) });
      summaries.push({ name, status: "failed", durationMs: now().getTime() - started, error: errorText(error) });
    }
  }
  // The push is out: record it now, translation may take a long time.
  await applyDelegatedSteps(options.db, cycle.id, summaries);
  const late = options.steps?.late ?? (options.steps?.ai ? undefined : aiLateStep);
  const aiSummary = summaries.find((s) => s.name === "ai");
  if (late && aiSummary && aiSummary.status !== "skipped" && !options.signal.aborted) {
    const started = now().getTime();
    try {
      const outcome = await late(ctx);
      aiSummary.durationMs += now().getTime() - started;
      const result = aiSummary.result as { subtasks?: unknown[] } | undefined;
      const lateResult = outcome?.result as { subtasks?: unknown[] } | undefined;
      if (lateResult?.subtasks?.length) aiSummary.result = { ...result, subtasks: [...(result?.subtasks ?? []), ...lateResult.subtasks] };
      if (outcome?.status === "failed" && aiSummary.status === "ok") aiSummary.status = "partial";
      else if (outcome?.status === "partial" && aiSummary.status === "ok") aiSummary.status = "partial";
    } catch (error) {
      options.logger.error("delegated late ai step failed", { cycle: cycle.id, error: errorText(error) });
      aiSummary.status = aiSummary.status === "ok" ? "partial" : aiSummary.status;
    }
    await applyDelegatedSteps(options.db, cycle.id, summaries);
  }
  return { cycle, steps: summaries };
}
