// @vitest-environment node
import { describe, expect, it } from "vitest";

import { afterMarkAllSeen, afterVisit, effectiveSeenUpTo, isNewSince, VISIT_SESSION_GAP_MINUTES, type VisitState } from "@/lib/jobs/visit";

const t = (hhmm: string) => new Date(`2026-10-07T${hhmm}:00Z`);
const minutes = (from: Date, n: number) => new Date(from.getTime() + n * 60_000);

describe("new since last visit", () => {
  it("shows nothing as new before the first visit is recorded", () => {
    expect(effectiveSeenUpTo(null, t("09:00"))).toBeNull();
    expect(isNewSince(t("08:00"), null)).toBe(false);
  });

  it("the first visit marks everything before it as seen", () => {
    expect(afterVisit(null, t("09:00"))).toEqual({ seenUpTo: t("09:00"), lastActiveAt: t("09:00") });
  });

  it("opens inside one visit keep the marker, so a reload does not clear the dots", () => {
    const state: VisitState = { seenUpTo: t("07:00"), lastActiveAt: t("09:00") };
    const soon = minutes(t("09:00"), VISIT_SESSION_GAP_MINUTES);
    expect(effectiveSeenUpTo(state, soon)).toEqual(t("07:00"));
    expect(afterVisit(state, soon)).toEqual({ seenUpTo: t("07:00"), lastActiveAt: soon });
  });

  it("the first open after a break moves the marker to the end of the previous visit, already on that render", () => {
    const state: VisitState = { seenUpTo: t("07:00"), lastActiveAt: t("09:00") };
    const later = minutes(t("09:00"), VISIT_SESSION_GAP_MINUTES + 1);
    // the page reads the marker before the visit is recorded: both agree
    expect(effectiveSeenUpTo(state, later)).toEqual(t("09:00"));
    expect(afterVisit(state, later)).toEqual({ seenUpTo: t("09:00"), lastActiveAt: later });
  });

  it("marks all seen at the given instant", () => {
    expect(afterMarkAllSeen(t("12:00"))).toEqual({ seenUpTo: t("12:00"), lastActiveAt: t("12:00") });
  });

  it("a job first seen after the marker is new, one at or before it is not", () => {
    expect(isNewSince(t("09:01"), t("09:00"))).toBe(true);
    expect(isNewSince(t("09:00"), t("09:00"))).toBe(false);
    expect(isNewSince(t("08:59"), t("09:00"))).toBe(false);
  });
});
