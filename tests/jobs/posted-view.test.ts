import { describe, expect, it } from "vitest";

import { buildPostedView, type PostedViewInput } from "@/lib/jobs/posted-view";
import type { GhostReason, RepostEvent } from "@/lib/ghost/types";

const event = (n: number, extra: Partial<RepostEvent> = {}): RepostEvent => ({
  oldId: `old${n}`,
  newId: `new${n}`,
  oldSeen: `2026-0${n}-01`,
  newSeen: `2026-0${n}-20`,
  gapDays: 19,
  ...extra,
});
const reposted = (events: RepostEvent[]): GhostReason => ({ code: "reposted", points: 2, channelId: "greenhouse", events });
const label = (text: string): GhostReason => ({ code: "repost_label", points: 2, channelId: "linkedin", label: text });

const POSTED = new Date("2026-02-02T08:30:00Z");
const base = (extra: Partial<PostedViewInput> = {}): PostedViewInput => ({
  postedAt: POSTED,
  sources: [{ channelId: "greenhouse" }],
  ghost: null,
  ghostOn: true,
  trustedChannels: new Set(["greenhouse", "lever"]),
  ...extra,
});

describe("buildPostedView: the posted date", () => {
  it("is always posted_at, whatever the repost evidence says", () => {
    expect(buildPostedView(base()).postedAt).toBe(POSTED);
    expect(buildPostedView(base({ ghost: { reasons: [reposted([event(5)])] } })).postedAt).toBe(POSTED);
    expect(buildPostedView(base({ postedAt: null, ghost: { reasons: [reposted([event(5)])] } })).postedAt).toBeNull();
  });

  it("flags a date without a time", () => {
    expect(buildPostedView(base({ postedAt: new Date("2026-02-02T00:00:00Z") })).dateOnly).toBe(true);
    expect(buildPostedView(base()).dateOnly).toBe(false);
    expect(buildPostedView(base({ postedAt: null })).dateOnly).toBe(false);
  });
});

describe("buildPostedView: the repost", () => {
  it("none without evidence, without a stored result or with the check off", () => {
    expect(buildPostedView(base()).repost).toBeNull();
    expect(buildPostedView(base({ ghost: { reasons: [] } })).repost).toBeNull();
    expect(buildPostedView(base({ ghost: { reasons: [reposted([event(5)]), label("Reposted 2 weeks ago")] }, ghostOn: false })).repost).toBeNull();
  });

  it("a trusted company's result has no reasons, so no repost", () => {
    expect(buildPostedView(base({ ghost: { reasons: [] } })).repost).toBeNull();
  });

  it("relistings: the newest new link, the oldest old link, the count and the newest gap", () => {
    const view = buildPostedView(base({ ghost: { reasons: [reposted([event(3, { gapDays: 40 }), event(5, { gapDays: 25 })])] } }));
    expect(view.repost).toEqual({
      kind: "events",
      newSeen: new Date("2026-05-20T00:00:00Z"),
      oldestSeen: new Date("2026-03-01T00:00:00Z"),
      count: 2,
      capped: false,
      gapDays: 25,
      label: null,
    });
  });

  it("picks the newest relisting whatever the order of the events", () => {
    const view = buildPostedView(base({ ghost: { reasons: [reposted([event(5), event(3)])] } }));
    expect(view.repost).toMatchObject({ kind: "events", newSeen: new Date("2026-05-20T00:00:00Z") });
  });

  it("ten kept relistings are marked as the latest ones", () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ ...event(1), oldId: `o${i}`, newId: `n${i}`, newSeen: `2026-01-${String(i + 10).padStart(2, "0")}` }));
    expect(buildPostedView(base({ ghost: { reasons: [reposted(ten)] } })).repost).toMatchObject({ kind: "events", count: 10, capped: true, newSeen: new Date("2026-01-19T00:00:00Z") });
  });

  it("only the source's label: no date, the label's words", () => {
    expect(buildPostedView(base({ ghost: { reasons: [label("Reposted 2 weeks ago")] } })).repost).toEqual({ kind: "label", label: "Reposted 2 weeks ago" });
  });

  it("relistings and a label: the relistings give the date, the label rides along", () => {
    const view = buildPostedView(base({ ghost: { reasons: [label("Reposted 2 weeks ago"), reposted([event(5)])] } }));
    expect(view.repost).toMatchObject({ kind: "events", label: "Reposted 2 weeks ago" });
  });

  it("a dismissed check does not hide it (the dismissal says nothing about the evidence)", () => {
    const ghost = { reasons: [reposted([event(5)])], dismissed: true };
    expect(buildPostedView(base({ ghost })).repost).toMatchObject({ kind: "events" });
  });
});

describe("buildPostedView: trust", () => {
  it("a source whose channel states the date itself", () => {
    expect(buildPostedView(base({ sources: [{ channelId: "indeed" }, { channelId: "lever" }, { channelId: "greenhouse" }, { channelId: "lever" }] })).trust).toEqual({
      kind: "trusted",
      channelIds: ["greenhouse", "lever"],
    });
  });

  it("aggregators only", () => {
    expect(buildPostedView(base({ sources: [{ channelId: "indeed" }, { channelId: "xing" }] })).trust).toEqual({ kind: "aggregator" });
  });

  it("no source at all", () => {
    expect(buildPostedView(base({ sources: [] })).trust).toEqual({ kind: "none" });
  });
});
