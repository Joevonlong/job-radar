import net from "node:net";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { rootIdForCycle, SAFE_ERROR_CODES } from "@/lib/activity";
import type { ActivityRecorder } from "@/lib/activity/types";
import { ChannelError } from "@/lib/channels/errors";
import { createFixtureChannel, registerFixtureChannel } from "@/lib/channels/fixture";
import { ChannelRegistry } from "@/lib/channels/registry";
import { processNextControlRequest, registerControlHandler, resetControlHandlers } from "@/lib/control";
import { createRunAiHandler } from "@/lib/control/run-ai";
import { runDelegatedSteps } from "@/lib/cycle/delegated";
import { runCycle, type CycleRunResult, type RunCycleOptions } from "@/lib/cycle/run-cycle";
import { CYCLE_STEP_NAMES, registerCycleStep, resetCycleSteps } from "@/lib/cycle/steps";
import { createConnection } from "@/lib/db/client";
import { saveCircuitState, upsertChannelRows } from "@/lib/db/repos/channels";
import { insertControlRequest } from "@/lib/db/repos/control-requests";
import { listRunsForCycle } from "@/lib/db/repos/runs";
import { activitySpans, rawPostings, runs } from "@/lib/db/schema";
import { createNotifyStep } from "@/lib/notify/step";
import { collectOf, quietLogger, settings } from "../cycle/helpers";
import { notifyConfig } from "../notify/helpers";
import { integrationActivitySettings } from "./activity-helpers";
import { activityRows, activityText, HOOK_NOW, hookConfig, hookRecorder, isolateHookSteps, observeFinishes, resetHookTables } from "./activity-hook-helpers";

let connection: ReturnType<typeof createConnection>;
let activity: ActivityRecorder;
beforeAll(() => { connection = createConnection(inject("testDatabaseUrl")); });
beforeEach(async () => {
  await resetHookTables(connection.db);
  isolateHookSteps();
  activity = hookRecorder(connection.db);
});
afterEach(async () => { await activity.close(); resetCycleSteps(); resetControlHandlers(); vi.restoreAllMocks(); });
afterAll(async () => { await connection.sql.end(); });

function fixtureRegistry() {
  const registry = new ChannelRegistry();
  registerFixtureChannel(registry, { postings: [{
    id: "sample", title: "Engineer", company: "Example", city: null, country: null, remote: false,
    description: "Build test systems", url: "https://jobs.example.test/sample", posted_at: null,
  }] });
  return registry;
}
function run(registry = fixtureRegistry(), options: RunCycleOptions = {}) {
  return runCycle("manual", {
    db: connection.db, activity, registry, config: hookConfig(), cascades: [], logger: quietLogger,
    now: () => HOOK_NOW, sleep: async () => {}, fetch: async () => { throw new Error("unexpected network"); }, ...options,
  });
}

describe("cycle activity persistence", () => {
  it.each([undefined, 36])("records the backfill window only when set: backfillHours=%s", async (backfillHours) => {
    const outcome = await run(undefined, backfillHours === undefined ? {} : { backfillHours });
    expect(outcome.status).toBe("succeeded");
    await activity.flush();
    const { spans, events } = await activityRows(connection.db);
    const rootId = rootIdForCycle(outcome.cycleId!);
    expect(spans.find((span) => span.id === rootId)).toMatchObject({ name: "cycle", parentId: null, status: "ok" });
    const notes = events.filter((event) => event.code === "backfill");
    if (backfillHours === undefined) expect(notes).toEqual([]);
    else {
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ rootId, spanId: rootId, level: "info" });
      expect(notes[0]!.params).toEqual({ hours: backfillHours });
    }
  });

  it.each(["quota_guard", "no_provider_available", "unknown private reason"])("records whole-step skips in the runner with safe reasons: %s", async (skipped) => {
    const result = { subtasks: [], skipped };
    registerCycleStep("ai", async () => ({ result }));
    registerCycleStep("notify", createNotifyStep({ loadNotifyConfig: () => notifyConfig((raw) => { raw.telegram.enabled = false; }) }));
    const outcome = await run();
    expect(outcome.status).toBe("succeeded");
    expect(outcome.results.ai).toEqual(result);
    expect(outcome.summary.steps.find((s) => s.name === "ai")).toMatchObject({ status: "ok", result });
    expect(outcome.summary.steps.find((s) => s.name === "notify")).toMatchObject({ status: "ok", result: { skipped: "disabled" } });
    await activity.flush();
    const { spans } = await activityRows(connection.db);
    expect(spans.find((s) => s.name === "step.ai")).toMatchObject({ status: "skipped", reasonCode: skipped.startsWith("unknown") ? "other" : skipped });
    expect(spans.find((s) => s.name === "step.notify")).toMatchObject({ status: "skipped", reasonCode: "disabled" });
    expect(spans.every((s) => s.status !== "running" && s.finishedAt !== null)).toBe(true);
    expect(await activityText(connection.db)).not.toContain("private reason");
  });

  it.each([
    ["quota_guard", "no_provider_available"],
    ["no_provider_available", "quota_guard"],
    ["unknown private main", "unknown private late"],
  ])("records delegated main and late skips without changing the summary: %s / %s", async (mainReason, lateReason) => {
    registerCycleStep("ai", async () => ({ result: { delegated: true } }));
    registerCycleStep("notify", async () => ({ result: { delegated: true } }));
    const outcome = await run();
    const worker = hookRecorder(connection.db, { process: "ai-worker" });
    const result = { subtasks: [], skipped: mainReason };
    try {
      const delegated = await runDelegatedSteps({
        db: connection.db, activity: worker.attachCycle(outcome.cycleId!), cycleId: outcome.cycleId!,
        signal: new AbortController().signal, logger: quietLogger, registry: new ChannelRegistry(),
        steps: {
          ai: async () => ({ result }),
          notify: createNotifyStep({ loadNotifyConfig: () => notifyConfig((raw) => { raw.telegram.enabled = false; }) }),
          late: async () => ({ result: { subtasks: [], skipped: lateReason } }),
        },
      });
      expect(delegated?.steps).toMatchObject([
        { name: "ai", status: "ok", result, lateAiComplete: true },
        { name: "notify", status: "ok", result: { skipped: "disabled" } },
      ]);
      await activity.flush();
      await worker.flush();
      const { spans } = await activityRows(connection.db);
      const workerSteps = spans.filter((s) => s.process === "ai-worker");
      expect(workerSteps).toHaveLength(3);
      for (const [name, reason] of [["step.ai", mainReason], ["step.ai_late", lateReason], ["step.notify", "disabled"]]) {
        expect(workerSteps.find((s) => s.name === name)).toMatchObject({ status: "skipped", reasonCode: reason!.startsWith("unknown") ? "other" : reason });
      }
      expect(workerSteps.every((s) => s.finishedAt !== null && s.rootId === rootIdForCycle(outcome.cycleId!))).toBe(true);
      expect(await activityText(connection.db)).not.toContain("private");
    } finally { await worker.close(); }
  });

  it("persists one terminal root, seven terminal steps and query children with complete collect progress", async () => {
    const observed = observeFinishes(activity);
    const result = await run(undefined, { activity: observed.recorder });
    expect(result.status).toBe("succeeded");
    await activity.flush();
    const { spans } = await activityRows(connection.db);
    const rootId = rootIdForCycle(result.cycleId!);
    expect(spans).toHaveLength(11);
    expect(spans.find((s) => s.id === rootId)).toMatchObject({ scope: "cycle", name: "cycle", cycleId: result.cycleId, parentId: null, rootId, status: "ok" });
    const steps = spans.filter((s) => s.parentId === rootId);
    expect(steps.map((s) => s.name).sort()).toEqual(CYCLE_STEP_NAMES.map((name) => `step.${name}`).sort());
    const collect = steps.find((s) => s.name === "step.collect")!;
    const queries = spans.filter((s) => s.name === "collect.query");
    const businessRuns = await listRunsForCycle(connection.db, result.cycleId!);
    expect(queries).toHaveLength(3);
    expect(collectOf(result).queries).toBe(queries.length);
    expect(queries.every((s) => s.parentId === collect.id && s.rootId === rootId && s.cycleId === result.cycleId)).toBe(true);
    expect(queries.map((s) => s.runId).sort()).toEqual(businessRuns.map((r) => r.id).sort());
    for (const query of queries) {
      const businessRun = businessRuns.find((r) => r.id === query.runId)!;
      expect(query).toMatchObject({ channelId: businessRun.channelId, queryId: businessRun.queryHash });
    }
    expect(collect).toMatchObject({ progressDone: 3, progressTotal: 3 });
    expect(spans.every((s) => s.status === "ok" && s.finishedAt !== null)).toBe(true);
    expect([...observed.finishes.values()]).toEqual(Array(11).fill(1));
    // Replaying a flush cannot produce a second terminal record or alter the first finish.
    await activity.flush();
    expect((await activityRows(connection.db)).spans).toEqual(spans);
  });

  it.each(["budget_exceeded", "circuit_open", "mixed"] as const)("records three cascade skips with %s reasons and just one business run", async (reason) => {
    const registry = new ChannelRegistry();
    const ids = ["cascade-a", "cascade-b"];
    const reasons = Object.fromEntries(ids.map((id, index) => [id, reason === "mixed" ? index === 0 ? "budget_exceeded" : "circuit_open" : reason]));
    for (const id of ids) {
      registerFixtureChannel(registry, { id, family: "linkedin", postings: [], costPerRecordUsd: 1,
        settings: { monthlyBudgetUsd: reasons[id] === "budget_exceeded" ? 0 : 10, freeRecordsPerMonth: 0 } });
    }
    await upsertChannelRows(connection.db, ids.map((id) => ({ id, family: "linkedin", kind: "manual", enabled: true })));
    for (const id of ids) if (reasons[id] === "circuit_open") {
      await saveCircuitState(connection.db, id, { circuitState: "open", consecutiveFailures: 3,
        circuitOpenUntil: new Date(HOOK_NOW.getTime() + 86_400_000), lastErrorCode: "blocked", lastSuccessAt: null, health: "down" });
    }
    const result = await run(registry, { cascades: [{ family: "linkedin", order: ids }] });
    await activity.flush();
    const { spans, events } = await activityRows(connection.db);
    const queries = spans.filter((s) => s.name === "collect.query");
    expect(queries).toHaveLength(3);
    expect(queries.every((s) => s.status === "skipped" && s.reasonCode === reason && s.finishedAt !== null)).toBe(true);
    expect(new Set(queries.map((s) => s.queryId)).size).toBe(3);
    const businessRuns = await listRunsForCycle(connection.db, result.cycleId!);
    expect(businessRuns).toHaveLength(1);
    expect(businessRuns[0]).toMatchObject({ status: "skipped", queryHash: expect.any(String) });
    const linked = queries.filter((s) => s.runId !== null);
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ runId: businessRuns[0]!.id, queryId: businessRuns[0]!.queryHash });
    const notes = events.filter((e) => e.code === "cascade_reasons");
    expect(notes).toHaveLength(3);
    for (const query of queries) expect(notes.find((e) => e.spanId === query.id)?.params).toEqual(reasons);
    expect(spans.find((s) => s.name === "step.collect")).toMatchObject({ progressDone: 3, progressTotal: 3 });
    // This checkout has no listQueryRows API. Exercise its underlying span/run LEFT JOIN contract directly.
    const rows = await connection.db.execute<{ run_id: number | null; fetched: number | null; new_count: number | null }>(sql`
      select s.run_id::int as run_id, r.fetched, r.new_count from activity_spans s left join runs r on r.id = s.run_id
      where s.root_id = ${rootIdForCycle(result.cycleId!)} and s.name = 'collect.query' order by s.run_id nulls last`);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.run_id).toBe(businessRuns[0]!.id);
    expect(rows.slice(1).map((r) => [r.run_id, r.fetched, r.new_count])).toEqual([[null, null, null], [null, null, null]]);
  });

  it("interrupts an aborted root and skips unfinished steps without leaving running spans", async () => {
    const abort = new AbortController();
    const registry = new ChannelRegistry();
    const fixture = createFixtureChannel({ postings: [] });
    registry.register({ ...fixture, async collect() { abort.abort(); throw new DOMException("stopped", "AbortError"); } }, { settings: settings() });
    const result = await run(registry, { signal: abort.signal });
    expect(result.summary.aborted).toBe(true);
    await activity.flush();
    const { spans } = await activityRows(connection.db);
    expect(spans.find((s) => s.name === "cycle")).toMatchObject({ status: "interrupted", reasonCode: "cycle_cancelled" });
    const pending = spans.filter((s) => s.name.startsWith("step.") && s.name !== "step.collect");
    expect(pending).toHaveLength(6);
    expect(pending.every((s) => s.status === "skipped" && s.reasonCode === "cycle_cancelled")).toBe(true);
    expect(spans.every((s) => s.status !== "running" && s.finishedAt !== null)).toBe(true);
  });

  it("fails a throwing collect step and its root with a safe reason and no running spans", async () => {
    registerCycleStep("collect", async () => { throw new Error("private failure SECRET123"); });
    expect((await run()).status).toBe("failed");
    await activity.flush();
    const { spans } = await activityRows(connection.db);
    expect(spans.find((s) => s.name === "step.collect")).toMatchObject({ status: "failed", reasonCode: "error" });
    expect(spans.find((s) => s.name === "cycle")?.status).toBe("failed");
    expect(spans.every((s) => s.status !== "running" && s.finishedAt !== null)).toBe(true);
    for (const span of spans) if (span.reasonCode !== null) expect(SAFE_ERROR_CODES).toContain(span.reasonCode);
    expect(await activityText(connection.db)).not.toContain("SECRET123");
  });

  it("joins delegated steps and run_ai to the deterministic cycle root across recorders and gives interactive work its own root", async () => {
    registerCycleStep("ai", async () => ({ result: { delegated: true } }));
    registerCycleStep("notify", async () => ({ result: { delegated: true } }));
    const result = await run();
    await activity.flush();
    const rootId = rootIdForCycle(result.cycleId!);
    const worker = hookRecorder(connection.db, { process: "ai-worker" });
    const steps = { ai: async () => ({ result: { subtasks: [] } }), notify: async () => ({ result: { jobs: { pushed: 0 } } }) };
    try {
      expect(await runDelegatedSteps({ db: connection.db, activity: worker.attachCycle(result.cycleId!), cycleId: result.cycleId!,
        signal: new AbortController().signal, logger: quietLogger, registry: new ChannelRegistry(), steps })).not.toBeNull();
      registerControlHandler("run_ai", createRunAiHandler({ steps, registry: new ChannelRegistry() }));
      const request = await insertControlRequest(connection.db, { kind: "run_ai", payload: { cycleId: result.cycleId } });
      const poll = { db: connection.db, activity: worker, signal: new AbortController().signal, logger: quietLogger };
      expect((await processNextControlRequest(poll))?.status).toBe("done");
      registerControlHandler("translate_job", async () => ({ status: "done", result: {} }));
      const interactive = await insertControlRequest(connection.db, { kind: "translate_job", payload: { jobId: 77 } });
      await processNextControlRequest(poll);
      await worker.flush();
      const { spans } = await activityRows(connection.db);
      expect(spans.filter((s) => s.name === "cycle")).toHaveLength(1);
      expect(spans.find((s) => s.id === rootId)).toMatchObject({ process: "runner", status: "ok" });
      const attempt = spans.find((s) => s.controlRequestId === request.id)!;
      expect(attempt).toMatchObject({ name: "request.run_ai", rootId, parentId: rootId, cycleId: result.cycleId, status: "ok" });
      expect(spans.filter((s) => s.parentId === attempt.id).map((s) => s.name)).toContain("step.notify");
      expect(spans.filter((s) => s.process === "ai-worker" && s.name.startsWith("step.")).every((s) => s.rootId === rootId)).toBe(true);
      const own = spans.find((s) => s.controlRequestId === interactive.id)!;
      expect(own).toMatchObject({ name: "request.translate_job", scope: "request", parentId: null, status: "ok", jobId: 77 });
      expect(own.rootId).toBe(own.id);
      expect(own.rootId).not.toBe(rootId);
      expect(spans.every((s) => s.status !== "running")).toBe(true);
    } finally { await worker.close(); }
  });

  it("writes no activity or business rows for a dry run even with a real enabled recorder", async () => {
    expect((await run(undefined, { dryRun: true })).cycleId).toBeNull();
    await activity.flush();
    expect(await activityRows(connection.db)).toEqual({ spans: [], events: [] });
    expect(await connection.db.select().from(runs)).toHaveLength(0);
    expect(await connection.db.select().from(rawPostings)).toHaveLength(0);
  });

  it("keeps cycle results identical with a healthy, unreachable, overflowing or throwing writer within the flush deadline", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const url = new URL(inject("testDatabaseUrl")); url.hostname = "127.0.0.1"; url.port = String(address.port);
    const unreachable = createConnection(url.toString(), { connectTimeoutSeconds: 1 });
    const settings = integrationActivitySettings();
    settings.writer.queue_max = 1;
    settings.writer.batch_size = 1;
    const failedWrite = vi.fn(async () => { throw new Error("injected write failure"); });
    const warn = vi.fn();
    const unreachableWarn = vi.fn();
    const recorders = [activity, hookRecorder(unreachable.db, { warn: unreachableWarn }), hookRecorder(connection.db, { loadSettings: () => settings }), hookRecorder(connection.db, { writeBatch: failedWrite, warn })];
    const snapshots: unknown[] = [];
    const durations: number[] = [];
    const summarize = async (result: CycleRunResult) => ({
      status: result.status, counts: collectOf(result),
      steps: result.summary.steps.map(({ name, status }) => ({ name, status })),
      runs: (await listRunsForCycle(connection.db, result.cycleId!)).map(({ status, fetched, newCount, errorCode, interrupted, cost, usageUnits }) => ({ status, fetched, newCount, errorCode, interrupted, cost, usageUnits })),
    });
    try {
      for (const [index, recorder] of recorders.entries()) {
        await resetHookTables(connection.db);
        const started = performance.now();
        const result = await run(undefined, { activity: recorder });
        const beforeFlush = performance.now();
        await expect(recorder.flush()).resolves.toBeUndefined();
        expect(performance.now() - beforeFlush).toBeLessThanOrEqual(settings.writer.flush_deadline_ms);
        durations.push(performance.now() - started);
        snapshots.push(await summarize(result));
        const persisted = await activityRows(connection.db);
        if (index === 0) expect(persisted.spans).toHaveLength(11);
        if (index === 1 || index === 3) expect(persisted).toEqual({ spans: [], events: [] });
        if (index === 2) {
          expect(persisted.spans).toHaveLength(1);
          expect(persisted.spans[0]).toMatchObject({ name: "cycle", status: "ok" });
        }
      }
      for (const snapshot of snapshots.slice(1)) expect(snapshot).toEqual(snapshots[0]);
      for (const duration of durations.slice(1)) expect(duration - durations[0]!).toBeLessThanOrEqual(settings.writer.flush_deadline_ms);
      expect(failedWrite).toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
      expect(unreachableWarn).toHaveBeenCalled();
    } finally {
      for (const recorder of recorders.slice(1)) await recorder.close();
      await unreachable.sql.end({ timeout: 0 });
    }
  });

  it("keeps sensitive posting fields and failing-channel error text out of every activity column", async () => {
    const samples = ["https://x.example/?token=SECRET123", "private@example.test", "channel failure SECRET123", "Confidential posting description sample"];
    const registry = new ChannelRegistry();
    registerFixtureChannel(registry, { id: "good", postings: [{ id: "private-posting", title: "Engineer", company: samples[1]!,
      city: null, country: null, remote: false, url: samples[0]!, description: samples[3]!, posted_at: null }] });
    const failing = createFixtureChannel({ id: "bad", postings: [] });
    registry.register({ ...failing, async collect() { throw new ChannelError("auth_expired", samples[2]!); } }, { settings: settings() });
    const result = await run(registry);
    expect(result.status).toBe("partial");
    expect(collectOf(result).channels.good?.fetched).toBe(3);
    expect((await listRunsForCycle(connection.db, result.cycleId!)).some((r) => r.error?.includes(samples[2]!))).toBe(true);
    expect((await connection.db.select().from(rawPostings))[0]?.payloadJson).toMatchObject({ url: samples[0], company: samples[1], description: samples[3] });
    await activity.flush();
    const { spans } = await activityRows(connection.db);
    expect(spans.filter((s) => s.name === "collect.query").length).toBeGreaterThan(3);
    const text = await activityText(connection.db);
    for (const sample of [...samples, "SECRET123"]) expect(text).not.toContain(sample);
    expect(await connection.db.select().from(activitySpans)).not.toHaveLength(0);
  });
});
