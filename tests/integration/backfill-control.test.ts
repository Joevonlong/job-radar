import fs from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { parseDocument } from "yaml";

import { registerFixtureChannel } from "@/lib/channels/fixture";
import { buildQueries } from "@/lib/channels/query";
import { defaultRegistry } from "@/lib/channels/registry";
import { loadConfig, resetConfigCache } from "@/lib/config";
import { runCycleHandler } from "@/lib/control/handlers";
import { requestRunCycle } from "@/lib/control/service";
import { withCycleLock } from "@/lib/cycle/lock";
import { resetCycleSteps } from "@/lib/cycle/steps";
import { claimNextControlRequest, closeDb, createCycle, finishCycle, getControlRequest, getCycle, getDb, insertControlRequest, listControlRequests, listRunsForCycle, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { upsertChannelRows } from "@/lib/db/repos/channels";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { pinnedSearch, quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");
let temp: TempConfig;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});
beforeEach(() => {
  temp = makeTempConfig();
  setLimit(72);
});
afterEach(() => {
  defaultRegistry.unregister("fixture");
  resetCycleSteps();
  temp.cleanup();
});
afterAll(async () => { await closeDb(); });

function setLimit(hours: number): void {
  const file = path.join(temp.configDir, "sources.yaml");
  const doc = parseDocument(fs.readFileSync(file, "utf8"));
  doc.setIn(["collect", "max_backfill_hours"], hours);
  doc.setIn(["collect", "max_catch_up_hours"], 168);
  doc.setIn(["collect", "catch_up_tolerance_hours"], 6);
  doc.setIn(["collect", "query_rotation"], false);
  fs.writeFileSync(file, doc.toString());
}

const context = () => ({ db: getDb(), signal: new AbortController().signal, logger: quietLogger });

describe("backfill request admission", () => {
  it("rejects a backfill over the configured limit without inserting a request", async () => {
    expect(await requestRunCycle({ backfillHours: 73 })).toMatchObject({ status: "error", error: "backfillOverLimit", maxBackfillHours: 72 });
    expect(await listControlRequests(getDb(), 10)).toEqual([]);
  });

  it("stores the backfill payload, refuses another backfill and lets a plain request join it", async () => {
    const payload = { backfillHours: 36, channelIds: ["indeed"] };
    const queued = await requestRunCycle(payload);
    expect(queued).toMatchObject({ status: "queued", existing: false });
    if (queued.status !== "queued") throw new Error("expected a queued request");
    expect(await getControlRequest(getDb(), queued.request)).toMatchObject({ status: "pending", payload });
    expect(await requestRunCycle(payload)).toMatchObject({ status: "error", error: "cycleBusy" });
    expect(await requestRunCycle({ channelIds: ["indeed"] })).toMatchObject({ status: "queued", existing: true, request: queued.request });
    expect(await listControlRequests(getDb(), 10)).toHaveLength(1);
  });

  it.each(["pending", "running"] as const)("refuses a backfill while a plain request is %s, even for other channels", async (status) => {
    const open = await insertControlRequest(getDb(), { kind: "run_cycle", payload: { channelIds: ["greenhouse"] } });
    if (status === "running") expect((await claimNextControlRequest(getDb()))?.id).toBe(open.id);
    expect((await getControlRequest(getDb(), open.id))?.status).toBe(status);
    expect(await requestRunCycle({ backfillHours: 36, channelIds: ["indeed"] })).toMatchObject({ status: "error", error: "cycleBusy" });
    expect(await listControlRequests(getDb(), 10)).toHaveLength(1);
  });

  it("also refuses a backfill while another backfill is running", async () => {
    await insertControlRequest(getDb(), { kind: "run_cycle", payload: { backfillHours: 36 } });
    await claimNextControlRequest(getDb());
    expect(await requestRunCycle({ backfillHours: 48 })).toMatchObject({ status: "error", error: "cycleBusy" });
    expect(await listControlRequests(getDb(), 10)).toHaveLength(1);
  });

  it("uses the existing databaseUnavailable result when the config cannot be read", async () => {
    fs.writeFileSync(path.join(temp.configDir, "sources.yaml"), "collect: [invalid");
    resetConfigCache();
    expect(await requestRunCycle({ backfillHours: 36 })).toMatchObject({ status: "error", error: "databaseUnavailable" });
    expect(await listControlRequests(getDb(), 10)).toEqual([]);
  });
});

describe("backfill execution", () => {
  it("refreshes the limit after queueing and rejects before creating cycles or runs", async () => {
    const queued = await requestRunCycle({ backfillHours: 36 });
    expect(queued.status).toBe("queued");
    expect(loadConfig("channels").collect.max_backfill_hours).toBe(72);
    setLimit(12); // leave the old value cached, as in a long-lived runner
    const request = await claimNextControlRequest(getDb());
    if (!request) throw new Error("expected a claimed request");
    expect(await runCycleHandler(request, context())).toEqual({ status: "failed", result: { error: "backfill_over_limit", backfillHours: 36, maxBackfillHours: 12 } });
    expect(await getDb().select().from(schema.cycles)).toEqual([]);
    expect(await getDb().select().from(schema.runs)).toEqual([]);
  });

  it("persists the backfill summary and each query's maximum of backfill, catch-up and base", async () => {
    const search = {
      ...pinnedSearch(), keyword_groups: { a: ["alpha"], b: ["beta"], c: ["gamma"] },
      locations: ["Test City"], remote_scope: "none" as const,
      window_hours: { morning: 24, evening: 24, weekend: 24 },
    };
    const file = path.join(temp.configDir, "search.yaml");
    const doc = parseDocument(fs.readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(search)) doc.set(key, doc.createNode(value));
    fs.writeFileSync(file, doc.toString());
    const fixture = registerFixtureChannel(defaultRegistry, { postings: [] });
    const queries = buildQueries(search, "manual");
    await upsertChannelRows(getDb(), [{ id: fixture.id, family: fixture.family, kind: fixture.kind, enabled: true }]);
    // The handler owns its real clock: this anchor is safely within the 50th hour, avoiding a ceil boundary.
    const old = new Date(Date.now() - 49.5 * 3_600_000);
    await getDb().insert(schema.runs).values({ channelId: fixture.id, queryHash: queries[0]!.id, status: "succeeded", startedAt: old, finishedAt: old });
    const request = await insertControlRequest(getDb(), { kind: "run_cycle", payload: { backfillHours: 36, channelIds: [fixture.id] } });
    const outcome = await runCycleHandler(request, context());
    expect(outcome).toMatchObject({ status: "done", result: { backfillHours: 36, cycleStatus: "succeeded" } });
    const cycleId = outcome.result.cycleId;
    if (typeof cycleId !== "number") throw new Error("expected a persisted cycle");
    expect((await getCycle(getDb(), cycleId))?.summaryJson).toMatchObject({ version: 1, backfillHours: 36 });
    const rows = await listRunsForCycle(getDb(), cycleId);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => [row.queryHash, row.windowHours, row.windowExtended])).toEqual(queries.map((query, index) => [query.id, index === 0 ? 50 : 36, true]));
    expect(fixture.seen.map((query) => query.windowHours)).toEqual([50, 36, 36]);
  });

  it("fails rather than joining a covering cycle and retains both cycle ids", async () => {
    let ready: (id: number) => void = () => {};
    const started = new Promise<number>((resolve) => { ready = resolve; });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = withCycleLock(getDb(), "try", async (holder) => {
      const cycle = await createCycle(getDb(), { kind: "weekday_morning", summary: { channelIds: null, lockPid: holder.pid } });
      ready(cycle.id);
      await gate;
      await finishCycle(getDb(), cycle.id, { status: "succeeded" });
    });
    try {
      const coveringId = await Promise.race([started, held.then(() => { throw new Error("covering cycle did not hold the lock"); })]);
      const request = await insertControlRequest(getDb(), { kind: "run_cycle", payload: { backfillHours: 36 } });
      const outcome = await runCycleHandler(request, context());
      expect(outcome).toMatchObject({ status: "failed", result: { error: "another_cycle_running", backfillHours: 36, coveredBy: coveringId, cycleStatus: "skipped" } });
      const skippedId = outcome.result.cycleId;
      if (typeof skippedId !== "number") throw new Error("expected a skipped cycle row");
      expect(skippedId).not.toBe(coveringId);
      expect((await getCycle(getDb(), skippedId))?.summaryJson).toMatchObject({ version: 1, backfillHours: 36, coveredBy: coveringId });
      expect(await listRunsForCycle(getDb(), skippedId)).toEqual([]);
    } finally {
      release();
      expect((await held).acquired).toBe(true);
    }
  });
});
