import { newId } from "@/lib/activity/ids";
import type { ActivityEventWrite, ActivitySpanWrite } from "@/lib/activity/types";
import { activitySettings } from "../activity/helpers";

export function integrationActivitySettings() {
  const settings = activitySettings();
  settings.writer = { ...settings.writer, statement_timeout_ms: 1000, lock_timeout_ms: 100, flush_deadline_ms: 1500, shutdown_flush_ms: 1200, retry_backoff_ms: 1 };
  return settings;
}
export function activityRow(overrides: Partial<ActivitySpanWrite> = {}): ActivitySpanWrite {
  const id = newId();
  return {
    id, rootId: id, parentId: null, scope: "system", name: "system.backup", process: "runner", status: "running", reasonCode: null,
    startedAt: new Date(), finishedAt: null, lastActivityAt: new Date(), progressDone: null, progressTotal: null, eventsDropped: 0,
    cycleId: null, controlRequestId: null, runId: null, jobId: null, channelId: null, queryId: null, ...overrides,
  };
}
export function activityEvent(root: ActivitySpanWrite, overrides: Partial<ActivityEventWrite> = {}): ActivityEventWrite {
  return { id: newId(), rootId: root.rootId, spanId: root.id, at: root.lastActivityAt, level: "info", code: "item.ok", params: {}, jobId: null, rawPostingId: null, ...overrides };
}
export const liveness = { staleAfterSeconds: 60, startupGraceSeconds: 30 };
