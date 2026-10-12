import { loadConfig, type AiConfig } from "@/lib/config";
import type { CycleStepContext, CycleStepFn, StepResult } from "@/lib/cycle/steps";
import { getCycle } from "@/lib/db/repos/cycles";

import { QUOTA_GUARD_CODE, quotaGuardAttempts, quotaGuardResume, quotaGuardResumeOf } from "./errors";
import { createDefaultProviders } from "./providers";
import { createAiRouter, type AiRouter } from "./router";
import { createDbHealthStore } from "./health";
import { createDbQuotaStore } from "./quota-guard";
import { createDbUsageStore } from "./usage";

/** What an AI sub-task (scoring, signals, translation, ...) gets to work with. */
export interface AiSubtaskContext {
  cycle: CycleStepContext;
  router: AiRouter;
  config: AiConfig;
  /** `per_cycle_limit` from ai.yaml: how many postings one cycle may send to the AI. */
  perCycleLimit: number;
}

export interface AiSubtask {
  /** Unique; registering the same name again replaces the earlier one. */
  name: string;
  /** Runs after the push: its result is not needed for the push and may take long (translation). */
  late?: boolean;
  run(ctx: AiSubtaskContext): Promise<unknown>;
}

/**
 * What a sub-task returns when it did not do its work for a reason the user has to fix (an empty profile):
 * the step records it as `skipped` with this reason instead of `ok`, and the step itself as `partial`.
 */
export interface SkippedSubtask<R = unknown> {
  skipReason: string;
  result: R;
}

export function skipSubtask<R>(reason: string, result: R): SkippedSubtask<R> {
  return { skipReason: reason, result };
}

function asSkipped(value: unknown): SkippedSubtask | null {
  if (typeof value !== "object" || value === null || !("skipReason" in value)) return null;
  const { skipReason } = value as { skipReason: unknown };
  return typeof skipReason === "string" ? (value as SkippedSubtask) : null;
}

/** `quotaResumeAt` of a sub-task result that has one (the scoring result). */
function quotaResumeOf(result: unknown): string | null | undefined {
  if (typeof result !== "object" || result === null || !("quotaResumeAt" in result)) return undefined;
  const { quotaResumeAt } = result as { quotaResumeAt: unknown };
  return typeof quotaResumeAt === "string" || quotaResumeAt === null ? quotaResumeAt : undefined;
}

const subtasks = new Map<string, AiSubtask>();

/** Later features hook in here; sub-tasks run in registration order inside the `ai` cycle step. */
export function registerAiSubtask(subtask: AiSubtask): void {
  subtasks.set(subtask.name, subtask);
}

export function listAiSubtasks(): AiSubtask[] {
  return [...subtasks.values()];
}

/** Remove every sub-task. For tests. */
export function resetAiSubtasks(): void {
  subtasks.clear();
}

export interface AiStepDeps {
  /** Override how the router is built (tests). */
  createRouter?: (ctx: CycleStepContext, config: AiConfig, limits: { deadline: Date | null; cycleStartedAt: Date | null }) => AiRouter;
  loadAiConfig?: () => AiConfig;
  /** `main`: the sub-tasks the push needs (score, signals); `late`: the ones marked `late`; `all` (default): both, in order. */
  phase?: "main" | "late" | "all";
}

interface SubtaskSummary {
  name: string;
  status: "ok" | "failed" | "skipped";
  durationMs: number;
  result?: unknown;
  error?: string;
  /** Why a `skipped` sub-task did not run (`cycle cancelled` is in `error`). */
  reason?: string;
  /** With `reason: "quota_guard"`: when the usage cap is expected to let the AI work again (ISO; null = the next cycle). */
  resumeAt?: string | null;
}

/**
 * When the cycle started (`cycles.started_at`): the per-cycle usage cap counts the calls since then, so the main and the
 * late phase (two routers, maybe two processes) share one count. Falls back to `fallback` when the row cannot be read.
 */
async function cycleStart(ctx: CycleStepContext, fallback: Date): Promise<Date | null> {
  if (ctx.db === null || ctx.cycle.id === null) return null;
  try {
    return (await getCycle(ctx.db, ctx.cycle.id))?.startedAt ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * The `ai` step of a processing cycle. It ships only the frame: it builds the
 * router once and runs the registered sub-tasks one after another; a failing sub-task does not stop
 * the next one.
 */
export function createAiStep(deps: AiStepDeps = {}): CycleStepFn {
  return async (ctx): Promise<StepResult | void> => {
    const phase = deps.phase ?? "all";
    const list = listAiSubtasks().filter((s) => phase === "all" || (phase === "late") === (s.late === true));
    if (list.length === 0) return { result: { subtasks: [] } };
    const config = (deps.loadAiConfig ?? (() => loadConfig("ai")))();
    const started = ctx.now();
    // A cycle that found nothing new only works off the backlog: it gets the (smaller) idle budget.
    const idle = typeof ctx.results.pipeline === "object" && ctx.results.pipeline !== null && (ctx.results.pipeline as { created?: unknown }).created === 0;
    const budgetMinutes = idle ? config.idle_cycle_budget_minutes : config.cycle_budget_minutes;
    const deadline = budgetMinutes > 0 ? new Date(started.getTime() + budgetMinutes * 60_000) : null;
    const cycleStartedAt = ctx.dryRun ? null : await cycleStart(ctx, started);
    const router =
      deps.createRouter?.(ctx, config, { deadline, cycleStartedAt }) ??
      createAiRouter({
        config,
        providers: createDefaultProviders(config, { logger: ctx.logger }),
        usage: ctx.db ? createDbUsageStore(ctx.db) : null,
        health: ctx.db ? createDbHealthStore(ctx.db) : null,
        quota: ctx.db ? createDbQuotaStore(ctx.db) : null,
        origin: "cycle",
        cycleStartedAt,
        deadline,
        timeZone: ctx.config.schedule.timezone,
        now: ctx.now,
        logger: ctx.logger,
      });
    // Every provider cooling down, capped or off: do not even start (each sub-task would only collect refusals).
    if (!ctx.dryRun) {
      const check = await router.usable(phase === "late" ? "translate" : "score");
      if (!check.usable) {
        const blocked = check.blocked.map((b) => ({ provider: b.provider, kind: b.kind, message: b.message }));
        // Same decision as for a failed call: another provider that needs a login or broke keeps the cap from being named
        const capped = quotaGuardResumeOf(check.blocked);
        if (capped) {
          // Job Radar's own usage cap (or a limit the provider reported) holds the AI back: the work waits, nothing failed
          const guards = quotaGuardAttempts(check.blocked).map((b) => ({ provider: b.provider, reason: b.guard.reason, resumeAt: b.guard.resumeAt }));
          const resumeAt = capped.resumeAt;
          ctx.logger.warn("ai step skipped: Job Radar's AI usage cap reached", { guards: guards.map((g) => `${g.provider}: ${g.reason}`), resumeAt });
          return { result: { subtasks: [], skipped: QUOTA_GUARD_CODE, resumeAt, guards, blocked } };
        }
        ctx.logger.warn("ai step skipped: no provider can be tried", { blocked: check.blocked.map((b) => `${b.provider}: ${b.message}`) });
        return { result: { subtasks: [], skipped: "no_provider_available", blocked } };
      }
    }
    const summaries: SubtaskSummary[] = [];
    for (const subtask of list) {
      if (ctx.signal.aborted) {
        summaries.push({ name: subtask.name, status: "skipped", durationMs: 0, error: "cycle cancelled" });
        continue;
      }
      const started = ctx.now().getTime();
      try {
        const result = await subtask.run({ cycle: ctx, router, config, perCycleLimit: config.per_cycle_limit });
        const skipped = asSkipped(result);
        if (skipped) {
          ctx.logger.warn("ai sub-task skipped", { subtask: subtask.name, reason: skipped.skipReason });
          const resumeAt = skipped.skipReason === QUOTA_GUARD_CODE ? quotaResumeOf(skipped.result) : undefined;
          summaries.push({
            name: subtask.name,
            status: "skipped",
            reason: skipped.skipReason,
            ...(resumeAt !== undefined ? { resumeAt } : {}),
            durationMs: ctx.now().getTime() - started,
            result: skipped.result,
          });
        } else {
          summaries.push({ name: subtask.name, status: "ok", durationMs: ctx.now().getTime() - started, ...(result === undefined ? {} : { result }) });
        }
      } catch (error) {
        const capped = quotaGuardResume(error);
        if (capped) {
          ctx.logger.warn("ai sub-task skipped: Job Radar's AI usage cap reached", { subtask: subtask.name, resumeAt: capped.resumeAt });
          summaries.push({ name: subtask.name, status: "skipped", reason: QUOTA_GUARD_CODE, resumeAt: capped.resumeAt, durationMs: ctx.now().getTime() - started });
          continue;
        }
        const text = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
        ctx.logger.error("ai sub-task failed", { subtask: subtask.name, error: text.slice(0, 300) });
        summaries.push({ name: subtask.name, status: "failed", durationMs: ctx.now().getTime() - started, error: text.slice(0, 500) });
      }
    }
    const failed = summaries.filter((s) => s.status === "failed").length;
    // A sub-task skipped for a reason (not a cancelled cycle) did not do its work: the step is not "ok".
    const blocked = summaries.filter((s) => s.status === "skipped" && s.reason !== undefined).length;
    const status = failed === summaries.length ? "failed" : failed === 0 && blocked === 0 ? "ok" : "partial";
    return { status, result: { subtasks: summaries } };
  };
}

export const aiStep: CycleStepFn = createAiStep();
/** The part of the `ai` step the push needs; the ai-worker runs it before `notify`. */
export const aiMainStep: CycleStepFn = createAiStep({ phase: "main" });
/** Sub-tasks marked `late` (translation); the ai-worker runs them after `notify`. */
export const aiLateStep: CycleStepFn = createAiStep({ phase: "late" });
