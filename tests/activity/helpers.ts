import type { ActivityLogConfig } from "@/lib/config/schemas/activity-log";
import type { ActivityRecorder, RequestSpanHandle, SpanHandle, SpanLinks, SpanName } from "@/lib/activity/types";

export interface RecordedSpan {
  name: SpanName;
  parentId?: string;
  links: SpanLinks;
  deferred?: boolean;
  finishes: Array<Parameters<SpanHandle["finish"]>>;
  items: Array<Parameters<SpanHandle["item"]>>;
  notes: Array<Parameters<SpanHandle["note"]>>;
  progress: Array<Parameters<SpanHandle["progress"]>>;
  discards: number;
  handle: RequestSpanHandle;
}

/** Records every invocation, including duplicate finishes that the real writer would ignore. */
export function fakeRecorder() {
  const spans: RecordedSpan[] = [];
  const make = (name: SpanName, links: SpanLinks = {}, parentId?: string, deferred?: boolean): RequestSpanHandle => {
    const id = String(spans.length + 1);
    const entry: RecordedSpan = {
      name, links, parentId, deferred, finishes: [], items: [], notes: [], progress: [], discards: 0,
      handle: {
        id, rootId: parentId ?? id,
        child: (child, childLinks) => make(child, childLinks, id),
        finish: (...args) => { entry.finishes.push(args); },
        item: (...args) => { entry.items.push(args); },
        note: (...args) => { entry.notes.push(args); },
        progress: (...args) => { entry.progress.push(args); },
        discard: () => { entry.discards++; },
      },
    };
    spans.push(entry);
    return entry.handle;
  };
  const recorder: ActivityRecorder = {
    enabled: true,
    cycleRoot: (cycleId, links) => make("cycle", { cycleId, ...(links?.requestId ? { controlRequestId: links.requestId } : {}) }),
    attachCycle: (cycleId) => ({ ...make("cycle", { cycleId }), finish() {} }),
    requestRoot: (request, options) => make(`request.${request.kind}`, { controlRequestId: request.id, ...(options?.jobId ? { jobId: options.jobId } : {}) }, undefined, options?.deferred),
    systemRoot: (name, links) => make(name, links),
    flush: async () => {}, close: async () => {},
  };
  return { recorder, spans };
}

/** Tests own their settings, independently of the shipped YAML. */
export function activitySettings(): ActivityLogConfig {
  return {
    enabled: true, retention: { days: 2, max_events: 9 }, capture: { max_events_per_span: 20 },
    writer: { queue_max: 25, batch_size: 3, flush_ms: 20, connect_timeout_seconds: 1, statement_timeout_ms: 50, lock_timeout_ms: 20,
      flush_deadline_ms: 100, retry_backoff_ms: 200, shutdown_flush_ms: 80, warn_every_seconds: 1 },
    prune: { every_minutes: 1, batch_size: 2, roots_per_batch: 2 },
    ui: { page_size: 4, events_page_size: 6, refresh_seconds: 2, default_range_days: 3, delete_budget_ms: 300 },
    liveness: { stale_after_seconds: 60, startup_grace_seconds: 30 },
  };
}
