import { runDelegatedSteps, type DelegatedRunOptions } from "@/lib/cycle/delegated";
import type { DelegatedStepSummary } from "@/lib/db/repos/cycles";

import { runAiPayloadSchema, type ControlHandler } from "./types";

export interface RunAiHandlerOptions {
  /** Test seams: the real steps (built with a fake router / Telegram) and the registry. */
  steps?: DelegatedRunOptions["steps"];
  registry?: DelegatedRunOptions["registry"];
  now?: DelegatedRunOptions["now"];
}

interface SubtaskView {
  name?: unknown;
  status?: unknown;
  reason?: unknown;
  result?: unknown;
}

/** `ai.status` of a run whose scoring was skipped because me.yaml has neither a summary nor skills. */
export const AI_STATUS_PROFILE_INCOMPLETE = "skipped_profile_incomplete";

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The few counters worth showing on /sources, read defensively from the step results (their shapes belong to other features). */
export function summarizeDelegatedSteps(steps: readonly DelegatedStepSummary[]): Record<string, unknown> {
  const ai = steps.find((s) => s.name === "ai");
  const notify = steps.find((s) => s.name === "notify");
  const subtasks: SubtaskView[] =
    typeof ai?.result === "object" && ai.result !== null && "subtasks" in ai.result && Array.isArray(ai.result.subtasks) ? (ai.result.subtasks as SubtaskView[]) : [];
  const resultOf = (name: string): Record<string, unknown> => {
    const entry = subtasks.find((s) => s.name === name);
    return typeof entry?.result === "object" && entry.result !== null ? (entry.result as Record<string, unknown>) : {};
  };
  const jobs = typeof notify?.result === "object" && notify.result !== null && "jobs" in notify.result ? (notify.result.jobs as Record<string, unknown> | undefined) : undefined;
  const score = subtasks.find((s) => s.name === "score");
  // Scoring did not run because of the profile: say so instead of "ok, scored 0".
  const profileIncomplete = score?.status === "skipped" && score.reason === "profile_incomplete";
  const missing = resultOf("score").profileMissing;
  return {
    ai: {
      status: profileIncomplete ? AI_STATUS_PROFILE_INCOMPLETE : (ai?.status ?? "skipped"),
      scored: num(resultOf("score").scored),
      translated: num(resultOf("translate").translated),
      failedSubtasks: subtasks.filter((s) => s.status === "failed").length,
      ...(profileIncomplete ? { reason: "profile_incomplete", profileMissing: Array.isArray(missing) ? missing.filter((m) => typeof m === "string") : [] } : {}),
    },
    notify: { status: notify?.status ?? "skipped", pushed: jobs ? num(jobs.pushed) : null },
  };
}

/**
 * `run_ai`: the `ai` and `notify` steps of a finished cycle, delegated by the container runner
 * (`execution: host`). Runs the registered AI sub-tasks (score, signals, translate) and then the push, and
 * writes both outcomes into the cycle summary. Registered by the ai-worker only: it calls the real providers.
 */
export function createRunAiHandler(options: RunAiHandlerOptions = {}): ControlHandler {
  return async (request, context) => {
    const payload = runAiPayloadSchema.safeParse(request.payload);
    if (!payload.success) return { status: "failed", result: { error: "invalid_payload" } };
    const run = await runDelegatedSteps({
      db: context.db,
      cycleId: payload.data.cycleId,
      requestId: request.id,
      signal: context.signal,
      logger: context.logger,
      ...(options.steps ? { steps: options.steps } : {}),
      ...(options.registry ? { registry: options.registry } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    if (run === null) return { status: "failed", result: { error: "cycle_not_found", cycleId: payload.data.cycleId } };
    const result = { cycleId: run.cycle.id, ...summarizeDelegatedSteps(run.steps) };
    const ai = run.steps.find((s) => s.name === "ai");
    if (context.signal.aborted) return { status: "failed", result: { ...result, error: "aborted" } };
    // Nothing got through the AI step: the request failed, however the push went.
    if (ai?.status === "failed") return { status: "failed", result: { ...result, error: "ai_failed" } };
    return { status: "done", result };
  };
}
