// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildKpiBlocks, type CycleKpiCounts } from "@/lib/dashboard/kpi";

const cycle = (cycleId: number, over: Partial<CycleKpiCounts> = {}): CycleKpiCounts => ({ cycleId, fetched: 100, passed: 40, qualified: 10, salaryStated: 8, pushed: 3, ...over });

describe("buildKpiBlocks", () => {
  it("takes the value of the last cycle, the share of what it fetched, and the change against the one before", () => {
    const blocks = buildKpiBlocks([cycle(1, { fetched: 80, passed: 30, pushed: 4 }), cycle(2, { fetched: 200, passed: 50, qualified: 12, salaryStated: 5, pushed: 1 })], 7);
    const byKey = Object.fromEntries(blocks.map((block) => [block.key, block]));
    expect(blocks.map((block) => block.key)).toEqual(["fetched", "passed", "qualified", "salary", "pushed"]);
    expect(byKey.fetched).toMatchObject({ value: 200, share: null, delta: 120, series: [80, 200] });
    expect(byKey.passed).toMatchObject({ value: 50, share: 25, delta: 20, series: [30, 50] });
    expect(byKey.qualified).toMatchObject({ value: 12, share: 6, delta: 2 });
    expect(byKey.salary).toMatchObject({ value: 5, share: 2.5, delta: -3 });
    expect(byKey.pushed).toMatchObject({ value: 1, share: 0.5, delta: -3, series: [4, 1] });
  });

  it("keeps only the last N cycles in the series", () => {
    const cycles = Array.from({ length: 10 }, (_, i) => cycle(i + 1, { passed: i + 1 }));
    const passed = buildKpiBlocks(cycles, 7).find((block) => block.key === "passed");
    expect(passed?.series).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(passed?.delta).toBe(1);
  });

  it("has no change with a single cycle, and no blocks without one", () => {
    expect(buildKpiBlocks([cycle(1)], 7).every((block) => block.delta === null)).toBe(true);
    expect(buildKpiBlocks([], 7)).toEqual([]);
  });

  it("shows unknown, not 0, when the push line is missing, and has no share when nothing was fetched", () => {
    const blocks = buildKpiBlocks([cycle(1, { qualified: null }), cycle(2, { qualified: null, fetched: 0, passed: 0 })], 7);
    const qualified = blocks.find((block) => block.key === "qualified");
    expect(qualified).toMatchObject({ value: null, share: null, delta: null, series: [null, null] });
    expect(blocks.find((block) => block.key === "passed")?.share).toBeNull();
  });

  it("a failed or half-done push makes the pushed block unknown, and it never claims postings are waiting", () => {
    const blocks = buildKpiBlocks([{ cycleId: 1, fetched: 100, passed: 40, qualified: 10, salaryStated: 8, pushed: 0, unprocessed: 12, unprocessedBlocks: { pushed: "unprocessed" } }], 7);
    const pushed = blocks.find((block) => block.key === "pushed");
    expect(pushed).toMatchObject({ value: null, pending: { reason: "unprocessed", count: null } });
    expect(blocks.find((block) => block.key === "passed")).toMatchObject({ value: 40, pending: null });
  });

  it("a block whose step failed is unknown (null, never 0) with the waiting count, and leaves a gap in its series", () => {
    const blocks = buildKpiBlocks([cycle(1), cycle(2, { passed: 0, qualified: 0, salaryStated: 0, unprocessed: 231, unprocessedBlocks: { passed: "unprocessed", qualified: "unprocessed", salary: "unprocessed" } })], 7);
    const byKey = Object.fromEntries(blocks.map((block) => [block.key, block]));
    expect(byKey.passed).toMatchObject({ value: null, share: null, delta: null, series: [40, null], pending: { reason: "unprocessed", count: 231 } });
    expect(byKey.salary?.pending).toEqual({ reason: "unprocessed", count: 231, fetched: 231 });
    expect(byKey.fetched).toMatchObject({ value: 100, pending: null });
    // pushed was not behind the failed step: a real 0 is still a 0
    expect(byKey.pushed).toMatchObject({ pending: null });
  });

  it("an unscored block has no waiting count", () => {
    const blocks = buildKpiBlocks([cycle(1, { unprocessedBlocks: { qualified: "unscored" } })], 7);
    expect(blocks.find((block) => block.key === "qualified")).toMatchObject({ value: null, pending: { reason: "unscored", count: null } });
  });
});
