// @vitest-environment node
import { describe, expect, it } from "vitest";

import { catchUpWindow, familyHistory, orderQueries, rotationSummary, turnsOf } from "@/lib/channels/rotation";
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
  const input = { queries, sortChannel: "paid", turns: new Map([["a", earlier], ["b", later]]), reached: 2, stretched: 0, capped: 0, maxWindowHours: 24, historyUnavailable: false, now: new Date("2026-01-02T01:07:00Z") };

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

describe("catchUpWindow", () => {
  const now = new Date("2026-10-18T09:30:00Z");
  const defaults = { baseHours: 10, now, maxCatchUpHours: 168, toleranceHours: 6, autoCatchUp: true };

  it("uses the base for a query without history", () => {
    expect(catchUpWindow({ ...defaults, anchor: null })).toEqual({ hours: 10, capped: false });
  });

  it.each([
    { name: "gap below base", gap: 4, hours: 10, capped: false },
    { name: "gap at base", gap: 10, hours: 10, capped: false },
    { name: "gap inside tolerance", gap: 15.5, hours: 10, capped: false },
    { name: "gap exactly at base plus tolerance", gap: 16, hours: 10, capped: false },
    { name: "gap just beyond tolerance", gap: 16.01, hours: 17, capped: false },
    { name: "fractional gap rounds up", gap: 30.2, hours: 31, capped: false },
    { name: "late cycle missed the morning cycle", gap: 24, hours: 24, capped: false },
    { name: "gap exactly at cap", gap: 168, hours: 168, capped: false },
    { name: "gap above cap", gap: 168.01, hours: 168, capped: true },
    { name: "clock moved back", gap: -12, hours: 10, capped: false },
  ])("$name", ({ gap, hours, capped }) => {
    expect(catchUpWindow({ ...defaults, anchor: new Date(now.getTime() - gap * 3_600_000) })).toEqual({ hours, capped });
  });

  it("keeps a 24-hour weekend window from Saturday 09:00 to Sunday 09:30", () => {
    expect(catchUpWindow({ ...defaults, baseHours: 24, anchor: new Date("2026-10-17T09:00:00Z") }))
      .toEqual({ hours: 24, capped: false });
  });

  it.each([
    { name: "zero cap disables catch-up", maxCatchUpHours: 0, autoCatchUp: true, capped: false },
    { name: "cap below base never shrinks the window", maxCatchUpHours: 5, autoCatchUp: true, capped: true },
    { name: "channel opts out even beyond the cap", maxCatchUpHours: 20, autoCatchUp: false, capped: false },
  ])("$name", ({ maxCatchUpHours, autoCatchUp, capped }) => {
    expect(catchUpWindow({ ...defaults, anchor: new Date(now.getTime() - 48 * 3_600_000), maxCatchUpHours, autoCatchUp }))
      .toEqual({ hours: 10, capped });
  });

  it("does not report a cap unless it took the extension branch", () => {
    expect(catchUpWindow({ ...defaults, anchor: new Date(now.getTime() - 12 * 3_600_000), maxCatchUpHours: 5 }))
      .toEqual({ hours: 10, capped: false });
  });

  it("extends immediately beyond base when tolerance is zero", () => {
    expect(catchUpWindow({ ...defaults, anchor: new Date(now.getTime() - 10.1 * 3_600_000), toleranceHours: 0 }))
      .toEqual({ hours: 11, capped: false });
  });
});

it.each([false, true])("reports supplied distinct stretched and capped counts with unavailable history = %s", (historyUnavailable) => {
  expect(rotationSummary({
    queries, sortChannel: "paid", turns: new Map(), reached: 3, stretched: 2, capped: 1,
    maxWindowHours: 168, historyUnavailable, now: later,
  })).toMatchObject({ stretched: 2, capped: 1, maxWindowHours: 168 });
});

it("breaks tied round timestamps by config order, allowing more than N - 1 other turns between repeats", () => {
  const items = ["a", "b", "c"].map(query);
  const turns = new Map<string, Date | null>();
  const rounds: string[][] = [];
  for (const [round, capacity] of [1, 3, 1, 1].entries()) {
    const served = orderQueries(items, turns, true).slice(0, capacity);
    rounds.push(ids(served));
    // All turns in this round share one timestamp, including the second round's full sweep.
    const at = new Date(earlier.getTime() + round * 3_600_000);
    for (const q of served) turns.set(q.id, at);
  }
  expect(rounds).toEqual([["a"], ["b", "c", "a"], ["a"], ["b"]]);
  const sequence = rounds.flat();
  const otherTurns = sequence.lastIndexOf("b") - sequence.indexOf("b") - 1;
  expect(otherTurns).toBe(3);
  expect(otherTurns).toBeGreaterThan(items.length - 1);
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
