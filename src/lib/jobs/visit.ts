/**
 * "New since my last visit". The dashboard remembers when the user last looked at Today or
 * /jobs; a job first seen after that moment gets a "new" dot. A visit is a session: opens within
 * `VISIT_SESSION_GAP_MINUTES` of the previous one belong to the same session, so reloading the page
 * does not make the dots vanish; the first open after a longer break moves the marker forward to the
 * end of the previous session.
 *
 * Whether a single job was looked at is `job_seen` (the bold rows); this marker only draws the "new since your last visit"
 * divider of the lists. "Mark all seen" marks jobs seen and no longer moves the marker.
 *
 * Pure (no database, no clock): the repo stores the state, the pages and the action call these.
 */

/** Opens closer together than this are one visit. The only knob of the feature, a UI behaviour rather than a job-search threshold. */
export const VISIT_SESSION_GAP_MINUTES = 30;

export interface VisitState {
  /** Jobs first seen up to this instant count as seen; null before the first visit. */
  seenUpTo: Date | null;
  /** The last time the user opened Today or /jobs (or marked everything seen). */
  lastActiveAt: Date;
}

/** The marker a page render should compare `first_seen_at` with; null = no visit recorded yet (nothing is "new"). */
export function effectiveSeenUpTo(state: VisitState | null, now: Date): Date | null {
  if (!state) return null;
  const gapMs = VISIT_SESSION_GAP_MINUTES * 60_000;
  if (now.getTime() - state.lastActiveAt.getTime() > gapMs) return state.lastActiveAt;
  return state.seenUpTo;
}

/** The state after the user opened a page at `now`. The first ever visit marks everything before it as seen. */
export function afterVisit(state: VisitState | null, now: Date): VisitState {
  return { seenUpTo: state ? effectiveSeenUpTo(state, now) : now, lastActiveAt: now };
}

/** The state of a marker moved to `now` (before "mark all seen" did this; kept as the session rules' reference). */
export function afterMarkAllSeen(now: Date): VisitState {
  return { seenUpTo: now, lastActiveAt: now };
}

/** A job first seen after the marker is new. */
export function isNewSince(firstSeenAt: Date, seenUpTo: Date | null): boolean {
  return seenUpTo !== null && firstSeenAt.getTime() > seenUpTo.getTime();
}
