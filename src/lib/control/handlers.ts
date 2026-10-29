import { runCycle } from "@/lib/cycle/run-cycle";
import { freshenConfig, loadConfig } from "@/lib/config";
import type { ControlRequestKind } from "@/lib/db/repos/control-requests";

import { testChannelHandler } from "./test-channel";
import { testTelegramHandler } from "./test-telegram";
import { runCyclePayloadSchema, type ControlHandler } from "./types";

/**
 * `run_cycle`: one `manual` cycle, optionally limited to the requested channels. When a running cycle already covers
 * them (a scheduled cycle of every channel), the request is done and points at that cycle (`cycleId`, `coveredBy`): its
 * progress is what the button shows. A running cycle that does not cover them (a `pnpm cycle:run --channel` of other
 * channels) still fails the request with `another_cycle_running`; waiting for it would hold up the serial poller.
 * A backfill rechecks the configured limit before creating a cycle and can never be covered by a running cycle.
 */
export const runCycleHandler: ControlHandler = async (request, context) => {
  const payload = runCyclePayloadSchema.safeParse(request.payload);
  if (!payload.success) return { status: "failed", result: { error: "invalid_payload" } };
  const { channelIds, backfillHours } = payload.data;
  if (backfillHours !== undefined) {
    freshenConfig(context.logger);
    const maxBackfillHours = loadConfig("channels").collect.max_backfill_hours;
    if (backfillHours > maxBackfillHours) return { status: "failed", result: { error: "backfill_over_limit", backfillHours, maxBackfillHours } };
  }
  const outcome = await runCycle("manual", {
    db: context.db,
    activity: context.recorder,
    activityRequestId: request.id,
    onCycleRootCreated: () => context.activity?.discard(),
    signal: context.signal,
    logger: context.logger,
    ...(channelIds ? { channelIds } : {}),
    ...(backfillHours !== undefined ? { backfillHours } : {}),
  });
  try {
    context.onCycleFinished?.(outcome.summary);
  } catch {
    context.logger.warn("cycle maintenance failed");
  }
  const result = { cycleId: outcome.cycleId, cycleStatus: outcome.status, durationMs: outcome.summary.durationMs, ...(backfillHours !== undefined ? { backfillHours } : {}) };
  const coveredBy = outcome.summary.coveredBy ?? null;
  if (outcome.status === "skipped" && coveredBy !== null) {
    if (backfillHours !== undefined) return { status: "failed", result: { ...result, coveredBy, error: "another_cycle_running" } };
    // the covering cycle was running when the lock was tried
    return { status: "done", result: { ...result, cycleId: coveredBy, cycleStatus: "running", coveredBy, skippedCycleId: outcome.cycleId } };
  }
  if (outcome.status === "skipped") return { status: "failed", result: { ...result, error: "another_cycle_running" } };
  if (outcome.status === "failed") return { status: "failed", result: { ...result, error: "cycle_failed" } };
  return { status: "done", result };
};

/**
 * `rescore_stale` / `score_jobs` default: acknowledges the request and reports that nothing was re-scored. The
 * runner replaces it with the real handler (`rescore.ts`, `rescoreStale`) at start-up; it is
 * not the default so that nothing but the runner can reach a real AI provider.
 */
export const rescorePlaceholderHandler: ControlHandler = async () => ({
  status: "done",
  result: { scored: 0, failed: 0, placeholder: true },
});


/**
 * Default of the kinds that reach a real AI provider (`run_ai`, `translate_job`, `run_suggest`): nobody handles them until the
 * ai-worker (or, with `execution: container`, the runner) plugs the real handler in, so nothing else (tests,
 * the web app) can reach a provider by accident.
 */
export const noHandler: ControlHandler = async () => ({ status: "failed", result: { error: "no_handler" } });

const DEFAULT_HANDLERS: Record<ControlRequestKind, ControlHandler> = {
  run_cycle: runCycleHandler,
  rescore_stale: rescorePlaceholderHandler,
  run_suggest: noHandler,
  run_ai: noHandler,
  translate_job: noHandler,
  breakdown_job: noHandler,
  score_jobs: noHandler,
  // The channel test and the Telegram test message call no AI: the runner handles them itself
  test_channel: testChannelHandler,
  test_telegram: testTelegramHandler,
  test_ai: noHandler,
  salary_lookup: noHandler,
};

const handlers = new Map<ControlRequestKind, ControlHandler>(Object.entries(DEFAULT_HANDLERS) as Array<[ControlRequestKind, ControlHandler]>);

/**
 * Plug in the handler of a request kind (replaces the previous one). The scoring feature registers the real
 * `rescore_stale` here before the runner's poller starts.
 */
export function registerControlHandler(kind: ControlRequestKind, handler: ControlHandler): void {
  handlers.set(kind, handler);
}

export function getControlHandler(kind: ControlRequestKind): ControlHandler | undefined {
  return handlers.get(kind);
}

/** Restore the built-in handlers. For tests. */
export function resetControlHandlers(): void {
  for (const [kind, handler] of Object.entries(DEFAULT_HANDLERS) as Array<[ControlRequestKind, ControlHandler]>) handlers.set(kind, handler);
}
