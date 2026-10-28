import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { createLogger } from "@/lib/channels/logger";
import { loadConfig } from "@/lib/config";
import { registerControlHandler, resetControlHandlers, runControlPoller, startControlLanes } from "@/lib/control";
import { requestBreakdownJob } from "@/lib/control/breakdown-request";
import { aiWorkerRequestKinds } from "@/lib/control/kinds";
import { loadQueueView } from "@/lib/control/queue-view";
import { requestSalaryLookup } from "@/lib/control/salary-request";
import { requestTestAi } from "@/lib/control/service";
import { requestTranslateJob } from "@/lib/control/translate-request";
import { claimNextControlRequest, closeDb, CONTROL_REQUEST_KINDS, controlLaneOf, finishControlRequest, getControlRequest, getDb, insertControlRequest, listControlRequests, schema, type ControlLane, type ControlRequest } from "@/lib/db";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { quietLogger } from "../cycle/helpers";

let temp: TempConfig;
beforeAll(() => { process.env.DATABASE_URL = inject("testDatabaseUrl"); });
beforeEach(() => { temp = makeTempConfig(); });
afterEach(() => { resetControlHandlers(); temp.cleanup(); });
afterAll(() => closeDb());
const db = () => getDb();
const kinds = () => aiWorkerRequestKinds("host");

async function waitForStatus(id: number, status: ControlRequest["status"], timeout = 8000): Promise<ControlRequest> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const row = await getControlRequest(db(), id);
    if (row?.status === status) return row;
    await sleep(20);
  }
  throw new Error(`request did not reach ${status}`);
}

async function job(): Promise<number> {
  const [company] = await db().insert(schema.companies).values({ name: "Example", nameNorm: "example" }).returning();
  const [row] = await db().insert(schema.jobs).values({ companyId: company!.id, title: "Engineer", titleNorm: "engineer", description: "Build reliable systems for customers.", language: "en" }).returning();
  return row!.id;
}

describe("control lane claim semantics", () => {
  it("SQL matches the pure classifier for every kind and origin, and each request belongs to only one lane", async () => {
    const rows: ControlRequest[] = [];
    for (const kind of CONTROL_REQUEST_KINDS) {
      for (const payload of [{}, { origin: "auto" }, { origin: "another" }]) rows.push(await insertControlRequest(db(), { kind, payload }));
    }
    for (const lane of ["interactive", "batch"] as const) {
      const taken: number[] = [];
      for (;;) {
        const row = await claimNextControlRequest(db(), undefined, { lane });
        if (!row) break;
        expect(controlLaneOf(row.kind, row.payload)).toBe(lane);
        taken.push(row.id);
      }
      expect(taken).toEqual(rows.filter((row) => controlLaneOf(row.kind, row.payload) === lane).map((row) => row.id));
    }
    expect(await claimNextControlRequest(db())).toBeNull();
  });

  it("two concurrent claimers take 200 mixed requests exactly once in their own lanes", async () => {
    const rows = await db().insert(schema.controlRequests).values(Array.from({ length: 200 }, (_, i) => ({
      kind: CONTROL_REQUEST_KINDS[i % CONTROL_REQUEST_KINDS.length]!,
      payload: i % 3 === 0 ? { origin: "auto" } : i % 3 === 1 ? {} : { origin: "another" },
    }))).returning();
    const take = async (lane: ControlLane): Promise<number[]> => {
      const ids: number[] = [];
      for (;;) {
        const row = await claimNextControlRequest(db(), undefined, { lane });
        if (!row) return ids;
        expect(controlLaneOf(row.kind, row.payload)).toBe(lane);
        ids.push(row.id);
      }
    };
    const taken = (await Promise.all([take("interactive"), take("batch")])).flat();
    expect(taken).toHaveLength(200);
    expect(new Set(taken).size).toBe(200);
    expect(taken.sort((a, b) => a - b)).toEqual(rows.map((row) => row.id));
  });

  it.each(["host", "container"] as const)("queue views count only the queue actually used under %s", async (execution) => {
    const batch = await insertControlRequest(db(), { kind: "score_jobs", payload: { backlog: true } });
    const auto = await insertControlRequest(db(), { kind: "translate_job", payload: { jobId: 1, origin: "auto" } });
    const first = await insertControlRequest(db(), { kind: "translate_job", payload: { jobId: 2 } });
    const last = await insertControlRequest(db(), { kind: "breakdown_job", payload: { jobId: 3 } });
    const ai = { ...loadConfig("ai"), execution };
    expect((await loadQueueView(db(), last, { ai }))?.ahead).toBe(execution === "host" ? 1 : 3);
    expect((await claimNextControlRequest(db(), kinds(), { lane: "batch" }))?.id).toBe(batch.id);
    const view = await loadQueueView(db(), last, { ai });
    expect(view?.running?.kind ?? null).toBe(execution === "host" ? null : "score_jobs");
    expect((await loadQueueView(db(), auto, { ai }))?.running?.kind).toBe("score_jobs");
    expect((await claimNextControlRequest(db(), kinds(), { lane: "interactive" }))?.id).toBe(first.id);
    expect((await loadQueueView(db(), last, { ai }))?.running?.kind).toBe(execution === "host" ? "translate_job" : "score_jobs");
    const own = await loadQueueView(db(), { ...first, status: "running" }, { ai });
    if (execution === "host") expect(own?.running).toBeNull();
    expect(own?.startedAt).not.toBeNull();
  });
});

describe("automatic translations and user requests", () => {
  it("all four web entry points keep their existing payloads without origin", async () => {
    const jobId = await job();
    expect(await requestTranslateJob(db(), { jobId, force: false, origin: "user" })).toMatchObject({ state: "queued" });
    expect(await requestBreakdownJob(db(), { jobId, force: false, settings: { state: "ok", config: { ...loadConfig("breakdown"), enabled: true } } })).toMatchObject({ state: "queued" });
    const salary = loadConfig("salary");
    expect(await requestSalaryLookup(db(), { jobId, force: false, salary: { ...salary, lookup: { ...salary.lookup, enabled: true } }, ai: loadConfig("ai") })).toMatchObject({ state: "queued" });
    expect(await requestTestAi({ provider: "claude-cli" })).toMatchObject({ status: "queued" });
    const rows = await listControlRequests(db(), 10);
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.kind === "translate_job")?.payload).toEqual({ jobId, force: false });
    expect(rows.find((r) => r.kind === "breakdown_job")?.payload).toEqual({ jobId, force: false });
    expect(rows.find((r) => r.kind === "salary_lookup")?.payload).toEqual({ jobId, force: false, lookupKey: expect.any(String) });
    expect(rows.find((r) => r.kind === "test_ai")?.payload).toEqual({ provider: "claude-cli" });
  });

  it.each([false, true])("a user reuses automatic work, promoting only a pending request (running=%s)", async (running) => {
    const jobId = await job();
    const queued = await requestTranslateJob(db(), { jobId, force: false, origin: "auto" });
    if (queued.state !== "queued") throw new Error("expected queued translation");
    expect(await claimNextControlRequest(db(), kinds(), { lane: "interactive" })).toBeNull();
    if (running) expect((await claimNextControlRequest(db(), kinds(), { lane: "batch" }))?.id).toBe(queued.requestId);
    expect(await requestTranslateJob(db(), { jobId, force: true, origin: "user" })).toEqual({ ...queued, existing: true });
    const row = await getControlRequest(db(), queued.requestId);
    expect(row?.payload).toEqual({ jobId, force: false, ...(running ? { origin: "auto" } : {}) });
    expect(await claimNextControlRequest(db(), kinds(), { lane: "batch" })).toBeNull();
    expect((await claimNextControlRequest(db(), kinds(), { lane: "interactive" }))?.id ?? null).toBe(running ? null : queued.requestId);
  });

  it("promotion racing both claimers never duplicates a request or changes work already claimed", async () => {
    const jobId = await job();
    for (let i = 0; i < 20; i += 1) {
      const queued = await requestTranslateJob(db(), { jobId, force: false, origin: "auto" });
      if (queued.state !== "queued") throw new Error("expected queued translation");
      const [, batch, interactive] = await Promise.all([
        requestTranslateJob(db(), { jobId, force: false, origin: "user" }),
        claimNextControlRequest(db(), kinds(), { lane: "batch" }),
        claimNextControlRequest(db(), kinds(), { lane: "interactive" }),
      ]);
      const later = await claimNextControlRequest(db(), kinds());
      const claims = [batch, interactive, later].filter((r) => r !== null);
      expect(claims.map((r) => r.id)).toEqual([queued.requestId]);
      if (batch) expect((await getControlRequest(db(), batch.id))?.payload).toEqual({ jobId, force: false, origin: "auto" });
      if (interactive) expect(interactive.payload).toEqual({ jobId, force: false });
      await finishControlRequest(db(), queued.requestId, { status: "done" });
    }
  });
});

describe("independent control pollers", () => {
  // One real second represents ten minutes: the batch handler occupies an hour of simulated work.
  it.each([false, true])("translation during a six-second batch; split lanes=%s", async (split) => {
    registerControlHandler("run_ai", async () => { await sleep(6000); return { status: "done", result: {} }; });
    registerControlHandler("translate_job", async () => { await sleep(100); return { status: "done", result: {} }; });
    const batch = await insertControlRequest(db(), { kind: "run_ai" });
    const abort = new AbortController();
    const options = { db: db(), signal: abort.signal, logger: quietLogger, kinds, pollSeconds: () => 1 };
    const poller = split ? startControlLanes(options) : runControlPoller({ ...options, lane: "all" });
    try {
      await waitForStatus(batch.id, "running");
      const clicked = Date.now();
      const translation = await insertControlRequest(db(), { kind: "translate_job", payload: { jobId: 1 } });
      const done = await waitForStatus(translation.id, "done");
      const waited = Date.now() - clicked;
      if (split) {
        expect(waited).toBeLessThan(2500);
        expect((await getControlRequest(db(), batch.id))?.status).toBe("running");
      } else {
        expect(waited).toBeGreaterThan(5500);
        const previous = await getControlRequest(db(), batch.id);
        expect(done.startedAt!.getTime()).toBeGreaterThanOrEqual(previous!.finishedAt!.getTime());
      }
    } finally {
      abort.abort();
      await poller;
    }
  });

  it("a throwing interactive handler leaves batch work running, and both logs carry their lane", async () => {
    const loggedLanes: unknown[] = [];
    const logger = createLogger({ sink: (record) => { loggedLanes.push(record.fields.lane); } });
    registerControlHandler("run_ai", async () => { await sleep(150); return { status: "done", result: {} }; });
    registerControlHandler("translate_job", async () => { throw new Error("interactive failure"); });
    const batch = await insertControlRequest(db(), { kind: "run_ai" });
    const interactive = await insertControlRequest(db(), { kind: "translate_job" });
    const abort = new AbortController();
    const poller = startControlLanes({ db: db(), signal: abort.signal, logger, kinds, pollSeconds: () => 1 });
    try {
      expect(await waitForStatus(interactive.id, "failed")).toMatchObject({ result: { error: "handler_error" } });
      await waitForStatus(batch.id, "done");
      for (const lane of ["interactive", "batch"]) expect(loggedLanes).toContain(lane);
    } finally { abort.abort(); await poller; }
  });
});
