// @vitest-environment node
import { describe, expect, it } from "vitest";

import { BudgetTracker, monthKey } from "@/lib/channels/budget";
import { BudgetExceededError } from "@/lib/channels/errors";
import { createMemoryStateStore } from "@/lib/channels/store";
import type { Channel, ChannelRuntimeSettings } from "@/lib/channels/types";

const MONTH = "2026-10";

function settings(overrides: Partial<ChannelRuntimeSettings> = {}): ChannelRuntimeSettings {
  return {
    enabled: true,
    maxResults: 100,
    monthlyBudgetUsd: 0,
    freeRecordsPerMonth: 0,
    throttle: { minDelayMs: 0, maxDelayMs: 0 },
    extra: {},
    ...overrides,
  };
}

function channel(id: string, unitUsd?: number): Channel {
  return {
    id,
    family: "linkedin",
    kind: "paid",
    usesQueries: true,
    async collect() {
      return [];
    },
    parse() {
      throw new Error("not used");
    },
    ...(unitUsd === undefined ? {} : { estimateCost: (n: number) => n * unitUsd }),
  };
}

async function tracker(
  configs: Record<string, ChannelRuntimeSettings>,
  options: { globalCap?: number; seed?: Record<string, { records: number; usd: number }> } = {},
) {
  const store = createMemoryStateStore();
  for (const [id, usage] of Object.entries(options.seed ?? {})) await store.addUsage(id, MONTH, usage);
  const budget = await BudgetTracker.create({
    store,
    month: MONTH,
    globalCapUsd: options.globalCap ?? 15,
    settingsFor: (id) => configs[id],
  });
  return { budget, store };
}

describe("free allowance", () => {
  const bright = channel("bright", 0.0015);
  const configs = { bright: settings({ monthlyBudgetUsd: 5, freeRecordsPerMonth: 5000 }) };

  it("charges nothing inside the free allowance", async () => {
    const { budget } = await tracker(configs);
    const handle = budget.forChannel(bright);
    expect(await handle.consume(4000)).toEqual({ usd: 0, freeRecords: 4000, paidRecords: 0 });
    expect(handle.snapshot()).toMatchObject({ records: 4000, usd: 0, freeRecordsLeft: 1000 });
  });

  it("charges only the records beyond the allowance", async () => {
    const { budget, store } = await tracker(configs, { seed: { bright: { records: 4000, usd: 0 } } });
    const handle = budget.forChannel(bright);
    const result = await handle.consume(2000);
    expect(result).toEqual({ usd: 1.5, freeRecords: 1000, paidRecords: 1000 });
    expect(handle.attempt).toEqual({ records: 2000, usd: 1.5 });
    expect((await store.loadUsage(MONTH)).get("bright")).toEqual({ records: 6000, usd: 1.5 });
  });

  it("accepts an explicit actual cost instead of the estimate", async () => {
    const { budget } = await tracker(configs, { seed: { bright: { records: 5000, usd: 0 } } });
    expect((await budget.forChannel(bright).consume(100, { costUsd: 0.4 })).usd).toBe(0.4);
  });
});

describe("channel budget", () => {
  const ch = channel("apify", 0.01);
  const configs = { apify: settings({ monthlyBudgetUsd: 1 }) };

  it("throws BudgetExceededError and records nothing when the budget would be exceeded", async () => {
    const { budget, store } = await tracker(configs);
    const handle = budget.forChannel(ch);
    await handle.consume(80); // $0.80
    await expect(handle.consume(30)).rejects.toMatchObject({ code: "budget_exceeded", scope: "channel" });
    await expect(handle.consume(30)).rejects.toBeInstanceOf(BudgetExceededError);
    expect((await store.loadUsage(MONTH)).get("apify")).toEqual({ records: 80, usd: 0.8 });
    // what still fits is allowed
    await expect(handle.consume(20)).resolves.toMatchObject({ usd: 0.2 });
  });

  it("canAfford and snapshot reflect what is left", async () => {
    const { budget } = await tracker(configs, { seed: { apify: { records: 90, usd: 0.9 } } });
    const handle = budget.forChannel(ch);
    expect(handle.canAfford(10)).toBe(true);
    expect(handle.canAfford(11)).toBe(false);
    expect(handle.snapshot()).toMatchObject({ month: MONTH, usd: 0.9, usdLeft: 0.1 });
  });

  it("a zero-budget channel cannot spend, but free usage is fine", async () => {
    const { budget } = await tracker({ guest: settings({ monthlyBudgetUsd: 0 }) });
    await expect(budget.forChannel(channel("guest", 0.01)).consume(1)).rejects.toMatchObject({ code: "budget_exceeded" });
    const free = budget.forChannel(channel("guest"));
    await expect(free.consume(500)).resolves.toMatchObject({ usd: 0 });
  });

  it("rejects negative or fractional record counts", async () => {
    const { budget } = await tracker(configs);
    await expect(budget.forChannel(ch).consume(-1)).rejects.toBeInstanceOf(RangeError);
    await expect(budget.forChannel(ch).consume(1.5)).rejects.toBeInstanceOf(RangeError);
  });
});

describe("global paid cap", () => {
  const a = channel("a", 1);
  const b = channel("b", 1);
  const configs = { a: settings({ monthlyBudgetUsd: 10 }), b: settings({ monthlyBudgetUsd: 10 }) };

  it("counts spend of all channels against paid_total_monthly_budget_usd", async () => {
    const { budget } = await tracker(configs, { globalCap: 15 });
    await budget.forChannel(a).consume(10);
    expect(budget.globalUsd()).toBe(10);
    await expect(budget.forChannel(b).consume(6)).rejects.toMatchObject({ code: "budget_exceeded", scope: "global" });
    await expect(budget.forChannel(b).consume(5)).resolves.toMatchObject({ usd: 5 });
    expect(budget.globalUsd()).toBe(15);
  });

  it("makes every paid channel unavailable once the cap is reached, free ones stay available", async () => {
    const { budget } = await tracker(
      { ...configs, guest: settings() },
      { globalCap: 15, seed: { a: { records: 10, usd: 10 }, b: { records: 5, usd: 5 } } },
    );
    expect(budget.hasHeadroom(a)).toBe(false);
    expect(budget.hasHeadroom(b)).toBe(false);
    expect(budget.hasHeadroom(channel("guest"))).toBe(true);
    expect(budget.forChannel(b).snapshot().usdLeft).toBe(0);
  });

  it("includes spend of channels that are no longer registered", async () => {
    const { budget } = await tracker(configs, { globalCap: 15, seed: { gone: { records: 1, usd: 14 } } });
    expect(budget.globalUsd()).toBe(14);
    await expect(budget.forChannel(a).consume(2)).rejects.toMatchObject({ scope: "global" });
  });
});

describe("hasHeadroom", () => {
  it.each([
    { name: "below one record", cap: 0.001, unit: 0.0015, expected: false },
    { name: "exactly one record", cap: 0.0015, unit: 0.0015, expected: true },
    { name: "micro-dollar rounding up", cap: 0.0014996, unit: 0.0015, expected: true },
    { name: "micro-dollar rounding down", cap: 0.0014994, unit: 0.0015, expected: false },
    { name: "within money tolerance", cap: 0.0015, unit: 0.0015000005, expected: true },
    { name: "outside money tolerance", cap: 0.0015, unit: 0.001500002, expected: false },
  ])("preserves $name at either budget limit", async ({ cap, unit, expected }) => {
    for (const scope of ["channel", "global"] as const) {
      const { budget, store } = await tracker(
        { bright: settings({ monthlyBudgetUsd: scope === "channel" ? cap : 1, freeRecordsPerMonth: 10 }) },
        { globalCap: scope === "global" ? cap : 1, seed: { bright: { records: 10, usd: 0 } } },
      );
      expect(budget.hasHeadroom(channel("bright", unit))).toBe(expected);
      expect((await store.loadUsage(MONTH)).get("bright")).toEqual({ records: 10, usd: 0 });
    }
  });

  it("is true while free records remain even with an empty budget", async () => {
    const bright = channel("bright", 0.0015);
    const { budget } = await tracker(
      { bright: settings({ monthlyBudgetUsd: 0, freeRecordsPerMonth: 10 }) },
      { seed: { bright: { records: 9, usd: 0 } } },
    );
    expect(budget.hasHeadroom(bright)).toBe(true);
  });

  it("is false once free records and budget are both used up", async () => {
    const bright = channel("bright", 0.0015);
    const { budget } = await tracker(
      { bright: settings({ monthlyBudgetUsd: 5, freeRecordsPerMonth: 5000 }) },
      { seed: { bright: { records: 5000 + 3334, usd: 5.001 } } },
    );
    expect(budget.hasHeadroom(bright)).toBe(false);
  });

  it("treats a channel with a zero price as free", async () => {
    const { budget } = await tracker({ x: settings() });
    expect(budget.hasHeadroom(channel("x"))).toBe(true);
    expect(budget.hasHeadroom(channel("x", 0))).toBe(true);
  });
});

describe("monthKey", () => {
  it("uses the calendar month of the given time zone", () => {
    expect(monthKey(new Date("2026-09-30T23:30:00Z"), "Europe/Berlin")).toBe("2026-10");
    expect(monthKey(new Date("2026-09-30T23:30:00Z"), "UTC")).toBe("2026-09");
    expect(monthKey(new Date("2026-12-31T23:30:00Z"), "Europe/Berlin")).toBe("2027-01");
  });
});

describe("overspend of usage that is already billed", () => {
  it("records it in full, leaves no headroom, and only plain consume refuses", async () => {
    const bright = channel("bright", 1);
    const { budget, store } = await tracker({ bright: settings({ monthlyBudgetUsd: 2, freeRecordsPerMonth: 1 }) });
    const handle = budget.forChannel(bright);
    await expect(handle.consume(10)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(handle.snapshot()).toMatchObject({ records: 0, usd: 0 });

    await expect(handle.consume(10, { allowOverspend: true })).resolves.toEqual({ usd: 9, freeRecords: 1, paidRecords: 9 });
    expect(handle.snapshot()).toMatchObject({ records: 10, usd: 9, freeRecordsLeft: 0, usdLeft: 0 });
    expect(budget.hasHeadroom(bright)).toBe(false);
    expect((await store.loadUsage(MONTH)).get("bright")).toEqual({ records: 10, usd: 9 });
  });
});
