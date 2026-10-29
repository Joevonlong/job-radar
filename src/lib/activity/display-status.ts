/** Pure presentation rules. Root observations and thresholds come from the query caller, never global config. */
import type { ActivityRequestStatus, ActivityRootRow, ActivityStatus } from "@/lib/db/queries/activity";

export const DISPLAY_STATUS_CODES = [
  "running", "ai_queued", "ai_running", "ok", "partial", "failed", "skipped", "interrupted", "requeued", "possibly_interrupted", "unknown",
] as const;
export type DisplayStatusCode = (typeof DISPLAY_STATUS_CODES)[number];
export interface DisplayStatus { code: DisplayStatusCode; requestCurrent?: ActivityRequestStatus; possiblyInterrupted: boolean }
export type DisplayStatusRow = Pick<ActivityRootRow,
  "scope" | "status" | "cycleStatus" | "runAi" | "request" | "isCurrentAttempt" |
  "startedAt" | "latestHeartbeatAgeSeconds" | "newerStartup" | "observedAt" | "liveness">;

function ownStatus(status: string): DisplayStatusCode {
  switch (status) {
    case "running": case "ok": case "partial": case "failed": case "skipped": case "interrupted": return status;
    case "succeeded": return "ok";
    default: return "unknown";
  }
}
const result = (code: DisplayStatusCode): DisplayStatus => ({ code, possiblyInterrupted: code === "possibly_interrupted" });
const liveRequest = (status: ActivityRequestStatus | undefined): boolean => status === "pending" || status === "running";

export function displayStatus(row: DisplayStatusRow, now: Date = row.observedAt): DisplayStatus {
  if (row.scope === "cycle") {
    if (row.cycleStatus === "running") return result("running");
    if (row.runAi?.status === "pending") return result("ai_queued");
    if (row.runAi?.status === "running") return result("ai_running");
    if (row.status === "running" && row.cycleStatus !== null && row.cycleStatus !== "unknown") return result("possibly_interrupted");
  }
  if (row.scope === "request") {
    let code = ownStatus(row.status);
    if (row.isCurrentAttempt && row.status === "interrupted" && row.request?.status === "pending") code = "requeued";
    else if (row.status === "running" && row.request && !liveRequest(row.request.status) && row.request.status !== "unknown") code = "possibly_interrupted";
    return { ...result(code), ...(row.isCurrentAttempt && row.request ? { requestCurrent: row.request.status } : {}) };
  }
  if (row.scope === "system" && row.status === "running") {
    const elapsedSeconds = (now.getTime() - row.observedAt.getTime()) / 1000;
    const alive = !row.newerStartup && (row.latestHeartbeatAgeSeconds === null
      ? (now.getTime() - row.startedAt.getTime()) / 1000 <= row.liveness.startupGraceSeconds
      : row.latestHeartbeatAgeSeconds + elapsedSeconds <= row.liveness.staleAfterSeconds);
    if (!alive) return result("possibly_interrupted");
  }
  return result(ownStatus(row.status));
}

/** Children retain their own terminal status; a still-running child cannot outlive its root's business work. */
export function displayChildStatus(span: { status: ActivityStatus }, root: { active: boolean }): DisplayStatus {
  return result(span.status === "running" && !root.active ? "possibly_interrupted" : ownStatus(span.status));
}
