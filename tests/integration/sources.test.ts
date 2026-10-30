import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { monthKey } from "@/lib/channels/budget";
import { buildQueries } from "@/lib/channels/query";
import { loadConfig, reloadConfig, resetConfigCache } from "@/lib/config";
import { addMonthUsage, closeDb, getDb, insertAiUsage, listChannelCycleHistory, schema, upsertChannelRows } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { loadSourcesView } from "@/lib/sources/load";
import { RUNS_PER_CHANNEL } from "@/lib/settings/constants";

import { makeTempConfig, type TempConfig } from "../config/helpers";

const url = inject("testDatabaseUrl");
let temp: TempConfig;

/** Noon on the 7th: far from a month boundary in every time zone. */
const NOW = new Date("2026-10-07T12:00:00Z");

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

beforeEach(async () => {
  temp = makeTempConfig();
  await getDb().execute(sql`truncate table ai_usage, runner_heartbeats, runs, cycles, channels restart identity cascade`);
});

afterEach(() => temp.cleanup());

afterAll(async () => {
  await closeDb();
});

const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

async function seed() {
  const db = getDb();
  await upsertChannelRows(db, [
    { id: "linkedin-brightdata", family: "linkedin", kind: "paid", enabled: true },
    { id: "linkedin-guest", family: "linkedin", kind: "guest", enabled: true },
    { id: "indeed", family: "indeed", kind: "api", enabled: true },
    { id: "greenhouse", family: "ats", kind: "ats", enabled: true },
  ]);
  const month = monthKey(NOW, loadConfig("schedule").timezone);
  await addMonthUsage(db, "linkedin-brightdata", month, { records: 5300, usd: 0.45 });
  await addMonthUsage(db, "indeed", month, { records: 120, usd: 0 });
  await addMonthUsage(db, "greenhouse", "2026-09", { records: 999, usd: 3 }); // last month: must not count

  await db.update(schema.channels).set({ circuitState: "open", circuitOpenUntil: new Date(NOW.getTime() + 3_600_000), consecutiveFailures: 3, lastErrorCode: "blocked", health: "down" }).where(sql`id = 'greenhouse'`);

  const [older, latest] = await db
    .insert(schema.cycles)
    .values([
      { kind: "weekday_evening", startedAt: minutesAgo(600), finishedAt: minutesAgo(590), status: "succeeded" },
      { kind: "weekday_morning", startedAt: minutesAgo(30), finishedAt: minutesAgo(20), status: "partial" },
    ])
    .returning();
  if (!older || !latest) throw new Error("cycles");

  // indeed: 12 runs, newest first in the view and cut to RUNS_PER_CHANNEL
  await db.insert(schema.runs).values(
    Array.from({ length: 12 }, (_, i) => ({
      cycleId: i === 0 ? latest.id : older.id,
      channelId: "indeed",
      startedAt: minutesAgo(10 + i * 5),
      finishedAt: minutesAgo(9 + i * 5),
      status: i === 3 ? ("failed" as const) : ("succeeded" as const),
      fetched: 100 + i,
      newCount: i,
      error: i === 3 ? "blocked by the site" : null,
      errorCode: i === 3 ? "blocked" : null,
    })),
  );
  // the latest cycle's LinkedIn queries: Bright Data failed, the guest channel took over
  await db.insert(schema.runs).values([
    { cycleId: latest.id, channelId: "linkedin-brightdata", startedAt: minutesAgo(25), finishedAt: minutesAgo(24), status: "failed", errorCode: "blocked", error: "blocked" },
    { cycleId: latest.id, channelId: "linkedin-guest", startedAt: minutesAgo(24), finishedAt: minutesAgo(23), status: "succeeded", fetched: 40, newCount: 7 },
    { cycleId: latest.id, channelId: "linkedin-guest", startedAt: minutesAgo(22), finishedAt: minutesAgo(21), status: "partial", fetched: 22, newCount: 1 },
  ]);

  await insertAiUsage(db, { provider: "codex-cli", task: "score", tokensIn: 1000, tokensOut: 200, costEstimate: 0, at: minutesAgo(60) });
  await insertAiUsage(db, { provider: "codex-cli", task: "score", tokensIn: 500, tokensOut: 100, costEstimate: 0, at: minutesAgo(50) });
  await insertAiUsage(db, { provider: "deepseek", task: "translate", tokensIn: 2000, tokensOut: 3000, costEstimate: 0.0123, at: minutesAgo(40) });
  await insertAiUsage(db, { provider: "anthropic", task: "score", tokensIn: 10, tokensOut: 10, costEstimate: 5, at: new Date("2026-09-28T10:00:00Z") }); // last month
  await db.insert(schema.runnerHeartbeats).values({ process: "runner", at: new Date(NOW.getTime() - 20_000) });
  return { latest, month };
}

describe("loadSourcesView against the database", () => {
  it("shows what the database holds, per channel", async () => {
    const { latest, month } = await seed();
    const view = await loadSourcesView(NOW);
    expect(view.month).toBe(month);

    const byId = new Map(view.cards.map((c) => [c.id, c]));
    // usage of this month only, against the configured budgets
    expect(byId.get("linkedin-brightdata")?.usage).toMatchObject({ records: 5300, usd: 0.45, budgetUsd: 5, freeRecords: 5000 });
    expect(byId.get("indeed")?.usage).toMatchObject({ records: 120, usd: 0, budgetUsd: 0, freeRecords: 0 });
    // what a channel did this month comes from its runs (not from the budget counter above)
    const indeedActivity = byId.get("indeed")?.usage.activity;
    expect(indeedActivity?.runs).toBeGreaterThanOrEqual(RUNS_PER_CHANNEL);
    expect(indeedActivity?.fetched).toBeGreaterThan(0);
    expect(byId.get("greenhouse")?.usage.records).toBe(0);
    expect(view.paid).toEqual({ usedUsd: 0.45, capUsd: 15 });

    // the last 10 runs, newest first
    const indeedRuns = byId.get("indeed")?.runs ?? [];
    expect(indeedRuns).toHaveLength(RUNS_PER_CHANNEL);
    expect(indeedRuns.map((r) => r.fetched)).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
    expect(indeedRuns[3]).toMatchObject({ status: "failed", errorCode: "blocked", error: "blocked by the site" });

    // circuit state and registration
    expect(byId.get("greenhouse")?.circuit).toMatchObject({ state: "open", consecutiveFailures: 3, lastErrorCode: "blocked" });
    expect(byId.get("indeed")?.circuit?.state).toBe("closed");
    expect(byId.get("lever")).toMatchObject({ registered: false, enabled: true });
    expect(byId.get("linkedin-apify")).toMatchObject({ registered: false, enabled: true });

    // the cascade and who served the latest cycle
    expect(view.latestCycle).toMatchObject({ id: latest.id, status: "partial", kind: "weekday_morning" });
    expect(view.cascade.servedBy).toEqual(["linkedin-guest"]);
    const entries = new Map(view.cascade.entries.map((e) => [e.id, e]));
    expect(entries.get("linkedin-brightdata")?.latest).toMatchObject({ runs: 1, succeeded: 0, failed: 1 });
    expect(entries.get("linkedin-guest")?.latest).toMatchObject({ runs: 2, succeeded: 2, failed: 0, fetched: 62 });
    expect(entries.get("linkedin-apify")?.latest).toBeNull();
    expect(view.cascade.entries.map((e) => e.id)).toEqual(loadConfig("channels").linkedin.cascade);
  });

  it("per-channel history comes from the real run records of the last cycles (one aggregated query)", async () => {
    const { latest } = await seed();
    // a cycle that was skipped as a whole never counts as a cycle; a run that is still going is counted as running
    await getDb().insert(schema.cycles).values({ kind: "weekday_morning", startedAt: minutesAgo(5), finishedAt: minutesAgo(5), status: "skipped" });
    const history = await listChannelCycleHistory(getDb(), 14);

    // indeed: 11 runs in the older cycle (one failed), the newest run in the latest one; oldest cycle first
    const indeed = history.get("indeed");
    expect(indeed).toHaveLength(2);
    expect(indeed?.[0]).toMatchObject({ runs: 11, succeeded: 10, failed: 1, partial: 0, fetched: 1166, newCount: 66 });
    expect(indeed?.[1]).toMatchObject({ cycleId: latest.id, runs: 1, succeeded: 1, failed: 0, fetched: 100, newCount: 0 });
    // the guest channel only took part in the latest cycle: the older slot is "no data", not zero
    expect(history.get("linkedin-guest")?.[0]).toBeNull();
    expect(history.get("linkedin-guest")?.[1]).toMatchObject({ runs: 2, succeeded: 1, partial: 1, fetched: 62, newCount: 8 });
    expect(history.get("linkedin-brightdata")?.[1]).toMatchObject({ runs: 1, failed: 1, fetched: 0 });
    expect(history.get("greenhouse")).toEqual([null, null]);
    // only the newest cycle when asked for one
    expect(history.get("indeed")?.slice(-1)).toEqual((await listChannelCycleHistory(getDb(), 1)).get("indeed"));
    expect(await listChannelCycleHistory(getDb(), 0)).toEqual(new Map());

    const view = await loadSourcesView(NOW);
    const byId = new Map(view.cards.map((c) => [c.id, c]));
    const ui = loadConfig("ui");
    expect(byId.get("indeed")?.history).toEqual({ fetched: [1166, 100], outcomes: ["warn", "ok"], running: false, latest: { fetched: 100, newCount: 0 }, skippedStreak: 0 });
    expect(byId.get("indeed")?.status).toBe("ok");
    expect(byId.get("linkedin-guest")?.history.outcomes).toEqual([null, "warn"]);
    expect(byId.get("linkedin-brightdata")?.history.outcomes).toEqual([null, "fail"]);
    // the ui.yaml numbers cap what the card gets
    expect(view.healthCycles).toBe(ui.health_cycles);
    expect(byId.get("indeed")?.history.fetched.length).toBeLessThanOrEqual(ui.trend_cycles);
    expect(byId.get("indeed")?.history.outcomes.length).toBeLessThanOrEqual(ui.health_cycles);
    expect(view.budgetAlertPercent).toBe(Math.round(Math.min(...loadConfig("notify").alerts.budget_thresholds) * 100));
  });

  it("sums this month's AI usage per provider and task, and the paid API spend", async () => {
    await seed();
    const view = await loadSourcesView(NOW);
    expect(view.ai.rows).toEqual([
      { provider: "codex-cli", task: "score", calls: 2, tokensIn: 1500, tokensOut: 300, costUsd: 0 },
      { provider: "deepseek", task: "translate", calls: 1, tokensIn: 2000, tokensOut: 3000, costUsd: 0.0123 },
    ]);
    expect(view.ai.apiSpendUsd).toBeCloseTo(0.0123, 6);
    expect(view.ai.totalCostUsd).toBeCloseTo(0.0123, 6);
    expect(view.ai.budgetUsd).toBe(loadConfig("ai").monthly_api_budget_usd);
  });

  it("derives the runner state from the newest heartbeat", async () => {
    await seed();
    const view = await loadSourcesView(NOW);
    expect(view.runner).toMatchObject({ ageSeconds: 20, online: true, intervalSeconds: 30 });
    await getDb().execute(sql`truncate table runner_heartbeats`);
    expect((await loadSourcesView(NOW)).runner).toMatchObject({ ageSeconds: null, online: false });
  });

  it("reads per-unit rotation with search edits after the config cache refreshes and leaves cooled-down circuit rows untouched", async () => {
    const sourceFile = path.join(temp.configDir, "sources.yaml");
    const sources = parseDocument(fs.readFileSync(sourceFile, "utf8"));
    sources.setIn(["linkedin", "cascade"], ["linkedin-guest"]);
    sources.setIn(["linkedin", "guest", "enabled"], true);
    sources.deleteIn(["linkedin", "guest", "markets"]);
    sources.setIn(["sources", "indeed", "enabled"], true);
    sources.deleteIn(["sources", "indeed", "markets"]);
    sources.setIn(["collect", "query_rotation"], true);
    sources.setIn(["collect", "max_catch_up_hours"], 168);
    sources.setIn(["collect", "catch_up_tolerance_hours"], 6);
    fs.writeFileSync(sourceFile, sources.toString());
    const searchFile = path.join(temp.configDir, "search.yaml");
    const search = parseDocument(fs.readFileSync(searchFile, "utf8"));
    search.set("keyword_groups", { targets: ["engineer"] });
    search.set("locations", ["Berlin", "Hamburg"]);
    search.set("remote_scope", "none");
    search.set("window_hours", { morning: 12, evening: 12, weekend: 24 });
    fs.writeFileSync(searchFile, search.toString());
    const queries = buildQueries(reloadConfig("search"), "manual");
    const first = queries[0]!;
    const second = queries[1]!;
    const db = getDb();
    await upsertChannelRows(db, [
      { id: "linkedin-guest", family: "linkedin", kind: "guest", enabled: true },
      { id: "indeed", family: "indeed", kind: "api", enabled: true },
    ]);
    await db.update(schema.channels).set({ circuitState: "open", circuitOpenUntil: minutesAgo(60), health: "down", consecutiveFailures: 3 }).where(sql`id = 'linkedin-guest'`);
    await db.insert(schema.runs).values([
      { channelId: "linkedin-guest", queryHash: first.id, startedAt: minutesAgo(31 * 60), status: "succeeded" },
      { channelId: "indeed", queryHash: first.id, startedAt: minutesAgo(200 * 60), status: "failed" },
      { channelId: "indeed", queryHash: second.id, startedAt: minutesAgo(10 * 60), status: "succeeded" },
    ]);
    const [before] = await db.select().from(schema.channels).where(sql`id = 'linkedin-guest'`);
    const view = await loadSourcesView(NOW);
    expect(view.cascade.rotation).toMatchObject({ sortChannel: "linkedin-guest", queries: 2, neverRun: 1, oldestWaitHours: 31,
      oldestWaiting: { keywordGroup: "targets", location: "Berlin" }, overCap: 0 });
    expect(view.cards.find((card) => card.id === "indeed")?.rotation).toMatchObject({ sortChannel: "indeed", queries: 2, neverRun: 0, oldestWaitHours: 200, overCap: 1 });
    expect(view.cards.find((card) => card.id === "linkedin-guest")).toMatchObject({ circuit: { state: "half_open" } });
    expect(view.cards.find((card) => card.id === "linkedin-guest")?.rotation).toBeUndefined();
    const [after] = await db.select().from(schema.channels).where(sql`id = 'linkedin-guest'`);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ circuitState: "open", health: "down" });

    // Search and rotation settings edits appear after the config cache refreshes.
    search.set("keyword_groups", { targets: ["designer"] });
    fs.writeFileSync(searchFile, search.toString());
    resetConfigCache();
    expect((await loadSourcesView(NOW)).cascade.rotation).toMatchObject({ queries: 2, neverRun: 2, oldestWaitHours: null });
    sources.setIn(["collect", "query_rotation"], false);
    fs.writeFileSync(sourceFile, sources.toString());
    resetConfigCache();
    expect((await loadSourcesView(NOW)).cascade.rotation).toBeUndefined();
  });

  it("works on an empty database", async () => {
    const view = await loadSourcesView(NOW);
    expect(view.latestCycle).toBeNull();
    expect(view.cards.length).toBeGreaterThan(10);
    expect(view.cards.every((c) => c.runs.length === 0 && !c.registered)).toBe(true);
    expect(view.ai.rows).toEqual([]);
    expect(view.paid.usedUsd).toBe(0);
  });
});
