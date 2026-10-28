import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

import type { CascadeSpec } from "@/lib/channels/cascade";
import { registerFixtureChannel, type FixturePosting } from "@/lib/channels/fixture";
import { ChannelRegistry } from "@/lib/channels/registry";
import type { ChannelsConfig } from "@/lib/config";
import { isCycleWaitingForLock } from "@/lib/cycle/lock-waiters";
import { runCycle, type RunCycleOptions } from "@/lib/cycle/run-cycle";
import { registerCycleStep, resetCycleSteps } from "@/lib/cycle/steps";
import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import {
  countRunningCycles,
  failOrphanedCycles,
  getChannelRows,
  getCycle,
  getLatestRunStartedAt,
  getMonthUsage,
  hashPayload,
  listRawPostingsForChannel,
  listRunsForCycle,
  setRawParseStatus,
  upsertRawPostings,
} from "@/lib/db";

import { channelsWith, shippedChannels } from "../channels/helpers";
import { probeChannel, quietLogger, config, settings } from "../cycle/helpers";

const url = inject("testDatabaseUrl");

const posting = (id: string, extra: Partial<FixturePosting> = {}): FixturePosting => ({
  id,
  title: `Job ${id}`,
  company: "Acme GmbH",
  city: "Berlin",
  country: "DE",
  remote: false,
  description: "Build things",
  url: `https://jobs.example.test/${id}`,
  posted_at: "2026-10-06T08:00:00Z",
  ...extra,
});

const cascade = (...order: string[]): CascadeSpec[] => [{ family: "linkedin", order }];

function run(registry: ChannelRegistry, options: RunCycleOptions = {}) {
  return runCycle("manual", { registry, config: config(), logger: quietLogger, sleep: async () => {}, ...options });
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table raw_postings, runs, cycles, channels restart identity cascade`);
});

afterEach(() => {
  resetCycleSteps();
});

afterAll(async () => {
  await closeDb();
});

describe("migration 0001", () => {
  it("adds the circuit, hash and error-code columns", async () => {
    const rows = await getDb().execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and (
        (table_name = 'channels' and column_name in ('consecutive_failures', 'circuit_open_until', 'last_error_code', 'last_success_at'))
        or (table_name = 'raw_postings' and column_name = 'payload_hash')
        or (table_name = 'runs' and column_name = 'error_code'))
      order by table_name, column_name`);
    expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      "channels.circuit_open_until",
      "channels.consecutive_failures",
      "channels.last_error_code",
      "channels.last_success_at",
      "raw_postings.payload_hash",
      "runs.error_code",
    ]);
  });
});

describe("runCycle with fixture channels", () => {
  it("creates a cycle, runs and raw postings", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "indeed", files: ["postings-a.json"] });
    registerFixtureChannel(registry, { id: "arbeitsagentur", files: ["postings-b.json"] });
    const result = await run(registry);

    expect(result.status).toBe("succeeded");
    expect(result.cycleId).not.toBeNull();
    const cycle = await getCycle(getDb(), result.cycleId as number);
    expect(cycle).toMatchObject({ kind: "manual", status: "succeeded" });
    expect(cycle?.finishedAt).toBeInstanceOf(Date);
    const summary = cycle?.summaryJson as { steps: Array<{ name: string; status: string; durationMs: number }>; windowKind: null };
    expect(summary.steps.map((s) => s.name)).toEqual(["collect", "pipeline", "filter", "signals", "ai", "notify", "maintenance"]);
    expect(summary.steps.every((s) => s.status === "ok" && typeof s.durationMs === "number")).toBe(true);

    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs).toHaveLength(18); // 9 queries x 2 channels
    expect(runs.every((r) => r.status === "succeeded" && r.queryHash !== null && r.finishedAt !== null && r.error === null)).toBe(true);
    expect(new Set(runs.map((r) => r.queryHash)).size).toBe(9);
    const indeedRuns = runs.filter((r) => r.channelId === "indeed");
    expect(indeedRuns.map((r) => r.fetched)).toEqual(Array(9).fill(3));
    // the first query inserts, later ones re-deliver the same postings
    expect(indeedRuns.map((r) => r.newCount)).toEqual([3, 0, 0, 0, 0, 0, 0, 0, 0]);

    const indeedRaw = await listRawPostingsForChannel(getDb(), "indeed");
    expect(indeedRaw.map((r) => r.externalId)).toEqual(["fx-1001", "fx-1002", "fx-1003"]);
    expect(indeedRaw.every((r) => r.parseStatus === "pending" && r.payloadHash !== null)).toBe(true);
    expect(indeedRaw[0]?.payloadJson).toMatchObject({ id: "fx-1001", title: "Applied AI Engineer" });
    expect(await listRawPostingsForChannel(getDb(), "arbeitsagentur")).toHaveLength(2);

    const channelRows = await getChannelRows(getDb());
    expect(channelRows.map((c) => c.id).sort()).toEqual(["arbeitsagentur", "indeed"]);
    expect(channelRows.find((c) => c.id === "indeed")).toMatchObject({
      circuitState: "closed",
      consecutiveFailures: 0,
      health: "healthy",
    });
    expect(channelRows.find((c) => c.id === "indeed")?.lastSuccessAt).toBeInstanceOf(Date);
  });

  it("records the catch-up window kind in the summary", async () => {
    const registry = new ChannelRegistry();
    const fixture = registerFixtureChannel(registry, { id: "indeed" });
    const result = await runCycle("catchup", { registry, config: config(), logger: quietLogger, windowKind: "weekday_evening" });
    expect(fixture.seen[0]?.windowHours).toBe(10);
    expect(result.summary.windowKind).toBe("weekday_evening");
    expect((await getCycle(getDb(), result.cycleId as number))?.kind).toBe("catchup");
  });

  it("a second run creates no duplicate raw postings and leaves unchanged payloads as they are", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "indeed", postings: [posting("a"), posting("b"), posting("c")] });
    await run(registry);
    const [first] = await listRawPostingsForChannel(getDb(), "indeed");
    if (!first) throw new Error("no raw posting");
    await setRawParseStatus(getDb(), first.id, "parsed");
    const before = await listRawPostingsForChannel(getDb(), "indeed");

    const second = await run(registry);
    const after = await listRawPostingsForChannel(getDb(), "indeed");
    expect(after).toHaveLength(3);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r) => r.parseStatus)).toEqual(["parsed", "pending", "pending"]);
    const runs = await listRunsForCycle(getDb(), second.cycleId as number);
    expect(runs.every((r) => r.newCount === 0 && r.fetched === 3)).toBe(true);
    // refreshed: fetched_at moves forward and run_id points at the latest run
    expect(after[0]?.fetchedAt.getTime()).toBeGreaterThan(before[0]?.fetchedAt.getTime() ?? 0);
    expect(runs.map((r) => r.id)).toContain(after[0]?.runId);
  });

  it("sets a posting back to pending when its payload changed, and only that one", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "indeed", postings: [posting("a"), posting("b")] });
    await run(registry);
    for (const row of await listRawPostingsForChannel(getDb(), "indeed")) await setRawParseStatus(getDb(), row.id, "parsed");

    const changed = new ChannelRegistry();
    registerFixtureChannel(changed, { id: "indeed", postings: [posting("a"), posting("b", { description: "Build different things" })] });
    await run(changed);
    const rows = await listRawPostingsForChannel(getDb(), "indeed");
    expect(rows.map((r) => [r.externalId, r.parseStatus])).toEqual([
      ["a", "parsed"],
      ["b", "pending"],
    ]);
    expect(rows[1]?.payloadJson).toMatchObject({ description: "Build different things" });
  });

  it("a failing channel does not stop the others (C2) and its failure is recorded", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "arbeitsagentur", failure: { code: "blocked" } });
    registerFixtureChannel(registry, { id: "indeed", postings: [posting("ok-1")] });
    registry.register(probeChannel("greenhouse", { usesQueries: false, throws: new TypeError("channel bug") }), { settings: settings() });
    const result = await run(registry);

    expect(result.status).toBe("partial");
    expect((await getCycle(getDb(), result.cycleId as number))?.status).toBe("partial");
    expect(await listRawPostingsForChannel(getDb(), "indeed")).toHaveLength(1);
    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    const bad = runs.filter((r) => r.channelId === "arbeitsagentur");
    // the blocked query, then one skipped run saying the remaining queries were not attempted
    expect(bad.map((r) => [r.status, r.errorCode])).toEqual([
      ["failed", "blocked"],
      ["skipped", "blocked"],
    ]);
    expect(bad[0]?.error).toContain("blocked");
    expect(runs.filter((r) => r.channelId === "indeed").every((r) => r.status === "succeeded")).toBe(true);
    expect(runs.find((r) => r.channelId === "greenhouse")).toMatchObject({ status: "failed", errorCode: "unknown" });
    const rows = await getChannelRows(getDb());
    expect(rows.find((r) => r.id === "arbeitsagentur")).toMatchObject({ consecutiveFailures: 1, lastErrorCode: "blocked", health: "degraded" });
    expect(rows.find((r) => r.id === "indeed")?.health).toBe("healthy");
  });

  it("records which channel served each query of a cascade", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "fx-1", family: "linkedin", failure: { code: "blocked" } });
    registerFixtureChannel(registry, { id: "fx-2", family: "linkedin", postings: [posting("l-1")] });
    const result = await run(registry, { cascades: cascade("fx-1", "fx-2") });
    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs.map((r) => [r.channelId, r.status])).toEqual([["fx-1", "failed"], ...Array(9).fill(["fx-2", "succeeded"])]);
    expect(runs[0]?.queryHash).toBe(runs[1]?.queryHash); // the blocked query was re-served by fx-2
    expect(await listRawPostingsForChannel(getDb(), "fx-2")).toHaveLength(1);
  });

  it("writes a skipped run with the reason when no cascade channel is available", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "fx-1", family: "linkedin", costPerRecordUsd: 1, settings: { monthlyBudgetUsd: 0 } });
    registerFixtureChannel(registry, { id: "fx-2", family: "linkedin", settings: { enabled: false } });
    const result = await run(registry, { cascades: cascade("fx-1", "fx-2") });
    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ channelId: "fx-1", status: "skipped" });
    expect(runs[0]?.error).toContain("fx-1: budget_exceeded");
    expect(runs[0]?.error).toContain("fx-2: disabled");
    expect(result.status).toBe("failed");
  });

  it("dry run writes nothing", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "indeed" });
    const result = await run(registry, { dryRun: true });
    expect(result.cycleId).toBeNull();
    for (const table of ["cycles", "runs", "raw_postings", "channels"]) {
      const [row] = await getDb().execute<{ n: string }>(sql.raw(`select count(*)::text as n from ${table}`));
      expect(row?.n).toBe("0");
    }
  });
});

describe("steps", () => {
  it("runs registered steps in order and stores their results in summary_json", async () => {
    const order: string[] = [];
    registerCycleStep("pipeline", async (ctx) => {
      order.push(`pipeline#${ctx.cycle.id}`);
      return { result: { parsed: 3 } };
    });
    registerCycleStep("notify", async (ctx) => {
      order.push(`notify after collect=${typeof ctx.results.collect}`);
      return { status: "partial", result: { sent: 1 } };
    });
    const result = await run(new ChannelRegistry());
    expect(order).toEqual([`pipeline#${result.cycleId}`, "notify after collect=object"]);
    expect(result.status).toBe("partial");
    const summary = (await getCycle(getDb(), result.cycleId as number))?.summaryJson as {
      steps: Array<{ name: string; status: string; result?: unknown }>;
    };
    expect(summary.steps.find((s) => s.name === "pipeline")).toMatchObject({ status: "ok", result: { parsed: 3 } });
    expect(summary.steps.find((s) => s.name === "notify")).toMatchObject({ status: "partial", result: { sent: 1 } });
  });

  it("a throwing step is recorded as failed and the later steps still run", async () => {
    const ran: string[] = [];
    registerCycleStep("signals", async () => {
      throw new Error("signal extraction exploded");
    });
    registerCycleStep("ai", async () => {
      ran.push("ai");
    });
    const result = await run(new ChannelRegistry());
    expect(ran).toEqual(["ai"]);
    expect(result.status).toBe("partial");
    const steps = result.summary.steps;
    expect(steps.find((s) => s.name === "signals")).toMatchObject({ status: "failed", error: expect.stringContaining("exploded") });
    expect(steps.find((s) => s.name === "ai")?.status).toBe("ok");
  });
});

describe("circuit breaker across cycles", () => {
  const T0 = new Date("2026-10-07T07:00:00Z");
  const at = (hours: number) => () => new Date(T0.getTime() + hours * 3_600_000);

  it("opens after the configured failures, keeps the channel out, then probes after the cooldown", async () => {
    const registry = new ChannelRegistry();
    const flaky = registerFixtureChannel(registry, { id: "indeed", failure: { code: "network", times: 4 } });

    const first = await run(registry, { now: at(0) });
    // threshold 3: three failed queries open the circuit, the other six are skipped in one skipped run
    const runs = await listRunsForCycle(getDb(), first.cycleId as number);
    expect(runs.map((r) => r.status)).toEqual(["failed", "failed", "failed", "skipped"]);
    expect(runs[3]?.error).toContain("circuit_open");
    expect(flaky.seen).toHaveLength(3);
    const opened = (await getChannelRows(getDb(), ["indeed"]))[0];
    expect(opened).toMatchObject({ circuitState: "open", consecutiveFailures: 3, lastErrorCode: "network", health: "down" });
    expect(opened?.circuitOpenUntil?.toISOString()).toBe("2026-10-08T07:00:00.000Z");

    // next cycle, still cooling down: the channel is not called at all
    await run(registry, { now: at(5) });
    expect(flaky.seen).toHaveLength(3);

    // after the cooldown one probe is allowed; it fails (4th scripted failure), so the circuit reopens
    const probe = await run(registry, { now: at(25) });
    expect(flaky.seen).toHaveLength(4);
    expect((await listRunsForCycle(getDb(), probe.cycleId as number)).map((r) => r.status)).toEqual(["failed", "skipped"]);
    expect((await getChannelRows(getDb(), ["indeed"]))[0]).toMatchObject({ circuitState: "open", consecutiveFailures: 4 });

    // a later probe succeeds: the circuit closes and everything runs again
    const recovered = await run(registry, { now: at(60) });
    expect(recovered.status).toBe("succeeded");
    expect(flaky.seen).toHaveLength(4 + 9);
    expect((await getChannelRows(getDb(), ["indeed"]))[0]).toMatchObject({ circuitState: "closed", consecutiveFailures: 0, health: "healthy" });
  });

  it("a cascade moves on to the next channel once the first one's circuit is open", async () => {
    const registry = new ChannelRegistry();
    const first = registerFixtureChannel(registry, { id: "fx-1", family: "linkedin", failure: { code: "rate_limited" } });
    const second = registerFixtureChannel(registry, { id: "fx-2", family: "linkedin" });
    await run(registry, { cascades: cascade("fx-1", "fx-2"), now: at(0) });
    expect(first.seen).toHaveLength(3);
    expect(second.seen).toHaveLength(6);
    // the next cycle goes straight to fx-2
    await run(registry, { cascades: cascade("fx-1", "fx-2"), now: at(1) });
    expect(first.seen).toHaveLength(3);
    expect(second.seen).toHaveLength(15);
  });
});

describe("budget persistence", () => {
  it("accumulates month usage across cycles and stops a paid channel at its budget", async () => {
    const registry = new ChannelRegistry();
    const paid = registerFixtureChannel(registry, {
      id: "fx-paid",
      family: "linkedin",
      costPerRecordUsd: 1,
      postings: [posting("p1"), posting("p2")],
      settings: { monthlyBudgetUsd: 5, freeRecordsPerMonth: 3 },
    });
    const free = registerFixtureChannel(registry, { id: "fx-free", family: "linkedin", postings: [posting("f1")] });
    const options = { cascades: cascade("fx-paid", "fx-free"), now: () => new Date("2026-10-07T07:00:00Z") };

    await run(registry, options);
    // 2 records per query, $1 per paid record, 3 free records, budget $5:
    // q1 2 free; q2 1 free + 1 paid ($1); q3 $2; q4 $2 (total $5); q5 would need $1 of $0: fx-free takes over
    expect((await getMonthUsage(getDb(), "2026-10")).get("fx-paid")).toEqual({ records: 8, usd: 5 });
    expect(paid.seen).toHaveLength(4);
    expect(free.seen).toHaveLength(5);

    // the next calendar month starts from zero again
    await run(registry, { ...options, now: () => new Date("2026-11-03T07:00:00Z") });
    expect((await getMonthUsage(getDb(), "2026-11")).get("fx-paid")).toEqual({ records: 8, usd: 5 });
    expect((await getMonthUsage(getDb(), "2026-10")).get("fx-paid")).toEqual({ records: 8, usd: 5 });
    expect(paid.seen).toHaveLength(8);
  });

  it("enforces the global paid cap using the persisted spend of other channels", async () => {
    await getDb().insert(schema.channels).values({ id: "linkedin-brightdata", family: "linkedin", kind: "paid" });
    await getDb().execute(sql`update channels set month_usage = '{"2026-10": {"records": 10, "usd": 14.5}}'::jsonb where id = 'linkedin-brightdata'`);
    const registry = new ChannelRegistry();
    const paid = registerFixtureChannel(registry, { id: "indeed", costPerRecordUsd: 1, settings: { monthlyBudgetUsd: 10 } });
    const result = await run(registry, { now: () => new Date("2026-10-07T07:00:00Z") });
    // $0.50 left globally and one record costs $1: the channel is not even tried
    expect(paid.seen).toHaveLength(0);
    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ channelId: "indeed", status: "skipped", errorCode: "budget_exceeded" });
  });
});

describe("concurrency guard", () => {
  it("lets only one of two simultaneous cycles run; the other is recorded as skipped", async () => {
    const registry = new ChannelRegistry();
    // The channel is held on a gate (not a timer), so the winner keeps the lock for exactly as long as
    // the loser needs to be turned away, however slow the machine is.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = probeChannel("indeed", { usesQueries: false, gate });
    registry.register(slow, { settings: settings() });
    const pending = [run(registry), run(registry)];
    expect((await Promise.race(pending)).status).toBe("skipped");
    release();
    const [a, b] = await Promise.all(pending);

    expect([a.status, b.status].sort()).toEqual(["skipped", "succeeded"]);
    expect(slow.calls).toHaveLength(1);
    const skipped = a.status === "skipped" ? a : b;
    const row = await getCycle(getDb(), skipped.cycleId as number);
    expect(row).toMatchObject({ status: "skipped" });
    expect(row?.finishedAt).toBeInstanceOf(Date);
    expect((row?.summaryJson as { reason: string }).reason).toContain("lock");
    const [counts] = await getDb().execute<{ status: string; n: string }>(
      sql`select count(*) filter (where status = 'skipped')::text as n, '' as status from cycles`,
    );
    expect(counts?.n).toBe("1");
    expect(await getLatestRunStartedAt(getDb())).toEqual((await getCycle(getDb(), (a.status === "skipped" ? b : a).cycleId as number))?.startedAt);
  });

  it("waits instead of skipping when schedule.skip_if_running is false", async () => {
    const registry = new ChannelRegistry();
    const slow = probeChannel("indeed", { usesQueries: false, waitMs: 120 });
    registry.register(slow, { settings: settings() });
    const waiting = { ...config(), schedule: { ...config().schedule, skip_if_running: false } };
    const [a, b] = await Promise.all([run(registry, { config: waiting }), run(registry, { config: waiting })]);
    expect([a.status, b.status]).toEqual(["succeeded", "succeeded"]);
    expect(slow.calls).toHaveLength(2);
    const [first, second] = [await getCycle(getDb(), a.cycleId as number), await getCycle(getDb(), b.cycleId as number)].sort(
      (x, y) => (x?.id ?? 0) - (y?.id ?? 0),
    );
    // Both timestamps come from the Postgres clock, and the lock is released only after the first cycle
    // committed its finish, so the second cycle cannot have started earlier. Id order is the tie-breaker.
    expect(second?.startedAt.getTime()).toBeGreaterThanOrEqual(first?.finishedAt?.getTime() ?? Infinity);
    expect(second?.id).toBeGreaterThan(first?.id ?? Infinity);
  });

  describe("a scheduled cycle that finds the lock taken", () => {
    const waitingConfig = (maxMinutes: number) => ({ ...config(), schedule: { ...config().schedule, partial_cycle_wait: { max_minutes: maxMinutes, poll_seconds: 1 } } });
    // a failed expectation must not leave a cycle holding the lock for the next test
    const gates: Array<() => void> = [];
    afterEach(() => {
      for (const open of gates.splice(0)) open();
    });
    /** `indeed` is held on a gate; `greenhouse` answers at once. */
    function gatedRegistry() {
      const registry = new ChannelRegistry();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      gates.push(() => release());
      const slow = probeChannel("indeed", { usesQueries: false, gate });
      const other = probeChannel("greenhouse", { usesQueries: false });
      registry.register(slow, { settings: settings() });
      registry.register(other, { settings: settings() });
      return { registry, slow, other, release: () => release() };
    }
    async function untilCalled(channel: { calls: unknown[] }): Promise<void> {
      const deadline = Date.now() + 5000;
      while (channel.calls.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(channel.calls.length).toBeGreaterThan(0);
    }

    it("waits for a manual cycle limited to one channel and then runs every channel", async () => {
      const { registry, slow, other, release } = gatedRegistry();
      const manual = run(registry, { channelIds: ["indeed"] });
      await untilCalled(slow);
      let settled = false;
      const scheduled = runCycle("weekday_morning", { registry, config: waitingConfig(1), logger: quietLogger, sleep: async () => {} }).finally(() => {
        settled = true;
      });
      // it keeps trying the lock (every poll_seconds) instead of recording a skip
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(settled).toBe(false);
      release();
      const [m, s] = await Promise.all([manual, scheduled]);
      expect(m.status).toBe("succeeded");
      expect(m.summary.channelIds).toEqual(["indeed"]);
      expect(s.status).toBe("succeeded");
      expect(s.summary.channelIds).toBeNull();
      expect(slow.calls).toHaveLength(2);
      expect(other.calls).toHaveLength(1);
      const rows = await getDb().select().from(schema.cycles).orderBy(schema.cycles.id);
      expect(rows.map((r) => [r.kind, r.status])).toEqual([
        ["manual", "succeeded"],
        ["weekday_morning", "succeeded"],
      ]);
      expect((rows[0]?.summaryJson as { channelIds: unknown }).channelIds).toEqual(["indeed"]);
    });

    it("is skipped, naming the running cycle, when that cycle covers every channel", async () => {
      const { registry, slow, release } = gatedRegistry();
      const full = run(registry);
      await untilCalled(slow);
      const [running] = await getDb().select().from(schema.cycles).where(eq(schema.cycles.status, "running"));
      const scheduled = await runCycle("weekday_morning", { registry, config: waitingConfig(1), logger: quietLogger, sleep: async () => {} });
      release();
      expect((await full).status).toBe("succeeded");
      expect(scheduled.status).toBe("skipped");
      expect(scheduled.summary.coveredBy).toBe(running?.id);
      expect((await getCycle(getDb(), scheduled.cycleId as number))?.summaryJson).toMatchObject({ coveredBy: running?.id, channelIds: null });
      expect(slow.calls).toHaveLength(1);
    });

    it("is skipped at once when partial_cycle_wait.max_minutes is 0", async () => {
      const { registry, slow, release } = gatedRegistry();
      const manual = run(registry, { channelIds: ["indeed"] });
      await untilCalled(slow);
      const scheduled = await runCycle("weekday_morning", { registry, config: waitingConfig(0), logger: quietLogger, sleep: async () => {} });
      release();
      await manual;
      expect(scheduled.status).toBe("skipped");
      expect(scheduled.summary.coveredBy).toBeNull();
    });

    it("does not take a row a crash left `running` for the running cycle: it waits for the cycle that holds the lock", async () => {
      // an interrupted CLI cycle of every channel, still `running`
      await getDb().insert(schema.cycles).values({ kind: "manual", status: "running", summaryJson: { channelIds: null } });
      const { registry, slow, release } = gatedRegistry();
      const manual = run(registry, { channelIds: ["indeed"] });
      await untilCalled(slow);
      let settled = false;
      const scheduled = runCycle("weekday_morning", { registry, config: waitingConfig(1), logger: quietLogger, sleep: async () => {} }).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(settled).toBe(false);
      release();
      expect((await manual).status).toBe("succeeded");
      expect((await scheduled).status).toBe("succeeded");
    });

    it("tells the control poller that it waits, until it has the lock", async () => {
      const { registry, slow, release } = gatedRegistry();
      const manual = run(registry, { channelIds: ["indeed"] });
      await untilCalled(slow);
      expect(isCycleWaitingForLock()).toBe(false);
      const scheduled = runCycle("weekday_morning", { registry, config: waitingConfig(1), logger: quietLogger, sleep: async () => {} });
      const deadline = Date.now() + 5000;
      while (!isCycleWaitingForLock() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(isCycleWaitingForLock()).toBe(true);
      release();
      await manual;
      expect((await scheduled).status).toBe("succeeded");
      expect(isCycleWaitingForLock()).toBe(false);
    });

    it("stops waiting and records a skip when the runner shuts down", async () => {
      const { registry, slow, release } = gatedRegistry();
      const manual = run(registry, { channelIds: ["indeed"] });
      await untilCalled(slow);
      const abort = new AbortController();
      const started = Date.now();
      const scheduled = runCycle("weekday_morning", { registry, config: waitingConfig(1), logger: quietLogger, sleep: async () => {}, signal: abort.signal });
      await new Promise((resolve) => setTimeout(resolve, 200));
      abort.abort();
      const result = await scheduled;
      expect(Date.now() - started).toBeLessThan(1500);
      expect(result.status).toBe("skipped");
      expect(result.summary.reason).toContain("cancelled");
      expect(isCycleWaitingForLock()).toBe(false);
      release();
      await manual;
      expect(await getDb().select().from(schema.cycles).where(eq(schema.cycles.kind, "weekday_morning"))).toEqual([expect.objectContaining({ status: "skipped" })]);
    });

    it("gives up after partial_cycle_wait.max_minutes and records a skip", async () => {
      const { registry, slow, release } = gatedRegistry();
      const manual = run(registry, { channelIds: ["indeed"] });
      await untilCalled(slow);
      // a clock that jumps by every sleep: one minute of waiting without waiting a minute
      let fake = 0;
      const sleeps: number[] = [];
      const lockWait = { now: () => fake, sleep: async (ms: number) => { sleeps.push(ms); fake += ms; return true; } };
      const config15 = { ...config(), schedule: { ...config().schedule, partial_cycle_wait: { max_minutes: 1, poll_seconds: 25 } } };
      const result = await runCycle("weekday_morning", { registry, config: config15, logger: quietLogger, sleep: async () => {}, lockWait });
      release();
      await manual;
      expect(result.status).toBe("skipped");
      expect(result.summary.reason).toContain("after 1 min");
      expect(sleeps).toEqual([25_000, 25_000, 10_000]);
      expect(isCycleWaitingForLock()).toBe(false);
    });

    it("a manual cycle never waits: one limited to other channels is skipped without a covering cycle", async () => {
      const { registry, slow, release } = gatedRegistry();
      const manual = run(registry, { channelIds: ["indeed"] });
      await untilCalled(slow);
      const second = await run(registry, { channelIds: ["greenhouse"], config: waitingConfig(1) });
      release();
      await manual;
      expect(second.status).toBe("skipped");
      expect(second.summary.coveredBy).toBeNull();
    });
  });

  it("releases the lock when a cycle fails, so the next one runs", async () => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "indeed", failure: { code: "auth_expired" } });
    expect((await run(registry)).status).toBe("failed");
    const ok = new ChannelRegistry();
    registerFixtureChannel(ok, { id: "indeed" });
    expect((await run(ok)).status).toBe("succeeded");
  });
});

describe("database clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Regression: started_at is stamped by Postgres (column default) while finished_at used the host
  // clock, so any skew between the two (Docker VM drift) could put finished_at before started_at.
  it.each([-60_000, 60_000])("stamps every cycle and run timestamp with the database clock, whatever the host clock says (skew %i ms)", async (skewMs) => {
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "indeed", failure: { code: "network", times: 1 } });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + skewMs });
    const result = await run(registry);
    await getDb().insert(schema.cycles).values({ kind: "manual", status: "running" });
    await failOrphanedCycles(getDb(), "swept");
    vi.useRealTimers();

    const [bad] = await getDb().execute<{ n: string }>(sql`
      select (
        (select count(*) from cycles where finished_at is null or finished_at < started_at or finished_at > clock_timestamp())
        + (select count(*) from runs where finished_at is null or finished_at < started_at or finished_at > clock_timestamp())
        + (select count(*) from raw_postings where fetched_at > clock_timestamp())
      )::text as n`);
    expect(bad?.n).toBe("0");
    expect(result.cycleId).not.toBeNull();
  });
});

describe("orphaned cycles", () => {
  it("fails cycles and runs left in `running` by a crashed process", async () => {
    const db = getDb();
    await db.insert(schema.channels).values({ id: "indeed", family: "indeed", kind: "api" });
    const [cycle] = await db.insert(schema.cycles).values({ kind: "manual" }).returning();
    const [runRow] = await db.insert(schema.runs).values({ channelId: "indeed", cycleId: cycle?.id ?? 0 }).returning();
    const swept = await failOrphanedCycles(db, "runner restarted");
    expect(swept).toEqual({ cycles: 1, runs: 1 });
    expect(await getCycle(db, cycle?.id ?? 0)).toMatchObject({ status: "failed" });
    const [after] = await db.select().from(schema.runs).where(eq(schema.runs.id, runRow?.id ?? 0));
    expect(after).toMatchObject({ status: "failed", error: "runner restarted" });
  });

  it("the catch-up skips a cycle a restart cut off, but only once in a row; a cycle that failed on its own counts", async () => {
    const db = getDb();
    const at = (iso: string) => new Date(iso);
    const add = (iso: string, status: "succeeded" | "failed" | "running", summaryJson?: unknown) =>
      db.insert(schema.cycles).values({ kind: "weekday_morning", status, startedAt: at(iso), ...(summaryJson === undefined ? {} : { summaryJson }) });
    expect(await getLatestRunStartedAt(db)).toBeNull();
    await add("2026-10-09T06:00:00Z", "succeeded", {});
    await add("2026-10-09T07:00:00Z", "failed", { aborted: true });
    expect(await getLatestRunStartedAt(db)).toEqual(at("2026-10-09T06:00:00Z"));
    // the re-run died as well (left running by a crashed runner): now the newest counts, no loop
    await add("2026-10-09T08:00:00Z", "running");
    await failOrphanedCycles(db, "runner restarted while the cycle was running");
    expect(await getLatestRunStartedAt(db)).toEqual(at("2026-10-09T08:00:00Z"));
    await add("2026-10-09T09:00:00Z", "failed", { aborted: false });
    expect(await getLatestRunStartedAt(db)).toEqual(at("2026-10-09T09:00:00Z"));
    await add("2026-10-09T10:00:00Z", "failed");
    expect(await getLatestRunStartedAt(db)).toEqual(at("2026-10-09T10:00:00Z"));
    // only interrupted cycles so far: nothing ran
    await db.execute(sql`truncate table cycles restart identity cascade`);
    await add("2026-10-09T11:00:00Z", "failed", { aborted: true });
    expect(await getLatestRunStartedAt(db)).toBeNull();
  });

  it("the catch-up and the orphan sweep keep a cycle limited to some channels apart from a full one", async () => {
    const db = getDb();
    const at = (iso: string) => new Date(iso);
    await db.insert(schema.cycles).values({ kind: "weekday_morning", status: "succeeded", startedAt: at("2026-10-09T06:00:00Z"), summaryJson: { channelIds: null } });
    await db.insert(schema.cycles).values({ kind: "manual", status: "succeeded", startedAt: at("2026-10-09T07:00:00Z"), summaryJson: { channelIds: ["indeed"] } });
    expect(await getLatestRunStartedAt(db)).toEqual(at("2026-10-09T06:00:00Z"));
    // a manual cycle of every channel counts
    await db.insert(schema.cycles).values({ kind: "manual", status: "succeeded", startedAt: at("2026-10-09T08:00:00Z"), summaryJson: { channelIds: null } });
    expect(await getLatestRunStartedAt(db)).toEqual(at("2026-10-09T08:00:00Z"));
    // a partial cycle a crash left running keeps its channels when swept
    const [left] = await db.insert(schema.cycles).values({ kind: "manual", status: "running", startedAt: at("2026-10-09T09:00:00Z"), summaryJson: { channelIds: ["indeed"] } }).returning();
    await failOrphanedCycles(db, "runner restarted");
    expect((await getCycle(db, left?.id ?? 0))?.summaryJson).toEqual({ channelIds: ["indeed"], orphaned: "runner restarted" });
    expect(await getLatestRunStartedAt(db)).toEqual(at("2026-10-09T08:00:00Z"));
  });

  it("counts the running cycles a deploy waits for", async () => {
    const db = getDb();
    expect(await countRunningCycles(db)).toBe(0);
    await db.insert(schema.cycles).values({ kind: "manual" });
    expect(await countRunningCycles(db)).toBe(1);
  });
});

describe("raw posting upsert", () => {
  beforeEach(async () => {
    await getDb().insert(schema.channels).values({ id: "indeed", family: "indeed", kind: "api" }).onConflictDoNothing();
  });

  it("hashes payloads independently of key order", () => {
    expect(hashPayload({ a: 1, b: { c: [1, 2], d: null } })).toBe(hashPayload({ b: { d: null, c: [1, 2] }, a: 1 }));
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
    expect(hashPayload({ a: 1, b: undefined })).toBe(hashPayload({ a: 1 }));
  });

  it("collapses duplicate external ids in one batch and counts inserted / changed / unchanged", async () => {
    const db = getDb();
    const first = await upsertRawPostings(db, {
      channelId: "indeed",
      runId: null,
      items: [
        { externalId: "1", url: "https://a", payload: { v: 1 } },
        { externalId: "1", url: "https://a", payload: { v: 2 } },
        { externalId: "2", url: null, payload: { v: 1 } },
      ],
    });
    expect(first).toEqual({ inserted: 2, changed: 0, unchanged: 0 });
    const second = await upsertRawPostings(db, {
      channelId: "indeed",
      runId: null,
      items: [
        { externalId: "1", url: null, payload: { v: 2 } },
        { externalId: "2", url: null, payload: { v: 9 } },
        { externalId: "3", url: null, payload: "plain string" },
      ],
    });
    expect(second).toEqual({ inserted: 1, changed: 1, unchanged: 1 });
    const rows = await listRawPostingsForChannel(db, "indeed");
    expect(rows.map((r) => r.payloadJson)).toEqual([{ v: 2 }, { v: 9 }, "plain string"]);
    // an unchanged re-delivery keeps the url it had
    expect(rows[0]?.url).toBe("https://a");
  });

  it("round-trips payload shapes verbatim (C1): arrays, nested objects, unicode, nulls", async () => {
    const payload = { title: "KI-Entwickler (m/w/d) – Köln", tags: ["a", "b"], nested: { n: null, x: 1.5 }, list: [] };
    await upsertRawPostings(getDb(), { channelId: "indeed", runId: null, items: [{ externalId: "u", url: null, payload }] });
    const [row] = await listRawPostingsForChannel(getDb(), "indeed");
    expect(row?.payloadJson).toEqual(payload);
  });

  it("handles large batches", async () => {
    const items = Array.from({ length: 1200 }, (_, i) => ({ externalId: `bulk-${i}`, url: null, payload: { i } }));
    expect(await upsertRawPostings(getDb(), { channelId: "indeed", runId: null, items })).toEqual({ inserted: 1200, changed: 0, unchanged: 0 });
    expect(await upsertRawPostings(getDb(), { channelId: "indeed", runId: null, items })).toEqual({ inserted: 0, changed: 0, unchanged: 1200 });
  });
});

describe("shipped configuration", () => {
  it("has the circuit breaker and concurrency the framework reads", () => {
    const cfg: ChannelsConfig = shippedChannels();
    expect(cfg.collect.concurrency).toBe(3);
    expect(cfg.circuit_breaker.failures).toBe(3);
    expect(channelsWith(() => {}).http.max_retries).toBe(3);
  });
});
