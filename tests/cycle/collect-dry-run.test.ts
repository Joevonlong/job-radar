// @vitest-environment node
import { describe, expect, it } from "vitest";

import { registerFixtureChannel } from "@/lib/channels/fixture";
import { ChannelRegistry } from "@/lib/channels/registry";
import { buildQueries } from "@/lib/channels/query";
import type { CascadeSpec } from "@/lib/channels/cascade";
import { runCycle } from "@/lib/cycle/run-cycle";
import { mapWithConcurrency } from "@/lib/cycle/collect";

import { channelsWith } from "../channels/helpers";
import { collectOf, config, probeChannel, quietLogger, settings, type SharedProbe } from "./helpers";

const cascade = (...order: string[]): CascadeSpec[] => [{ family: "linkedin", order }];

function run(registry: ChannelRegistry, extra: Partial<Parameters<typeof runCycle>[1]> = {}) {
  return runCycle("manual", { dryRun: true, registry, config: config(), logger: quietLogger, sleep: async () => {}, ...extra });
}

describe("dry run", () => {
  it("collects and parses in memory, reports counts and the first three titles, and skips later steps", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "fixture" });
    const result = await run(registry, { channelIds: ["fixture"] });
    const collect = collectOf(result);
    expect(result.cycleId).toBeNull();
    expect(result.status).toBe("succeeded");
    expect(collect.queries).toBe(9);
    expect(collect.queryPlan).toHaveLength(9);
    expect(collect.queryPlan?.[0]).toMatchObject({ keywordGroup: "engineering", location: "Berlin", remoteScope: null, windowHours: 24 });
    expect(collect.queryPlan?.filter((q) => q.remoteScope === "home_country")).toHaveLength(3);
    const report = collect.dryRun?.fixture;
    expect(report).toMatchObject({ fetched: 45, parsed: 45, parseFailed: 0 });
    expect(report?.sampleTitles).toEqual(["Applied AI Engineer", "Forward Deployed Engineer", "KI-Entwickler (m/w/d)"]);
    expect(collect.channels.fixture).toMatchObject({ runs: 9, succeeded: 9, failed: 0, inserted: 0 });
    expect(collect.served.map((entry) => entry.queryId)).toEqual(buildQueries(config().search, "manual").map((query) => query.id));
    expect(collect.rotation.fixture).toEqual({
      sortChannel: "fixture", queries: 9, reached: 9, neverRun: 0, oldestWaitHours: null, oldestWaiting: null,
      stretched: 0, maxWindowHours: 24, capped: 0, historyUnavailable: true,
    });
    expect(result.summary.steps.map((s) => [s.name, s.status])).toEqual([
      ["collect", "ok"],
      ["pipeline", "skipped"],
      ["filter", "skipped"],
      ["signals", "skipped"],
      ["ai", "skipped"],
      ["notify", "skipped"],
      ["maintenance", "skipped"],
    ]);
  });

  it("only runs the selected channels", async () => {
    const registry = new ChannelRegistry();
    const a = registerFixtureChannel(registry, { id: "arbeitsagentur" });
    const b = registerFixtureChannel(registry, { id: "indeed" });
    await run(registry, { channelIds: ["indeed"] });
    expect(a.seen).toHaveLength(0);
    expect(b.seen.length).toBeGreaterThan(0);
  });

  it("does not run disabled channels", async () => {
    const registry = new ChannelRegistry();
    const probe = probeChannel("jsearch"); // disabled in sources.yaml
    registry.register(probe);
    const result = await run(registry);
    expect(probe.calls).toHaveLength(0);
    expect(collectOf(result).channels).toEqual({});
  });
});

describe("queries", () => {
  it("runs a channel's queries one after another with its throttle in between", async () => {
    const registry = new ChannelRegistry();
    const probe = probeChannel("a", { waitMs: 2 });
    registry.register(probe, { settings: settings({ throttle: { minDelayMs: 50, maxDelayMs: 50 } }) });
    const sleeps: number[] = [];
    await run(registry, { sleep: async (ms) => void sleeps.push(ms) });
    expect(probe.calls).toHaveLength(9); // the probe throws if two overlap
    expect(sleeps).toEqual(Array(8).fill(50)); // between queries, not before the first
  });

  it("caps each query at the channel's max_results", async () => {
    const registry = new ChannelRegistry();
    const probe = probeChannel("a");
    registry.register(probe, { settings: settings({ maxResults: 7 }) });
    await run(registry);
    expect(new Set(probe.calls.map((c) => c.maxResults))).toEqual(new Set([7]));
    const roomy = new ChannelRegistry();
    const probe2 = probeChannel("b");
    roomy.register(probe2, { settings: settings({ maxResults: 500 }) });
    await run(roomy);
    expect(new Set(probe2.calls.map((c) => c.maxResults))).toEqual(new Set([config().search.max_per_group_per_location]));
  });

  it("gives channels that ignore keywords a single sweep query", async () => {
    const registry = new ChannelRegistry();
    const ats = probeChannel("greenhouse", { usesQueries: false });
    registry.register(ats, { settings: settings({ maxResults: 500 }) });
    const result = await run(registry);
    expect(ats.calls).toHaveLength(1);
    expect(ats.calls[0]?.maxResults).toBe(500);
    expect(collectOf(result).queries).toBe(1);
  });
});

describe("parallelism and isolation (C2)", () => {
  it("runs channels in parallel up to collect.concurrency", async () => {
    const shared: SharedProbe = { current: 0, max: 0 };
    const registry = new ChannelRegistry();
    for (const id of ["a", "b", "c", "d"]) {
      registry.register(probeChannel(id, { shared, waitMs: 15, usesQueries: false }), { settings: settings() });
    }
    await run(registry, { config: config({ concurrency: 2 }) });
    expect(shared.max).toBe(2);

    const wide: SharedProbe = { current: 0, max: 0 };
    const registry2 = new ChannelRegistry();
    for (const id of ["a", "b", "c", "d"]) {
      registry2.register(probeChannel(id, { shared: wide, waitMs: 15, usesQueries: false }), { settings: settings() });
    }
    await run(registry2, { config: config({ concurrency: 4 }) });
    expect(wide.max).toBe(4);
  });

  it("mapWithConcurrency never exceeds the limit and visits every item", async () => {
    let current = 0;
    let max = 0;
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      current += 1;
      max = Math.max(max, current);
      await new Promise((resolve) => setTimeout(resolve, 3));
      seen.push(n);
      current -= 1;
    });
    expect(max).toBe(3);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("one failing channel does not stop the others", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "arbeitsagentur", failure: { code: "blocked" } });
    registerFixtureChannel(registry, { id: "indeed" });
    registry.register(probeChannel("greenhouse", { usesQueries: false, throws: new TypeError("bug in channel") }), { settings: settings() });
    const result = await run(registry);
    const collect = collectOf(result);
    expect(result.status).toBe("partial");
    expect(collect.channels.indeed).toMatchObject({ succeeded: 9, failed: 0 });
    expect(collect.channels.arbeitsagentur?.errorCodes).toEqual({ blocked: 1 });
    expect(collect.channels.greenhouse?.errorCodes).toEqual({ unknown: 1 });
    expect(collect.unusable).toEqual({ arbeitsagentur: "blocked", greenhouse: "unknown" });
  });

  it("is failed when no channel succeeds", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "indeed", failure: { code: "auth_expired" } });
    expect((await run(registry)).status).toBe("failed");
  });

  it("is succeeded (and says so) when nothing is enabled", async () => {
    const result = await run(new ChannelRegistry());
    expect(result.status).toBe("succeeded");
    expect(collectOf(result).queries).toBe(0);
  });

  it("flags records with an invalid shape instead of dropping the whole run", async () => {
    const registry = new ChannelRegistry();
    registry.register(
      probeChannel("indeed", {
        usesQueries: false,
        records: () => [
          { externalId: "ok", url: null, payload: { a: 1 } },
          { externalId: " ", url: null, payload: { a: 2 } },
          { externalId: "bad-payload", url: null, payload: undefined },
        ],
      }),
      { settings: settings() },
    );
    const result = await run(registry);
    expect(collectOf(result).channels.indeed).toMatchObject({ succeeded: 1, fetched: 3, errorCodes: { parse: 2 } });
  });
});

describe("cascade inside a cycle", () => {
  const family = { family: "linkedin" as const };

  it("uses the second channel when the first is over budget and the third when the second's circuit opens", async () => {
    const registry = new ChannelRegistry();
    // 1st: paid with no budget left; 2nd: rate limited until its circuit opens; 3rd: healthy
    const first = registerFixtureChannel(registry, { id: "fx-1", ...family, costPerRecordUsd: 1, settings: { monthlyBudgetUsd: 0 } });
    const second = registerFixtureChannel(registry, { id: "fx-2", ...family, failure: { code: "rate_limited" } });
    const third = registerFixtureChannel(registry, { id: "fx-3", ...family });
    const result = await run(registry, { cascades: cascade("fx-1", "fx-2", "fx-3") });
    const collect = collectOf(result);
    expect(first.seen).toHaveLength(0);
    // breaker threshold is 3: queries 1-3 fail on fx-2 (retryable errors fail the query), the rest go to fx-3
    expect(second.seen).toHaveLength(3);
    expect(third.seen).toHaveLength(6);
    expect(collect.served.map((s) => [s.channelId, s.status])).toEqual([
      ["fx-2", "failed"],
      ["fx-2", "failed"],
      ["fx-2", "failed"],
      ...Array(6).fill(["fx-3", "served"]),
    ]);
    expect(result.status).toBe("partial");
  });

  it("falls to the next channel in the same query when one is blocked, and stops using it for the cycle", async () => {
    const registry = new ChannelRegistry();
    const first = registerFixtureChannel(registry, { id: "fx-1", ...family, failure: { code: "blocked" } });
    const second = registerFixtureChannel(registry, { id: "fx-2", ...family });
    const result = await run(registry, { cascades: cascade("fx-1", "fx-2") });
    const collect = collectOf(result);
    expect(first.seen).toHaveLength(1);
    expect(second.seen).toHaveLength(9);
    expect(collect.served.every((s) => s.channelId === "fx-2" && s.status === "served")).toBe(true);
    expect(collect.unusable).toEqual({ "fx-1": "blocked" });
    expect(collect.channels["fx-1"]).toMatchObject({ failed: 1, errorCodes: { blocked: 1 } });
  });

  it("marks the run skipped with a reason when no channel of the cascade is available", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "fx-1", ...family, costPerRecordUsd: 1, settings: { monthlyBudgetUsd: 0 } });
    registerFixtureChannel(registry, { id: "fx-2", ...family, settings: { enabled: false } });
    const result = await run(registry, { cascades: cascade("fx-1", "fx-2", "fx-gone") });
    const collect = collectOf(result);
    expect(collect.served).toEqual([expect.objectContaining({ channelId: null, status: "skipped" })]);
    expect(collect.channels["fx-1"]).toMatchObject({ skipped: 1, runs: 1, succeeded: 0 });
    expect(collect.rotation.linkedin).toMatchObject({ sortChannel: null, reached: 0, maxWindowHours: null, historyUnavailable: true });
    expect(result.status).toBe("failed");
  });

  it("restricts a cascade to the selected channels", async () => {
    const registry = new ChannelRegistry();
    const first = registerFixtureChannel(registry, { id: "fx-1", ...family });
    const second = registerFixtureChannel(registry, { id: "fx-2", ...family });
    await run(registry, { cascades: cascade("fx-1", "fx-2"), channelIds: ["fx-2"] });
    expect(first.seen).toHaveLength(0);
    expect(second.seen).toHaveLength(9);
  });

  it("uses only one channel of the cascade per query, never two", async () => {
    const registry = new ChannelRegistry();
    const first = registerFixtureChannel(registry, { id: "fx-1", ...family });
    const second = registerFixtureChannel(registry, { id: "fx-2", ...family });
    await run(registry, { cascades: cascade("fx-1", "fx-2") });
    expect(first.seen).toHaveLength(9);
    expect(second.seen).toHaveLength(0);
  });
});

describe("budget through the cycle", () => {
  it("lets a paid fixture channel spend up to its budget and then falls through", async () => {
    const registry = new ChannelRegistry();
    // 5 postings per query at $1 each; budget $12 => two queries fit ($10), the third would reach $15
    const paid = registerFixtureChannel(registry, { id: "fx-paid", family: "linkedin", costPerRecordUsd: 1, settings: { monthlyBudgetUsd: 12 } });
    const free = registerFixtureChannel(registry, { id: "fx-free", family: "linkedin" });
    const result = await run(registry, { cascades: cascade("fx-paid", "fx-free") });
    const collect = collectOf(result);
    expect(paid.seen).toHaveLength(3); // third attempt throws budget_exceeded
    expect(collect.channels["fx-paid"]).toMatchObject({ succeeded: 2, skipped: 1, costUsd: 10 });
    expect(free.seen).toHaveLength(7); // the over-budget query and all later ones
    expect(collect.unusable).toEqual({ "fx-paid": "budget_exceeded" });
  });

  it("honours the global paid cap across channels", async () => {
    const registry = new ChannelRegistry();
    const a = registerFixtureChannel(registry, { id: "indeed", costPerRecordUsd: 1, settings: { monthlyBudgetUsd: 50 } });
    const channels = channelsWith((raw) => {
      raw.paid_total_monthly_budget_usd = 7;
      (raw.linkedin as { apify: { monthly_budget_usd: number } }).apify.monthly_budget_usd = 5;
    });
    const result = await run(registry, { config: { ...config(), channels } });
    const collect = collectOf(result);
    expect(collect.channels.indeed).toMatchObject({ succeeded: 1, costUsd: 5 });
    expect(a.seen).toHaveLength(2);
    expect(collect.unusable).toEqual({ indeed: "budget_exceeded" });
  });
});

describe("cancellation", () => {
  it("stops between queries when the signal aborts and skips the remaining steps", async () => {
    const controller = new AbortController();
    const registry = new ChannelRegistry();
    const probe = probeChannel("indeed");
    const original = probe.collect.bind(probe);
    probe.collect = async (query, ctx) => {
      const records = await original(query, ctx);
      if (probe.calls.length === 2) controller.abort();
      return records;
    };
    registry.register(probe, { settings: settings() });
    const result = await run(registry, { signal: controller.signal });
    expect(probe.calls).toHaveLength(2);
    expect(result.status).toBe("failed");
    expect(result.summary.aborted).toBe(true);
    expect(collectOf(result).aborted).toBe(true);
    expect(result.summary.steps.filter((s) => s.status === "skipped")).toHaveLength(6);
  });
});
