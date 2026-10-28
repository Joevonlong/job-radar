"use client";

import { useEffect, useEffectEvent, useState } from "react";

import type { ControlQueueView } from "@/lib/control/request-view-schema";
import { STATUS_POLL_MS } from "@/lib/settings/constants";

export type ControlRequestStage = "pending" | "running";

/**
 * One read of a waiting request, as a component's `read` maps its server answer:
 * - `null`: nothing could be read this time (a dropped connection, a server error): the next tick reads again;
 * - `missing`: the request does not exist, or is not this page's: final, reported once through `onFailed(null)`;
 * - `waiting`: still pending, running or following a covering cycle, with its queue view and the component's own payload;
 * - `done` / `failed`: final, with the component's payload.
 */
export type ControlRequestRead<W, D, F> =
  | null
  | { state: "missing" }
  | { state: "waiting"; stage: ControlRequestStage; queue: ControlQueueView | null; waiting: W }
  | { state: "done"; done: D }
  | { state: "failed"; failed: F };

export interface UseControlRequestOptions<W, D, F> {
  /** The request to follow; null (also later, e.g. when the server shows a fresh result) stops at once. */
  requestId: number | null;
  /** What the server rendered with the page (or the click returned), shown until the first read answers. */
  initialStage?: ControlRequestStage;
  initialQueue?: ControlQueueView | null;
  read: (requestId: number) => Promise<ControlRequestRead<W, D, F>>;
  onDone: (done: D) => void;
  /** `failed` is null for a missing request; `lastWaiting` is the newest waiting payload seen before the end. */
  onFailed: (failed: F | null, lastWaiting: W | null) => void;
}

export interface ControlRequestWait<W> {
  /** Null while there is no request to follow. */
  stage: ControlRequestStage | null;
  queue: ControlQueueView | null;
  /** The newest waiting payload. */
  waiting: W | null;
  /** The process that claims the request has no fresh heartbeat. Polling goes on; it turns false when the process is back. */
  offline: boolean;
}

/**
 * Follow one control request until it ends: read it at once (on mount and whenever `requestId` changes), then every
 * `STATUS_POLL_MS`, with no wait limit. `onDone` / `onFailed` are each called at most once per request, after which polling
 * stops; it also stops on unmount and when `requestId` becomes null.
 */
export function useControlRequest<W, D, F>(options: UseControlRequestOptions<W, D, F>): ControlRequestWait<W> {
  const { requestId } = options;
  // keyed by the request: a new request starts from its initial state without resetting state in the effect
  const [polled, setPolled] = useState<{ id: number; stage: ControlRequestStage; queue: ControlQueueView | null; waiting: W } | null>(null);

  const read = useEffectEvent((id: number) => options.read(id));
  const done = useEffectEvent((value: D) => options.onDone(value));
  const failed = useEffectEvent((value: F | null, lastWaiting: W | null) => options.onFailed(value, lastWaiting));

  useEffect(() => {
    if (requestId === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastWaiting: W | null = null;
    const tick = async (): Promise<void> => {
      let result: ControlRequestRead<W, D, F> = null;
      try {
        result = await read(requestId);
      } catch {
        result = null; // the next tick reads again
      }
      if (stopped) return;
      if (result?.state === "done") {
        stopped = true;
        done(result.done);
        return;
      }
      if (result?.state === "failed" || result?.state === "missing") {
        stopped = true;
        failed(result.state === "failed" ? result.failed : null, lastWaiting);
        return;
      }
      if (result?.state === "waiting") {
        lastWaiting = result.waiting;
        const { stage, queue, waiting } = result;
        setPolled({ id: requestId, stage, queue, waiting });
      }
      timer = setTimeout(() => void tick(), STATUS_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [requestId]);

  if (requestId === null) return { stage: null, queue: null, waiting: null, offline: false };
  const current = polled !== null && polled.id === requestId ? polled : null;
  const queue = (current ? current.queue : options.initialQueue) ?? null;
  return {
    stage: current?.stage ?? options.initialStage ?? "pending",
    queue,
    waiting: current?.waiting ?? null,
    offline: queue?.worker.online === false,
  };
}
