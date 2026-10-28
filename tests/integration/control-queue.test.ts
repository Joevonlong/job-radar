import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { loadConfig, type AiConfig } from "@/lib/config";
import { aiWorkerRequestKinds } from "@/lib/control";
import { loadQueueView } from "@/lib/control/queue-view";
import { loadControlRequestView } from "@/lib/control/request-view";
import { claimNextControlRequest, closeDb, createCycle, describeControlQueue, finishCycle, getDb, insertControlRequest, writeHeartbeat, type ControlRequest } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

import { makeTempConfig, type TempConfig } from "../config/helpers";

const url = inject("testDatabaseUrl");
const db = () => getDb();
const KINDS = aiWorkerRequestKinds("host");
const position = (request: ControlRequest) => describeControlQueue(db(), { requestId: request.id, kinds: KINDS });

let temp: TempConfig;
beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});
beforeEach(() => {
  temp = makeTempConfig();
});
afterEach(() => temp.cleanup());
afterAll(async () => {
  await closeDb();
});

/** A run_ai request for a cycle that has finished (claimable) or still runs (held back). */
async function runAi(finished: boolean): Promise<ControlRequest> {
  const cycle = await createCycle(db(), { kind: "weekday_morning" });
  if (finished) await finishCycle(db(), cycle.id, { status: "succeeded" });
  return insertControlRequest(db(), { kind: "run_ai", payload: { cycleId: cycle.id } });
}

describe("describeControlQueue: the queue position follows the claim order", () => {
  it("run_ai (cycle finished), score_jobs and two translations: 0, 1, 2 and 3 ahead before anything is claimed", async () => {
    const requests = [await runAi(true), await insertControlRequest(db(), { kind: "score_jobs", payload: { backlog: true } })];
    requests.push(await insertControlRequest(db(), { kind: "translate_job", payload: { jobId: 1, force: false } }));
    requests.push(await insertControlRequest(db(), { kind: "translate_job", payload: { jobId: 2, force: false } }));
    const ahead = await Promise.all(requests.map(async (request) => (await position(request))?.ahead));
    expect(ahead).toEqual([0, 1, 2, 3]);
    // and the claim takes them in exactly that order
    for (const request of requests) expect((await claimNextControlRequest(db(), KINDS))?.id).toBe(request.id);
  });

  it("a run_ai whose cycle still runs is not counted ahead (the claim skips it too)", async () => {
    await runAi(false);
    const translate = await insertControlRequest(db(), { kind: "translate_job", payload: { jobId: 1, force: false } });
    expect(await position(translate)).toMatchObject({ ahead: 0, running: null });
    expect((await claimNextControlRequest(db(), KINDS))?.id).toBe(translate.id);
  });

  it("a kind of the other process is not counted ahead", async () => {
    await insertControlRequest(db(), { kind: "run_cycle" });
    const translate = await insertControlRequest(db(), { kind: "translate_job", payload: { jobId: 1, force: false } });
    expect((await position(translate))?.ahead).toBe(0);
  });

  it("once run_ai is claimed, a waiting translation sees it running, with its start", async () => {
    const run = await runAi(true);
    const translate = await insertControlRequest(db(), { kind: "translate_job", payload: { jobId: 1, force: false } });
    const claimed = await claimNextControlRequest(db(), KINDS);
    expect(claimed?.id).toBe(run.id);
    const seen = await position(translate);
    expect(seen).toMatchObject({ ahead: 0, running: { kind: "run_ai" }, startedAt: null });
    expect(seen?.running?.since.getTime()).toBe(claimed?.startedAt?.getTime());
  });

  it("a request that runs itself: running is another one (or none), startedAt is its own", async () => {
    const translate = await insertControlRequest(db(), { kind: "translate_job", payload: { jobId: 1, force: false } });
    const claimed = await claimNextControlRequest(db(), KINDS);
    expect(claimed?.id).toBe(translate.id);
    const seen = await position(translate);
    expect(seen?.running).toBeNull();
    expect(seen?.startedAt?.getTime()).toBe(claimed?.startedAt?.getTime());
  });

  it("no such request: null", async () => {
    expect(await describeControlQueue(db(), { requestId: 999_999, kinds: KINDS })).toBeNull();
  });
});

describe("loadQueueView", () => {
  const host = (): AiConfig => ({ ...loadConfig("ai"), execution: "host" });

  it("names the claiming process and judges it by its heartbeat; a finished request has no queue", async () => {
    const translate = await insertControlRequest(db(), { kind: "translate_job", payload: { jobId: 1, force: false } });
    expect((await loadQueueView(db(), translate, { ai: host() }))?.worker).toEqual({ process: "ai-worker", online: false, heartbeatAgeSeconds: null });
    await writeHeartbeat(db(), "runner");
    expect((await loadQueueView(db(), translate, { ai: host() }))?.worker.online).toBe(false);
    await writeHeartbeat(db(), "ai-worker");
    expect((await loadQueueView(db(), translate, { ai: host() }))?.worker).toMatchObject({ process: "ai-worker", online: true });
    expect(await loadQueueView(db(), { ...translate, status: "done" }, { ai: host() })).toBeNull();
  });

  it("the trigger buttons' view carries the queue while open, and score_jobs is pollable", async () => {
    const score = await insertControlRequest(db(), { kind: "score_jobs", payload: { jobIds: [1] } });
    await writeHeartbeat(db(), "ai-worker");
    const view = await loadControlRequestView(db(), score.id);
    expect(view).toMatchObject({ kind: "score_jobs", status: "pending", queue: { ahead: 0, running: null, startedAt: null } });
    expect(view?.queue?.worker.process).not.toBeNull();
  });
});
