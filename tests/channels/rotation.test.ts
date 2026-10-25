// @vitest-environment node
import { describe, expect, it } from "vitest";

import { familyHistory, orderQueries, rotationSummary, turnsOf } from "@/lib/channels/rotation";
import type { SearchQuery } from "@/lib/channels/types";
import type { QueryRunHistoryRow } from "@/lib/db/repos/runs";

const query = (id: string): SearchQuery => ({ id, keywordGroup: id, keywords: [id], location: "Test City", remote: false, remoteScope: null, windowHours: 24, maxResults: 10 });
const queries = ["a", "b", "c", "d", "e"].map(query);
const ids = (items: readonly SearchQuery[]) => items.map((q) => q.id);
const earlier = new Date("2026-01-01T00:00:00Z");
const later = new Date("2026-01-02T00:00:00Z");

describe("orderQueries", () => {
  it("puts missing and null turns first, then ascending timestamps, keeping ties in config order", () => {
    const turns = new Map([["a", later], ["b", earlier], ["c", null], ["d", earlier]]);
    expect(ids(orderQueries(queries, turns, true))).toEqual(["c", "e", "b", "d", "a"]);
    expect(ids(queries)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("always returns a new array, including when disabled or empty", () => {
    for (const enabled of [true, false]) {
      const result = orderQueries(queries, new Map(), enabled);
      expect(result).toEqual(queries);
      expect(result).not.toBe(queries);
    }
    expect(orderQueries(queries, new Map([["a", later]]), false)).toEqual(queries);
    expect(orderQueries([], new Map(), true)).toEqual([]);
  });
});

describe("history projections", () => {
  const rows: QueryRunHistoryRow[] = [
    { channelId: "paid", queryHash: "a", lastTurnAt: earlier, lastCoveredAt: earlier, firstSeenAt: earlier },
    { channelId: "free", queryHash: "a", lastTurnAt: later, lastCoveredAt: later, firstSeenAt: later },
    { channelId: "paid", queryHash: "b", lastTurnAt: null, lastCoveredAt: null, firstSeenAt: later },
    { channelId: "other", queryHash: "a", lastTurnAt: new Date(0), lastCoveredAt: new Date("2030-01-01"), firstSeenAt: new Date(0) },
  ];

  it("takes turns only from the sort channel", () => {
    expect(turnsOf(rows, "paid")).toEqual(new Map([["a", earlier], ["b", null]]));
    expect(turnsOf(rows, "missing")).toEqual(new Map());
  });

  it("merges only family channels: latest turn and coverage, earliest appearance, preserving unknowns", () => {
    const history = familyHistory(rows, ["paid", "free"]);
    expect(history.get("a")).toEqual({ lastTurnAt: later, lastCoveredAt: later, firstSeenAt: earlier });
    expect(history.get("b")).toEqual({ lastTurnAt: null, lastCoveredAt: null, firstSeenAt: later });
    expect(familyHistory([...rows].reverse(), ["paid", "free"])).toEqual(history);
    expect(familyHistory(rows, [])).toEqual(new Map());
  });
});

describe("rotationSummary", () => {
  const input = { queries, sortChannel: "paid", turns: new Map([["a", earlier], ["b", later]]), reached: 2, maxWindowHours: 24, historyUnavailable: false, now: new Date("2026-01-02T01:07:00Z") };

  it("reports starting history, reached queries, rounded oldest wait and the requested window", () => {
    expect(rotationSummary(input)).toEqual({
      sortChannel: "paid", queries: 5, reached: 2, neverRun: 3, oldestWaitHours: 25.1,
      oldestWaiting: { id: "a", keywordGroup: "a", location: "Test City", remoteScope: null },
      stretched: 0, maxWindowHours: 24, capped: 0, historyUnavailable: false,
    });
  });

  it("keeps unknown waits and unattempted windows null, and ignores queries outside the unit", () => {
    expect(rotationSummary({ ...input, turns: new Map([["deleted", earlier]]), reached: 0, maxWindowHours: null })).toMatchObject({
      neverRun: 5, oldestWaitHours: null, oldestWaiting: null, maxWindowHours: null,
    });
    expect(rotationSummary({ ...input, queries: [] })).toMatchObject({ queries: 0, neverRun: 0, oldestWaitHours: null, oldestWaiting: null });
  });

  it("does not call unknown history never-run, including when no channel can start", () => {
    expect(rotationSummary({ ...input, historyUnavailable: true })).toMatchObject({ neverRun: 0, oldestWaitHours: null, oldestWaiting: null, historyUnavailable: true });
    // no start channel: nothing was ordered, but the history itself was readable
    expect(rotationSummary({ ...input, sortChannel: null })).toMatchObject({ neverRun: 0, oldestWaitHours: null, oldestWaiting: null, historyUnavailable: false });
  });

  it("serializes the oldest remote query's scope and keeps config order for tied waits", () => {
    const remote: SearchQuery = { ...query("a"), location: null, remote: true, remoteScope: "home_country" };
    expect(rotationSummary({ ...input, queries: [remote, query("b")], turns: new Map([["a", earlier], ["b", earlier]]) }).oldestWaiting)
      .toEqual({ id: "a", keywordGroup: "a", location: null, remoteScope: "home_country" });
  });
});

function mulberry32(seed: number): () => number {
  return () => {
    let value = seed += 0x6d2b79f5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

describe("rotation fairness", () => {
  it.each([1, 7, 42, 99, 1234, 9001])("never lets other queries take more than N - 1 turns between repeat turns (seed %s)", (seed) => {
    const random = mulberry32(seed);
    const kinds = ["succeeded", "failed", "spent", "refused"] as const;
    for (let sample = 0; sample < 10; sample += 1) {
      const count = 1 + Math.floor(random() * 30);
      const items = Array.from({ length: count }, (_, i) => query(String(i)));
      const turns = new Map<string, Date | null>();
      const lastSequence = new Map<string, number>();
      let sequence = 0;
      for (let cycle = 0; cycle < 200; cycle += 1) {
        const ordered = orderQueries(items, turns, true);
        const capacity = Math.floor(random() * (count + 1));
        const before = sequence;
        for (const [index, q] of ordered.entries()) {
          const kind = index >= capacity ? "refused" : kinds[Math.floor(random() * kinds.length)];
          const row = { status: kind === "spent" || kind === "refused" ? "skipped" : kind, fetched: 0, usage: kind === "spent" ? 1 : 0, cost: 0 };
          const isTurn = !(row.status === "skipped" && row.fetched === 0 && row.usage === 0 && row.cost === 0);
          if (!isTurn) break;
          sequence += 1;
          const previous = lastSequence.get(q.id);
          if (previous !== undefined) expect(sequence - previous - 1).toBeLessThanOrEqual(count - 1);
          lastSequence.set(q.id, sequence);
          turns.set(q.id, new Date(cycle * 1000 + index));
        }
        if (sequence === before) expect(orderQueries(items, turns, true)).toEqual(ordered);
      }
    }
  });
});
