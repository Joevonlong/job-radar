import { z } from "zod";
import { noopRecorder, safeErrorCode, spanScope, type RequestSpanHandle } from "@/lib/activity";
import type { ActivityRecorder } from "@/lib/activity/types";
import { setTimeout as sleep } from "node:timers/promises";

import { AiProviderError } from "@/lib/ai/errors";
import { isAbortError } from "@/lib/channels/errors";
import type { ChannelLogger } from "@/lib/channels/types";
import { freshenConfig } from "@/lib/config/fresh";
import { isCycleWaitingForLock } from "@/lib/cycle/lock-waiters";
import type { Db } from "@/lib/db/client";
import {
  claimNextControlRequest,
  CONTROL_REQUEST_KINDS,
  finishControlRequest,
  getControlRequest,
  requeueInterruptedControlRequests,
  type ControlRequest,
  type ControlRequestKind,
  type ControlLane,
} from "@/lib/db/repos/control-requests";

import { getControlHandler } from "./handlers";
import type { ControlHandlerContext, ControlOutcome } from "./types";

const MAX_ERROR_CHARS = 300;

/** Why a request that a shutdown interrupted waits again (kept in its `result` until it runs). */
export const INTERRUPTED_BY_SHUTDOWN = "the process stopped while the request was running";

function describe(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : "unknown error").slice(0, MAX_ERROR_CHARS);
}

export interface ControlPollOptions {
  activity?: ActivityRecorder;
  db: Db;
  signal: AbortSignal;
  logger: ChannelLogger;
  onCycleFinished?: ControlHandlerContext["onCycleFinished"];
  /** Omitted: one queue for all kinds (runner and --once). */
  lane?: ControlLane;
  /**
   * The kinds this process may claim, asked again for every claim (a hot-reloaded `ai.yaml: execution` takes effect
   * at once). Omitted: every kind. The runner and the ai-worker each pass their own.
   */
  kinds?: () => readonly ControlRequestKind[];
  /**
   * A request that fails because `signal` aborted (a deploy or launchd restarting the process) goes back to
   * `pending` for the next start, at most this many times (`ai.yaml: host_worker.requeue_interrupted_max`, read when
   * it happens). Omitted: it fails like any other.
   */
  maxRequeues?: () => number;
}

/**
 * Did the abort of `signal` (not some other problem that happens to coincide with a shutdown) end this request? True for
 * an outcome that reports `error: "aborted"` (the handlers' convention) and for an abort error a handler threw.
 */
export function failedBecauseAborted(outcome: ControlOutcome, thrown: unknown, signal: AbortSignal): boolean {
  if (outcome.status !== "failed" || !signal.aborted) return false;
  if (outcome.result.error === "aborted") return true;
  return isAbortError(thrown) || (thrown instanceof AiProviderError && thrown.kind === "aborted");
}

/**
 * The kinds to claim now: `kinds` (undefined = every kind), but no `run_cycle` while a cycle of this process waits for the
 * cycle lock (`lock-waiters.ts`): a manual cycle started now would take the lock from it again. Once that cycle runs, the
 * queued ones it covers end as done, the others run after it.
 */
function claimableKinds(kinds: readonly ControlRequestKind[] | undefined): readonly ControlRequestKind[] | undefined {
  if (!isCycleWaitingForLock()) return kinds;
  return (kinds ?? CONTROL_REQUEST_KINDS).filter((kind) => kind !== "run_cycle");
}

/**
 * Claim the oldest pending request, run its handler and record the outcome. A handler that throws
 * (or a kind nobody handles) fails the request, never the runner. Returns the finished request (done / failed),
 * or null when nothing was pending.
 */
export async function processNextControlRequest(options: ControlPollOptions): Promise<ControlRequest | null> {
  const { db, signal, logger } = options;
  const request = await claimNextControlRequest(db, claimableKinds(options.kinds?.()), { lane: options.lane });
  if (!request) return null;
  const recorder = options.activity ?? noopRecorder;
  const cycle = z.object({ cycleId: z.number().int().positive() }).safeParse(request.payload);
  const job = z.object({ jobId: z.number().int().positive() }).safeParse(request.payload);
  const handle: RequestSpanHandle = request.kind === "run_ai" && cycle.success
    ? { ...recorder.attachCycle(cycle.data.cycleId).child("request.run_ai", { controlRequestId: request.id }), discard() {} }
    : recorder.requestRoot(request, request.kind === "run_cycle" ? { deferred: true } : job.success ? { jobId: job.data.jobId } : {});
  let discarded = false;
  const span: RequestSpanHandle = { ...handle, discard() { if (!discarded) { discarded = true; handle.discard(); } } };
  const scope = spanScope(span, "interrupted", "not_recorded");
  try {
    const log = logger.child({ controlRequest: request.id, kind: request.kind });
    log.info("control request started");
    let outcome: ControlOutcome;
    let thrown: unknown;
    const handler = getControlHandler(request.kind);
    if (!handler) {
      outcome = { status: "failed", result: { error: "no_handler" } };
    } else {
      try {
        // The request runs with the config files as they are now (the web may have changed them since the last one).
        // Inside the try: whatever goes wrong fails this request instead of leaving it `running`.
        freshenConfig(log);
        outcome = await handler(request, { db, signal, logger: log, onCycleFinished: options.onCycleFinished, activity: span, recorder });
      } catch (error) {
        thrown = error;
        log.error("control request failed", { error: describe(error) });
        outcome = { status: "failed", result: { error: "handler_error", detail: describe(error) } };
      }
    }
    if (failedBecauseAborted(outcome, thrown, signal) && options.maxRequeues) {
      const { requeued } = await requeueInterruptedControlRequests(db, { id: request.id, reason: INTERRUPTED_BY_SHUTDOWN, maxRequeues: options.maxRequeues() });
      if (requeued > 0) {
        scope.set("interrupted");
        log.info("control request interrupted by the shutdown: queued again");
        return getControlRequest(db, request.id);
      }
    }
    const finished = await finishControlRequest(db, request.id, outcome);
    scope.set(outcome.status === "done" ? "ok" : "failed", outcome.status === "failed" ? safeErrorCode(outcome.result.error) : undefined);
    log.info("control request finished", { status: outcome.status });
    return finished;
  } finally { if (!discarded) scope.close(); }
}

/**
 * Poll `control_requests` until `signal` aborts: drain the pending requests one at a time (at most
 * `maxPerRound()` per round, default all), then wait `pollSeconds()` (both read again every round, so a
 * hot-reloaded config takes effect at once). A database error is logged and retried on the next round.
 */
export async function runControlPoller(options: ControlPollOptions & { pollSeconds: () => number; maxPerRound?: () => number }): Promise<void> {
  const { signal, logger } = options;
  while (!signal.aborted) {
    try {
      const limit = options.maxPerRound ? Math.max(1, options.maxPerRound()) : Number.POSITIVE_INFINITY;
      let handled = 0;
      while (!signal.aborted && handled < limit && (await processNextControlRequest(options)) !== null) {
        handled += 1;
      }
    } catch (error) {
      logger.warn("control poll failed", { error: describe(error) });
    }
    try {
      await sleep(Math.max(1, options.pollSeconds()) * 1000, undefined, { signal });
    } catch {
      // aborted: leave the loop
    }
  }
}
