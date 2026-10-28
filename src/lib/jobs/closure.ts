/**
 * The status a job shows = what the lifecycle step found (`jobs.status`) with the user's own judgement on top
 * (`job_closure_overrides`). Pure: `queries/job-status.ts` writes the same rule in SQL (the integration test checks they agree).
 */
export type AutoStatus = "active" | "possibly_closed" | "closed";
export type ClosureAction = "closed" | "open";
/** Why a job shows as (possibly) closed: the user's mark, a 404 / 410, a phrase on the posting, or no source listing it any more. */
export type ClosedReason = "manual" | "gone" | "dormant" | "phrase" | "possibly";
/** What one recheck of a link found (the outcome of `jobs.link_check_json`). */
export type LinkCheckOutcome = "alive" | "gone" | "phrase" | "unknown" | "robots";

/**
 * `closed` by the user → closed. `open` by the user ("I checked, it is still open") → active, whatever the automatic checks say.
 * No judgement → the automatic status.
 */
export function effectiveJobStatus(auto: AutoStatus, override: ClosureAction | null): AutoStatus {
  if (override === "closed") return "closed";
  if (override === "open") return "active";
  return auto;
}

/** The reason to show next to a (possibly) closed job; null for an open one. */
export function closedReason(auto: AutoStatus, override: ClosureAction | null, lastCheck: LinkCheckOutcome | null, dormant = false): ClosedReason | null {
  if (override === "closed") return "manual";
  if (override === "open") return null;
  if (auto === "closed") return "gone";
  if (auto === "possibly_closed") return dormant ? "dormant" : lastCheck === "phrase" ? "phrase" : "possibly";
  return null;
}

/** Reasons for which the user can confirm a closure or say the posting is still open. */
export function isPossiblyClosedReason(reason: ClosedReason | null): boolean {
  return reason === "phrase" || reason === "possibly" || reason === "dormant";
}

/** Longest note a manual close keeps. */
export const CLOSURE_NOTE_MAX = 200;
