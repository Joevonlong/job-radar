import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import {
  closeDb,
  createCycle,
  createRun,
  finishControlRequest,
  finishCycle,
  finishRun,
  getDb,
  getShellCycleStatus,
  insertControlRequest,
  claimNextControlRequest,
  saveCircuitState,
  schema,
  setApplicationStatus,
  upsertChannelRows,
  writeHeartbeat,
} from "@/lib/db";
import { addFavorite } from "@/lib/db/repos/favorites";
import { getOrCreateCompany } from "@/lib/db/repos/companies";
import { insertJob } from "@/lib/db/repos/jobs";
import { runMigrations } from "@/lib/db/migrate";
import { loadShellStatus } from "@/lib/shell/status";

const url = inject("testDatabaseUrl");
// Wed 2026-10-07 06:00 Berlin: the next scheduled slot comes from the shipped schedule.yaml
const NOW = new Date("2026-10-07T04:00:00Z");

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

beforeEach(async () => {
  await getDb().execute(sql`truncate table control_requests, runtime_state, runner_heartbeats, scores, jobs, companies, runs, cycles, channels, profile_snapshots restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
});

async function channels() {
  await upsertChannelRows(getDb(), [
    { id: "greenhouse", family: "ats", kind: "ats", enabled: true },
    { id: "lever", family: "ats", kind: "ats", enabled: true },
    { id: "xing", family: "xing", kind: "api", enabled: true },
    { id: "indeed", family: "indeed", kind: "api", enabled: true },
  ]);
}

describe("the sidebar's cycle status", () => {
  it("is empty before the first cycle and idle", async () => {
    expect(await getShellCycleStatus(getDb())).toEqual({ cycle: null, sources: null, ai: null });
    const status = await loadShellStatus(getDb(), NOW);
    expect(status).toMatchObject({ state: "idle", cycle: null, sources: null, progress: null });
    expect(status.next).not.toBeNull();
  });

  it("idle: counts the channels of the newest finished cycle by outcome (ok / failed / circuit open)", async () => {
    const db = getDb();
    await channels();
    const cycle = await createCycle(db, { kind: "weekday_evening" });
    for (const [channelId, status] of [["greenhouse", "succeeded"], ["lever", "succeeded"], ["xing", "failed"], ["indeed", "failed"]] as const) {
      const run = await createRun(db, { channelId, cycleId: cycle.id });
      await finishRun(db, run.id, { status, fetched: 1 });
    }
    // indeed also sits behind an open circuit: it counts there, not as a plain failure
    await saveCircuitState(db, "indeed", { circuitState: "open", consecutiveFailures: 3, circuitOpenUntil: new Date(NOW.getTime() + 3_600_000), lastErrorCode: "blocked", lastSuccessAt: null, health: "down" });
    await finishCycle(db, cycle.id, { status: "partial" });

    expect((await getShellCycleStatus(db)).sources).toEqual({ ok: 2, failed: 1, circuitOpen: 1 });
    const status = await loadShellStatus(db, NOW);
    expect(status).toMatchObject({ state: "idle", cycle: { id: cycle.id, kind: "weekday_evening", status: "partial" }, progress: null });
  });

  it("running: progress is the runs finished of the cycle that is still open", async () => {
    const db = getDb();
    await channels();
    const cycle = await createCycle(db, { kind: "manual" });
    const first = await createRun(db, { channelId: "greenhouse", cycleId: cycle.id });
    await finishRun(db, first.id, { status: "succeeded" });
    await createRun(db, { channelId: "lever", cycleId: cycle.id });
    await createRun(db, { channelId: "xing", cycleId: cycle.id });

    const status = await loadShellStatus(db, NOW);
    expect(status.state).toBe("running");
    expect(status.progress).toEqual({ phase: "fetch", status: "running", kind: "manual", done: 1, total: 3 });
  });

  it("failed: the newest cycle failed and nothing is running", async () => {
    const db = getDb();
    const cycle = await createCycle(db, { kind: "weekday_morning" });
    await finishCycle(db, cycle.id, { status: "failed" });
    const status = await loadShellStatus(db, NOW);
    expect(status).toMatchObject({ state: "failed", cycle: { id: cycle.id, status: "failed" }, progress: null });
  });

  it("running (AI part): scored so far over scored + still waiting, with the kind of the cycle it belongs to", async () => {
    const db = getDb();
    const cycle = await createCycle(db, { kind: "weekday_evening" });
    await finishCycle(db, cycle.id, { status: "succeeded" });
    const request = await insertControlRequest(db, { kind: "run_ai", payload: { cycleId: cycle.id } });

    // queued: the worker has not taken it yet, nothing scored, and no preferences snapshot means nothing waits
    let status = await loadShellStatus(db, NOW);
    expect(status.state).toBe("running");
    expect(status.progress).toEqual({ phase: "ai", status: "pending", kind: "weekday_evening", done: 0, total: 0 });

    // taken, with two postings scored and one still waiting
    await claimNextControlRequest(db, ["run_ai"]);
    const company = await getOrCreateCompany(db, { name: "Acme", nameNorm: "acme" });
    const scoredA = await insertJob(db, { companyId: company.id, title: "A", titleNorm: "a" });
    const scoredB = await insertJob(db, { companyId: company.id, title: "B", titleNorm: "b" });
    await insertJob(db, { companyId: company.id, title: "C", titleNorm: "c" });
    const [snapshot] = await db.insert(schema.profileSnapshots).values({ kind: "preferences", hash: "h", contentYaml: "" }).returning();
    await db.insert(schema.scores).values([scoredA, scoredB].map((job) => ({ jobId: job.id, profileSnapshotId: snapshot?.id ?? 0, score: 80, rankValue: 80, filterResult: "passed" as const, scoredAt: new Date() })));
    status = await loadShellStatus(db, NOW);
    expect(status.progress).toMatchObject({ phase: "ai", status: "running", kind: "weekday_evening", done: 2 });
    expect(status.progress?.total).toBeGreaterThanOrEqual(2);

    await finishControlRequest(db, request.id, { status: "done", result: {} });
    expect((await loadShellStatus(db, NOW)).state).toBe("idle");
  });
});

describe("the badge on Sources", () => {
  it("counts a cycle with a failed step, and the channels that failed in it, though no channel is down", async () => {
    const db = getDb();
    await channels();
    const cycle = await createCycle(db, { kind: "weekday_morning" });
    const run = await createRun(db, { channelId: "greenhouse", cycleId: cycle.id });
    await finishRun(db, run.id, { status: "succeeded", fetched: 5 });
    const failedRun = await createRun(db, { channelId: "lever", cycleId: cycle.id });
    await finishRun(db, failedRun.id, { status: "failed" });
    await finishCycle(db, cycle.id, { status: "partial", summary: { steps: [{ name: "collect", status: "partial" }, { name: "pipeline", status: "failed" }] } });
    // nothing is down or behind an open circuit: the badge comes from the failed lever run (1) and the failed step (1)
    expect((await loadShellStatus(db, NOW)).counts.sourcesAlert).toBe(2);
  });

  it("stays 0 after a clean cycle", async () => {
    const db = getDb();
    await channels();
    const cycle = await createCycle(db, { kind: "weekday_morning" });
    const run = await createRun(db, { channelId: "greenhouse", cycleId: cycle.id });
    await finishRun(db, run.id, { status: "succeeded", fetched: 5 });
    await finishCycle(db, cycle.id, { status: "succeeded", summary: { steps: [{ name: "collect", status: "ok" }] } });
    expect((await loadShellStatus(db, NOW)).counts.sourcesAlert).toBe(0);
  });
});

describe("the sidebar badges and the runner heartbeat", () => {
  it("counts today's visible jobs, the unfiltered jobs, the applications in the pipeline (not ended, `new` included) and the channels that need a look", async () => {
    const db = getDb();
    await channels();
    await saveCircuitState(db, "xing", { circuitState: "open", consecutiveFailures: 3, circuitOpenUntil: new Date(NOW.getTime() + 3_600_000), lastErrorCode: "blocked", lastSuccessAt: null, health: "down" });
    const company = await getOrCreateCompany(db, { name: "Acme", nameNorm: "acme" });
    const jobs = await Promise.all(["a", "b", "c", "d"].map((title) => insertJob(db, { companyId: company.id, title, titleNorm: title })));
    const [snapshot] = await db.insert(schema.profileSnapshots).values({ kind: "preferences", hash: "h", contentYaml: "" }).returning();
    // job d was removed by the hard filter
    await db.insert(schema.scores).values(
      jobs.map((job, index) => ({ jobId: job.id, profileSnapshotId: snapshot?.id ?? 0, score: null, rankValue: null, filterResult: index === 3 ? ("filtered_out" as const) : ("passed" as const), scoredAt: new Date() })),
    );
    await setApplicationStatus(db, jobs[0]?.id ?? 0, "applied");
    await setApplicationStatus(db, jobs[1]?.id ?? 0, "rejected");
    await setApplicationStatus(db, jobs[2]?.id ?? 0, "new");

    // a star on the job the hard filter removed still counts, and changes nothing else
    await addFavorite(db, jobs[3]?.id ?? 0);

    const status = await loadShellStatus(db, new Date());
    expect(status.counts).toEqual({ today: 3, jobs: 3, pipeline: 2, favorites: 1, sourcesAlert: 1 });
  });

  it("says the runner is offline without a heartbeat, online with a fresh one, and tells the ai-worker apart", async () => {
    const db = getDb();
    let status = await loadShellStatus(db, NOW);
    expect(status.runner).toEqual({ online: false, ageSeconds: null });
    expect(status.aiWorker).toMatchObject({ expected: true, online: false, ageSeconds: null });

    await writeHeartbeat(db, "runner");
    status = await loadShellStatus(db, NOW);
    expect(status.runner.online).toBe(true);
    // the ai-worker has its own heartbeat: the runner's beat does not make it look alive
    expect(status.aiWorker.online).toBe(false);

    await writeHeartbeat(db, "ai-worker");
    expect((await loadShellStatus(db, NOW)).aiWorker.online).toBe(true);
  });
});
