import { loadConfig, type AiConfig } from "@/lib/config";
import { insertControlRequest } from "@/lib/db/repos/control-requests";

import type { CycleStepFn, StepResult } from "./steps";

/** What the cycle summary stores for a step the ai-worker does instead (replaced when the worker is done). */
export interface DelegatedStepResult {
  delegated: true;
  to: "ai-worker";
  /** The `run_ai` control request that carries the work. */
  requestId: number | null;
  /** Why nothing was queued, when that is so. */
  skipped?: "no_database" | "no_request";
}

export interface DelegationDeps {
  loadAiConfig?: () => AiConfig;
}

const executionOf = (deps: DelegationDeps): AiConfig["execution"] => (deps.loadAiConfig ?? (() => loadConfig("ai")))().execution;

/**
 * The `ai` step with `execution: host`: nothing runs here (the container has no AI credential); the
 * step leaves one `run_ai` request naming the cycle. The ai-worker on the host picks it up once the cycle has
 * finished, runs the AI sub-tasks and then the notify step, and writes both results into the cycle summary.
 * With `execution: container` it is just `local`.
 */
export function createDelegatingAiStep(local: CycleStepFn, deps: DelegationDeps = {}): CycleStepFn {
  return async (ctx): Promise<StepResult | void> => {
    if (executionOf(deps) === "container") return local(ctx);
    if (ctx.db === null || ctx.cycle.id === null) {
      return { result: { delegated: true, to: "ai-worker", requestId: null, skipped: "no_database" } satisfies DelegatedStepResult };
    }
    const request = await insertControlRequest(ctx.db, { kind: "run_ai", payload: { cycleId: ctx.cycle.id } });
    ctx.logger.info("ai step delegated to the ai-worker", { request: request.id });
    return { result: { delegated: true, to: "ai-worker", requestId: request.id } satisfies DelegatedStepResult };
  };
}

/**
 * The `notify` step with `execution: host`: the ai-worker sends the messages right after the AI step (so the
 * push sees the fresh scores), via the same `run_ai` request. Here it only records that, and is `partial`
 * when no request was queued (then nobody will send this cycle's messages).
 */
export function createDelegatingNotifyStep(local: CycleStepFn, deps: DelegationDeps = {}): CycleStepFn {
  return async (ctx): Promise<StepResult | void> => {
    if (executionOf(deps) === "container") return local(ctx);
    const ai = ctx.results.ai as Partial<DelegatedStepResult> | undefined;
    const requestId = typeof ai?.requestId === "number" ? ai.requestId : null;
    if (requestId === null) {
      return { status: "partial", result: { delegated: true, to: "ai-worker", requestId: null, skipped: "no_request" } satisfies DelegatedStepResult };
    }
    return { result: { delegated: true, to: "ai-worker", requestId } satisfies DelegatedStepResult };
  };
}
