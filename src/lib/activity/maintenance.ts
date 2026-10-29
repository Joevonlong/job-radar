import { closeStaleSpans, pruneActivityBatch, reconcileActivitySpans } from "@/lib/db/repos/activity";
import { activityInternals } from "./recorder";
import type { ActivityRecorder } from "./types";

/** Each operation owns a bounded turn on the recorder's dedicated connection. */
export async function closeStaleActivity(recorder: ActivityRecorder): Promise<void> {
  try {
    const internal = activityInternals(recorder);
    if (internal) await internal.runMaintenance((db) => closeStaleSpans(db, { process: internal.process, before: internal.startedAt }));
  } catch { /* Observability must never stop startup or shutdown. */ }
}

export async function reconcileActivity(recorder: ActivityRecorder): Promise<void> {
  try {
    const internal = activityInternals(recorder);
    const settings = internal?.settings();
    if (!internal || !settings) return;
    const count = await internal.runMaintenance((db) => reconcileActivitySpans(db, {
      staleAfterSeconds: settings.liveness.stale_after_seconds,
      startupGraceSeconds: settings.liveness.startup_grace_seconds,
    }));
    if (count) {
      const root = recorder.systemRoot("system.reconcile");
      root.note("info", "spans_reconciled", { count });
      root.finish("ok");
    }
  } catch { /* The recorder also isolates diagnostic failures. */ }
}

export async function pruneActivityLog(recorder: ActivityRecorder, shouldStop: () => boolean = () => false): Promise<void> {
  const total = { roots: 0, events: 0 };
  try {
    const internal = activityInternals(recorder);
    const settings = internal?.settings();
    if (!internal || !settings) return;
    const options = {
      days: settings.retention.days, maxEvents: settings.retention.max_events, batchSize: settings.prune.batch_size,
      liveness: { staleAfterSeconds: settings.liveness.stale_after_seconds, startupGraceSeconds: settings.liveness.startup_grace_seconds },
    };
    for (const phase of ["days", "events"] as const) {
      let rootId: string | undefined;
      while (!shouldStop()) {
        const batch = await internal.runMaintenance((db) => pruneActivityBatch(db, { ...options, phase, rootId }));
        if (!batch) return;
        total.roots += batch.roots;
        total.events += batch.events;
        if (!batch.found) break;
        rootId = batch.nextRootId ?? undefined;
      }
    }
  } catch { /* Each batch already has a deadline and safe warning. */ }
  finally {
    if (total.roots || total.events) {
      const root = recorder.systemRoot("system.prune");
      root.note("info", "pruned", total);
      root.finish("ok");
    }
  }
}

/** Starts immediately in the background; the runner never awaits this on its startup path. */
export function startActivityMaintenance({ recorder }: { recorder: ActivityRecorder }): { stop(): void } {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async (startup: boolean): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      if (startup) await closeStaleActivity(recorder);
      if (!stopped) await reconcileActivity(recorder);
      if (!startup && !stopped) await pruneActivityLog(recorder, () => stopped);
    } catch { /* Maintenance is optional to the business process. */ }
    finally {
      running = false;
      const settings = activityInternals(recorder)?.settings();
      if (!stopped && settings) {
        timer = setTimeout(() => { timer = undefined; void run(false); }, settings.prune.every_minutes * 60_000);
        timer.unref();
      }
    }
  };
  const unsubscribe = activityInternals(recorder)?.subscribeSettings(() => {
    if (!stopped && !running && !timer) void run(true);
  });
  void run(true);
  return { stop() { stopped = true; clearTimeout(timer); unsubscribe?.(); } };
}
