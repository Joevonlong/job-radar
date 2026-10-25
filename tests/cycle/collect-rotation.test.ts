// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BudgetTracker } from "@/lib/channels/budget";
import { CircuitBreaker } from "@/lib/channels/circuit";
import { NO_KNOWN_POSTINGS } from "@/lib/channels/context";
import { ChannelError } from "@/lib/channels/errors";
import { registerFixtureChannel } from "@/lib/channels/fixture";
import { createLogger, type LogRecord } from "@/lib/channels/logger";
import { buildQueries } from "@/lib/channels/query";
import { ChannelRegistry } from "@/lib/channels/registry";
import { createMemoryStateStore } from "@/lib/channels/store";
import { collectStep, type CollectResult } from "@/lib/cycle/collect";
import type { CycleStepContext } from "@/lib/cycle/steps";
import type { Db } from "@/lib/db/client";
import * as runs from "@/lib/db/repos/runs";

import { config, pinnedSearch } from "./helpers";

const now = new Date("2026-01-03T00:00:00Z");
const old = new Date("2026-01-01T00:00:00Z");
const db = new Proxy({} as Db, {
  get(target, key, receiver) {
    if (["select", "insert", "update", "delete", "execute", "transaction"].includes(String(key))) throw new Error("unexpected SQL");
    return Reflect.get(target, key, receiver);
  },
});

beforeEach(() => {
  vi.spyOn(runs, "getQueryRunHistory").mockResolvedValue([]);
  vi.spyOn(runs, "createRun").mockImplementation(async (_db, input) => ({
    id: 1, cycleId: input.cycleId ?? null, channelId: input.channelId, queryHash: input.queryHash ?? null,
    startedAt: now, finishedAt: null, status: "running", fetched: 0, newCount: 0, cost: 0,
    error: null, errorCode: null, interrupted: false, usageUnits: 0,
    windowHours: input.windowHours ?? null, windowExtended: input.windowExtended ?? false,
  }));
  vi.spyOn(runs, "finishRun").mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

async function setup() {
  const cfg = config({ search: { ...pinnedSearch(), keyword_groups: { a: ["alpha"], b: ["beta"], c: ["gamma"] }, locations: ["Test City"], remote_scope: "none" } });
  const registry = new ChannelRegistry();
  const first = registerFixtureChannel(registry, { id: "first", family: "linkedin", postings: [] });
  const second = registerFixtureChannel(registry, { id: "second", family: "linkedin", postings: [] });
  const other = registerFixtureChannel(registry, { id: "other", postings: [] });
  const store = createMemoryStateStore();
  const logs: LogRecord[] = [];
  const context: CycleStepContext = {
    cycle: { id: 1, kind: "manual" }, windowKind: null, dryRun: false, db, signal: new AbortController().signal,
    logger: createLogger({ sink: (record) => logs.push(record) }), now: () => now, config: cfg, results: {},
    channels: {
      registry, store, known: () => NO_KNOWN_POSTINGS, selected: null, cascades: [{ family: "linkedin", order: ["first", "second"] }],
      breaker: new CircuitBreaker(store, () => ({ failures: 3, cooldownMs: 60_000 }), () => now),
      budget: await BudgetTracker.create({ store, month: "2026-01", globalCapUsd: 100, settingsFor: (id) => registry.settingsFor(id, cfg.channels) }),
      runtime: { sleep: async () => {} },
    },
  };
  const queries = buildQueries(cfg.search, "manual");
  return { context, first, second, other, queries, logs, run: async () => (await collectStep(context)).result as CollectResult };
}

describe("collect rotation wiring", () => {
  it("never reads history or writes runs in a dry run and logs the config-order reason", async () => {
    const test = await setup();
    test.context.dryRun = true;
    test.context.db = null;
    const result = await test.run();
    expect(runs.getQueryRunHistory).not.toHaveBeenCalled();
    expect(runs.createRun).not.toHaveBeenCalled();
    expect(runs.finishRun).not.toHaveBeenCalled();
    expect(test.first.seen.map((q) => q.id)).toEqual(test.queries.map((q) => q.id));
    expect(result.rotation.linkedin?.historyUnavailable).toBe(true);
    const logs = test.logs.filter((log) => log.message === "query rotation");
    expect(logs).toHaveLength(2);
    expect(logs.every((log) => log.fields.reason === "dry_run")).toBe(true);
  });

  it("reads history once for the full families and orders only by the selected starting channel", async () => {
    const test = await setup();
    const firstQuery = test.queries[0]!;
    test.context.channels.selected = ["second", "other"];
    vi.mocked(runs.getQueryRunHistory).mockResolvedValue([
      { channelId: "second", queryHash: firstQuery.id, lastTurnAt: old, lastCoveredAt: old, firstSeenAt: old },
      { channelId: "first", queryHash: test.queries[1]!.id, lastTurnAt: now, lastCoveredAt: now, firstSeenAt: now },
    ]);
    const result = await test.run();
    expect(runs.getQueryRunHistory).toHaveBeenCalledExactlyOnceWith(db, { channelIds: ["first", "second", "other"], queryHashes: test.queries.map((q) => q.id) });
    expect(test.first.seen).toEqual([]);
    expect(test.second.seen.map((q) => q.id)).toEqual([...test.queries.slice(1), firstQuery].map((q) => q.id));
    expect(test.other.seen.map((q) => q.id)).toEqual(test.queries.map((q) => q.id));
    expect(result.rotation.linkedin).toMatchObject({ sortChannel: "second", reached: 3, neverRun: 2, oldestWaitHours: 48, maxWindowHours: 24, historyUnavailable: false });
    expect(test.logs.filter((log) => log.message === "query rotation")).toHaveLength(2);
    expect(runs.createRun).toHaveBeenCalledWith(db, expect.objectContaining({ windowHours: 24, windowExtended: false }));
    expect(runs.finishRun).toHaveBeenCalledWith(db, 1, expect.objectContaining({ status: "succeeded", usageUnits: 0, cost: 0 }));
  });

  it("warns once on a history read failure, then serves all units in config order", async () => {
    const test = await setup();
    vi.mocked(runs.getQueryRunHistory).mockRejectedValue(new Error("history unavailable"));
    const result = await test.run();
    for (const probe of [test.first, test.other]) expect(probe.seen.map((q) => q.id)).toEqual(test.queries.map((q) => q.id));
    expect(test.logs.filter((log) => log.level === "warn")).toHaveLength(1);
    for (const summary of Object.values(result.rotation)) expect(summary).toMatchObject({ historyUnavailable: true, neverRun: 0, oldestWaitHours: null, reached: 3 });
    const logs = test.logs.filter((log) => log.message === "query rotation");
    expect(logs).toHaveLength(2);
    expect(logs.every((log) => log.fields.reason === "read_failed")).toBe(true);
  });

  it("keeps config order when rotation is disabled, while still reporting known history", async () => {
    const test = await setup();
    test.context.config.channels.collect.query_rotation = false;
    vi.mocked(runs.getQueryRunHistory).mockResolvedValue([{ channelId: "first", queryHash: test.queries[0]!.id, lastTurnAt: old, lastCoveredAt: old, firstSeenAt: old }]);
    const result = await test.run();
    expect(test.first.seen.map((q) => q.id)).toEqual(test.queries.map((q) => q.id));
    expect(result.rotation.linkedin).toMatchObject({ neverRun: 2, oldestWaitHours: 48, historyUnavailable: false });
  });

  it("reports the skipped unit without a requested window when no channel can start", async () => {
    const test = await setup();
    test.context.channels.selected = ["first"];
    test.context.channels.registry.get("first")!.isConfigured = () => false;
    const result = await test.run();
    expect(result.rotation.linkedin).toMatchObject({ sortChannel: null, reached: 0, maxWindowHours: null, historyUnavailable: false });
    expect(runs.createRun).toHaveBeenCalledExactlyOnceWith(db, { channelId: "first", cycleId: 1, queryHash: test.queries[0]!.id });
    expect(test.logs.filter((log) => log.message === "query rotation")).toHaveLength(1);
  });

  it("records quota spent on a budget stop even when it returned no postings", async () => {
    const test = await setup();
    test.context.channels.selected = ["first"];
    test.context.channels.registry.get("first")!.collect = async (_query, ctx) => {
      await ctx.budget.consume(1);
      throw new ChannelError("budget_exceeded", "quota exhausted");
    };
    const result = await test.run();
    expect(runs.finishRun).toHaveBeenCalledWith(db, 1, expect.objectContaining({ status: "skipped", usageUnits: 1, cost: 0 }));
    expect(result.rotation.linkedin).toMatchObject({ reached: 0, maxWindowHours: 24 });
  });
});
