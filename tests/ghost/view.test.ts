// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ghostReasonListSchema, isDismissActive, type GhostOfJob, type GhostReason } from "@/lib/ghost/types";
import { buildGhostCheckView, ghostMarkText, ghostReasonMessage, ghostShortMessage } from "@/lib/ghost/view";

const longOpen: GhostReason = { code: "long_open", points: 2, days: 214, since: "2026-02-28", from: "posted", channelId: "greenhouse" };
const evergreen: GhostReason = { code: "evergreen_wording", points: 2, patternId: "talent_pool", quote: "This posting is for our talent pool.\nMore", offset: 10 };
const reposted: GhostReason = {
  code: "reposted",
  points: 2,
  channelId: "lever",
  events: [
    { oldId: "a", newId: "b", oldSeen: "2026-05-01", newSeen: "2026-07-01", gapDays: 61 },
    { oldId: "b", newId: "c", oldSeen: "2026-07-01", newSeen: "2026-09-01", gapDays: 62 },
  ],
};

const detail = (over: Partial<GhostOfJob> = {}): GhostOfJob => ({
  level: "likely",
  score: 6,
  reasons: [longOpen, reposted, evergreen],
  checkedAt: new Date("2026-10-01T00:00:00Z"),
  dismissedAt: null,
  dismissedCodes: null,
  dismissed: false,
  ...over,
});

describe("isDismissActive", () => {
  it("holds while every current code was dismissed; a new code brings the mark back", () => {
    expect(isDismissActive(null, [longOpen])).toBe(false);
    expect(isDismissActive(["long_open", "reposted"], [longOpen, reposted])).toBe(true);
    expect(isDismissActive(["long_open", "reposted"], [longOpen])).toBe(true);
    expect(isDismissActive(["long_open"], [longOpen, evergreen])).toBe(false);
  });
});

describe("buildGhostCheckView", () => {
  it("not checked yet", () => {
    expect(buildGhostCheckView(null)).toMatchObject({ state: "not_checked", level: null, tone: "dim", canDismiss: false, canUndo: false });
  });

  it("clear", () => {
    expect(buildGhostCheckView(detail({ level: "none", score: 1, reasons: [] }))).toMatchObject({ state: "clear", tone: "good", canDismiss: false });
  });

  it("likely: warn tone, the quote, can be dismissed", () => {
    expect(buildGhostCheckView(detail())).toMatchObject({ state: "likely", tone: "warn", quote: evergreen.code === "evergreen_wording" ? evergreen.quote : null, canDismiss: true, canUndo: false });
  });

  it("watch: dim tone", () => {
    expect(buildGhostCheckView(detail({ level: "watch", score: 3, reasons: [longOpen, { ...evergreen, points: 1 }] }))).toMatchObject({ state: "watch", tone: "dim", canDismiss: true });
  });

  it("dismissed keeps the stored level and can be undone", () => {
    expect(buildGhostCheckView(detail({ dismissed: true, dismissedCodes: ["long_open", "reposted", "evergreen_wording"] }))).toMatchObject({ state: "dismissed", level: "likely", canDismiss: false, canUndo: true });
  });
});

describe("messages", () => {
  it("full lines carry their values", () => {
    expect(ghostReasonMessage(longOpen)).toEqual({ key: "reason.long_open", values: { days: 214, date: "2026-02-28", channel: "greenhouse" } });
    expect(ghostReasonMessage({ ...longOpen, from: "first_seen", channelId: null })).toEqual({ key: "reason.long_open_first_seen", values: { days: 214 } });
    expect(ghostReasonMessage(reposted)).toEqual({ key: "reason.reposted", values: { channel: "lever", dates: "2026-05-01, 2026-07-01, 2026-09-01" } });
  });

  it("thin_description says which part is missing", () => {
    const thin = { code: "thin_description", points: 1, minWords: 120, channelId: "greenhouse" } as const;
    expect(ghostReasonMessage({ ...thin, words: 40, hasResponsibilities: false, responsibilitiesFrom: "headings" }).key).toBe("reason.thin_short_none");
    expect(ghostReasonMessage({ ...thin, words: 40, hasResponsibilities: true, responsibilitiesFrom: "headings" }).key).toBe("reason.thin_short");
    expect(ghostReasonMessage({ ...thin, words: 400, hasResponsibilities: false, responsibilitiesFrom: "headings" }).key).toBe("reason.thin_none");
    expect(ghostReasonMessage({ ...thin, words: 400, hasResponsibilities: false, responsibilitiesFrom: "breakdown" }).key).toBe("reason.thin_none_breakdown");
  });

  it("short forms for the tooltip", () => {
    expect(ghostShortMessage(longOpen)).toEqual({ key: "short.long_open", values: { days: 214 } });
    expect(ghostShortMessage(reposted)).toEqual({ key: "short.reposted", values: {} });
  });

  it("the JD mark is the quote's first line", () => {
    expect(ghostMarkText("  First line.\nSecond")).toBe("First line.");
  });
});

describe("stored reasons are validated", () => {
  it("rejects unknown codes and extra fields", () => {
    expect(ghostReasonListSchema.safeParse([longOpen, reposted, evergreen]).success).toBe(true);
    expect(ghostReasonListSchema.safeParse([{ ...longOpen, extra: 1 }]).success).toBe(false);
    expect(ghostReasonListSchema.safeParse([{ code: "other", points: 1 }]).success).toBe(false);
  });
});
