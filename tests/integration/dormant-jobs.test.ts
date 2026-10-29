import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, inject, it } from "vitest";

import { ChannelRegistry } from "@/lib/channels/registry";
import { registerFixtureChannel } from "@/lib/channels/fixture";
import { addFavorite, closeDb, countJobList, getDb, getJobDetail, getNavCounts, listJobs, reopenJob, restoreClosureOverride, schema, setApplicationNotes, setApplicationResumePath, setApplicationStatus, setClosureOverride } from "@/lib/db";
import { revertApplicationStatus, setApplicationNextAction } from "@/lib/db/repos/applications";
import { dormancyReady, markJobsDormant, resetDormancyCache, wakeIneligibleDormantJobs } from "@/lib/db/repos/dormancy";
import { listFilterCandidates } from "@/lib/db/repos/filter-results";
import { insertJob, listJobsForLinkCheck, listWatchedJobsForRecheck, markJobsPossiblyClosed, recordLinkCheck, recordWatchedCheck, touchJobsSeen } from "@/lib/db/repos/jobs";
import { dormantSql } from "@/lib/db/queries/job-status";
import { runMaintenance, runPipeline } from "@/lib/pipeline";
import { defaultContext } from "@/lib/mcp/server";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import { searchJobs } from "@/lib/mcp/tools/search-jobs";
import type { Executor } from "@/lib/db/executor";

import { quietLogger } from "../cycle/helpers";
import { pipelineWith } from "../pipeline/helpers";
import { addJob, addSource, ago, dormancy, marker, NOW } from "./dormant-fixture";

beforeAll(() => { process.env.DATABASE_URL = inject("testDatabaseUrl"); resetDormancyCache(); });
afterAll(closeDb);
const maintenanceConfig = () => pipelineWith((raw) => {
  Object.assign(raw.lifecycle as object, { dormant_after_days: 30, max_link_checks_per_cycle: 0 });
});
const maintain = (db = getDb()) => runMaintenance(db, { relist: { minGapDays: 9 }, config: maintenanceConfig(), now: () => NOW, http: { request: async () => { throw new Error("unexpected request"); }, json: async () => { throw new Error("unexpected request"); } }, logger: quietLogger });
const rollback = new Error("deliberate rollback");

it("marks only jobs past the later of the entry time and the sighting grace period", async () => {
  const old = await addJob();
  const recent = await addJob({ possiblyClosedAt: ago(29) });
  const boundary = await addJob({ lastSeenAt: ago(37) });
  const inside = await addJob({ lastSeenAt: new Date(ago(37).getTime() + 1) });
  const outside = await addJob({ lastSeenAt: new Date(ago(37).getTime() - 1) });
  const active = await addJob({ status: "active" });
  const closed = await addJob({ status: "closed" });
  expect(await markJobsDormant(getDb(), dormancy)).toBe(2);
  for (const id of [old.id, outside.id]) expect(await marker(id)).toEqual(NOW);
  for (const id of [recent.id, boundary.id, inside.id, active.id, closed.id]) expect(await marker(id)).toBeNull();
});

it("starts the grace period when a long-blocked source finally qualifies, never dormancy in that maintenance run", async () => {
  const job = await addJob({ status: "active" });
  await addSource(job.id);
  await getDb().insert(schema.runs).values({ channelId: "fx", status: "succeeded", startedAt: ago(1) });
  const result = await maintain();
  expect(result).toMatchObject({ possiblyClosed: 1, dormant: { marked: 0, woke: 0 } });
  const [stored] = await getDb().select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
  expect(stored).toMatchObject({ status: "possibly_closed", possiblyClosedAt: NOW, dormantAt: null });
  expect(await markJobsPossiblyClosed(getDb(), { now: NOW, days: 7 })).toEqual([]);
});

it("protects both judgements, bookmarks and every live application; ended applications and filter overrides do not protect", async () => {
  const protectedIds: number[] = [];
  for (const action of ["open", "closed"] as const) {
    const job = await addJob(); protectedIds.push(job.id);
    await getDb().insert(schema.jobClosureOverrides).values({ jobId: job.id, action });
  }
  const favorite = await addJob(); protectedIds.push(favorite.id);
  await getDb().insert(schema.jobFavorites).values({ jobId: favorite.id });
  for (const status of ["new", "interested", "preparing", "applied", "interviewing", "offer"] as const) {
    const job = await addJob(); protectedIds.push(job.id);
    await getDb().insert(schema.applications).values({ jobId: job.id, status });
  }
  const ended: number[] = [];
  for (const status of ["rejected", "withdrawn", "archived"] as const) {
    const job = await addJob(); ended.push(job.id);
    await getDb().insert(schema.applications).values({ jobId: job.id, status });
  }
  const overridden = await addJob(); ended.push(overridden.id);
  await getDb().insert(schema.jobFilterOverrides).values({ jobId: overridden.id, action: "keep" });
  expect(await markJobsDormant(getDb(), dormancy)).toBe(ended.length);
  for (const id of protectedIds) expect(await marker(id)).toBeNull();
  for (const id of ended) expect(await marker(id)).toEqual(NOW);
});

it("sweeps protection committed between marking and sweeping, using a direct SQL bookmark", async () => {
  const job = await addJob();
  expect(await markJobsDormant(getDb(), dormancy)).toBe(1);
  await getDb().execute(sql`insert into job_favorites (job_id) values (${job.id})`);
  expect(await marker(job.id)).toEqual(NOW);
  expect(await wakeIneligibleDormantJobs(getDb(), dormancy)).toBe(1);
  expect(await marker(job.id)).toBeNull();
});

it("clears ineligible and legacy markers, raises the cutoff, and disables dormancy at the next sweep", async () => {
  const old = await addJob({ dormantAt: ago(1) });
  const active = await addJob({ status: "active", dormantAt: ago(1) });
  const equal = await addJob({ dormantAt: ago(60) });
  const seen = await addJob({ dormantAt: ago(61) });
  const [read] = await getDb().execute<{ n: number }>(sql`select count(*)::int as n from jobs where ${dormantSql(true)}`);
  expect(read!.n).toBe(1);
  expect(await wakeIneligibleDormantJobs(getDb(), dormancy)).toBe(3);
  for (const id of [active.id, equal.id, seen.id]) expect(await marker(id)).toBeNull();
  expect(await wakeIneligibleDormantJobs(getDb(), { ...dormancy, dormantAfterDays: 90 })).toBe(1);
  expect(await marker(old.id)).toBeNull();
  await markJobsDormant(getDb(), dormancy);
  expect(await markJobsDormant(getDb(), { ...dormancy, dormantAfterDays: 0 })).toBe(0);
  expect(await wakeIneligibleDormantJobs(getDb(), { ...dormancy, dormantAfterDays: 0 })).toBe(3);
});

it("reports marked and sweep-woken counts in maintenance", async () => {
  await addJob();
  const protectedJob = await addJob({ dormantAt: ago(1) });
  await getDb().execute(sql`insert into job_favorites (job_id) values (${protectedJob.id})`);
  expect(await maintain()).toMatchObject({ dormant: { marked: 1, woke: 1 } });
  expect(await maintain()).toMatchObject({ dormant: { marked: 0, woke: 0 } });
});

it.each([false, true])("a returning source clears dormancy, preserving phrase evidence = %s", async (phrase) => {
  const job = await addJob({ dormantAt: ago(1), ...(phrase ? { linkCheckJson: { outcome: "phrase" } } : {}) });
  await addSource(job.id, NOW);
  expect(await touchJobsSeen(getDb(), { relistMinGapDays: 9 })).toEqual({ seen: 1, reopened: phrase ? 0 : 1, relisted: 0 });
  expect(await marker(job.id)).toBeNull();
  expect((await getJobDetail(getDb(), job.id))?.status).toBe(phrase ? "possibly_closed" : "active");
});

it.each([false, true])("pipeline merges a returning posting into the dormant job, preserving phrase = %s", async (phrase) => {
  const registry = new ChannelRegistry();
  registerFixtureChannel(registry, { id: "fx", family: "manual" });
  const job = await addJob({ dormantAt: ago(1), ...(phrase ? { linkCheckJson: { outcome: "phrase" } } : {}) });
  const raw = await addSource(job.id, NOW);
  const [company] = await getDb().select().from(schema.companies).where(eq(schema.companies.id, job.companyId));
  await getDb().update(schema.rawPostings).set({ payloadJson: { id: String(job.id), title: job.title, company: company!.name, city: null, country: null, remote: false, description: "Build reliable systems with Python.", url: `https://jobs.example/${job.id}`, posted_at: null } }).where(eq(schema.rawPostings.id, raw.id));
  expect(await runPipeline(getDb(), { relist: { minGapDays: 9 }, registry, config: maintenanceConfig(), logger: quietLogger })).toMatchObject({ updated: 1, created: 0, deferred: 0 });
  expect(await marker(job.id)).toBeNull();
  expect((await getJobDetail(getDb(), job.id))?.status).toBe(phrase ? "possibly_closed" : "active");
});

it.each(["alive", "gone"] as const)("link and watched %s results clear markers and give the expected status", async (outcome) => {
  for (const watched of [false, true]) {
    const job = await addJob({ dormantAt: ago(1) });
    if (watched) await recordWatchedCheck(getDb(), job.id, { outcome, httpStatus: outcome === "gone" ? 404 : 200, url: null, quote: null, phrase: null, at: NOW.toISOString() }, NOW);
    else await recordLinkCheck(getDb(), job.id, { outcome, at: NOW });
    expect(await marker(job.id)).toBeNull();
    expect((await getJobDetail(getDb(), job.id))?.status).toBe(outcome === "gone" ? "closed" : "active");
  }
});

it("records only the first phrase entry time and resets it after an active interval", async () => {
  const job = await addJob({ status: "active" });
  const evidence = { outcome: "phrase" as const, httpStatus: 200, url: null, quote: null, phrase: null, at: ago(2).toISOString() };
  await recordWatchedCheck(getDb(), job.id, evidence, ago(2));
  await recordWatchedCheck(getDb(), job.id, evidence, NOW);
  let [row] = await getDb().select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
  expect(row!.possiblyClosedAt).toEqual(ago(2));
  await recordLinkCheck(getDb(), job.id, { outcome: "alive", at: NOW });
  await recordWatchedCheck(getDb(), job.id, evidence, NOW);
  [row] = await getDb().select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
  expect(row!.possiblyClosedAt).toEqual(NOW);
});

const writers: Array<[string, (tx: Executor, id: number) => Promise<unknown>]> = [
  ["favorite", (tx, id) => addFavorite(tx, id)],
  ["new application", (tx, id) => setApplicationStatus(tx, id, "new")],
  ["application status", async (tx, id) => {
    await tx.insert(schema.applications).values({ jobId: id, status: "rejected" });
    return setApplicationStatus(tx, id, "interested");
  }],
  ["application undo", async (tx, id) => {
    await setApplicationStatus(tx, id, "interested");
    await setApplicationStatus(tx, id, "rejected");
    await tx.update(schema.jobs).set({ dormantAt: ago(1) }).where(eq(schema.jobs.id, id));
    return revertApplicationStatus(tx, id, { movedTo: "rejected", restoreTo: "interested" });
  }],
  ["new notes", (tx, id) => setApplicationNotes(tx, id, "note")],
  ["new resume", (tx, id) => setApplicationResumePath(tx, id, "resumes/example.pdf")],
  ["user judgement", (tx, id) => setClosureOverride(tx, id, "closed", null)],
  ["restored judgement", (tx, id) => restoreClosureOverride(tx, id, { action: "open", note: null, createdAt: NOW })],
  ["reopen", (tx, id) => reopenJob(tx, id)],
];
it.each(writers)("%s wakes in the same transaction, rolling back together", async (_name, write) => {
  const job = await addJob({ dormantAt: ago(1) });
  await expect(getDb().transaction(async (tx) => {
    await write(tx, job.id);
    expect(await marker(job.id, tx)).toBeNull();
    throw rollback;
  })).rejects.toBe(rollback);
  expect(await marker(job.id)).toEqual(ago(1));
});

it("next action does not create an application; ordinary checks exclude dormant while watched rechecks retain their scope", async () => {
  const job = await addJob({ dormantAt: ago(1) });
  expect(await setApplicationNextAction(getDb(), job.id, { nextAction: "call", nextActionAt: null })).toBe(false);
  expect(await listJobsForLinkCheck(getDb(), 10)).toEqual([]);
  await getDb().execute(sql`insert into job_favorites (job_id) values (${job.id})`);
  expect(await listWatchedJobsForRecheck(getDb(), { limit: 10, olderThan: NOW })).toEqual([{ id: job.id, status: "possibly_closed" }]);
});

it("reads through old-code sightings and sweeps a bookmark written before re-upgrading", async () => {
  const seen = await addJob({ dormantAt: ago(2), possiblyClosedAt: ago(50) });
  const favorite = await addJob({ dormantAt: ago(2) });
  await getDb().execute(sql`update jobs set status = 'active', last_seen_at = ${NOW.toISOString()}::timestamptz where id = ${seen.id}`);
  await getDb().execute(sql`update jobs set status = 'possibly_closed' where id = ${seen.id}`);
  await getDb().execute(sql`insert into job_favorites (job_id) values (${favorite.id})`);
  const [row] = await getDb().execute<{ dormant: boolean }>(sql`select ${dormantSql(true)} as dormant from jobs where id = ${seen.id}`);
  expect(row!.dormant).toBe(false);
  expect(await wakeIneligibleDormantJobs(getDb(), dormancy)).toBe(2);
  expect(await markJobsDormant(getDb(), dormancy)).toBe(0);
});

it("keeps reads, user writes and runner writes working before both columns exist", async () => {
  const jobs = await Promise.all(Array.from({ length: 6 }, () => addJob({ dormantAt: ago(1) })));
  resetDormancyCache();
  try {
    await expect(getDb().transaction(async (tx) => {
      await tx.execute(sql`alter table jobs drop column dormant_at, drop column possibly_closed_at`);
      expect(await dormancyReady(tx)).toBe(false);
      expect((await listJobs(tx, { filters: {}, sort: "rank", page: 1, pageSize: 50, timezone: "UTC" })).total).toBe(6);
      expect(await countJobList(tx, { filters: {}, timezone: "UTC" })).toBe(6);
      expect((await getNavCounts(tx, { now: NOW, timezone: "UTC" })).jobs).toBe(6);
      expect((await getJobDetail(tx, jobs[0]!.id))?.closure.reason).toBe("possibly");
      expect(await listFilterCandidates(tx, { afterId: 0, limit: 20 })).toHaveLength(6);
      const ctx = defaultContext(tx, mcpSchema.parse({ enabled: true }));
      expect((await searchJobs(ctx, {})).total).toBe(6);
      await addFavorite(tx, jobs[0]!.id);
      await setApplicationStatus(tx, jobs[1]!.id, "interested");
      await setApplicationStatus(tx, jobs[1]!.id, "offer");
      await setApplicationNotes(tx, jobs[2]!.id, "saved");
      await setApplicationResumePath(tx, jobs[2]!.id, "resumes/example.pdf");
      await setClosureOverride(tx, jobs[3]!.id, "closed", null);
      await restoreClosureOverride(tx, jobs[3]!.id, { action: "closed", note: "restored", createdAt: NOW });
      await reopenJob(tx, jobs[4]!.id);
      await touchJobsSeen(tx, { relistMinGapDays: 9 });
      await recordLinkCheck(tx, jobs[5]!.id, { outcome: "alive", at: NOW });
      await recordWatchedCheck(tx, jobs[5]!.id, { outcome: "phrase", httpStatus: 200, url: null, quote: null, phrase: null, at: NOW.toISOString() }, NOW);
      await markJobsPossiblyClosed(tx, { now: NOW, days: 7 });
      expect(await tx.select().from(schema.jobFavorites)).toHaveLength(1);
      expect(await tx.select().from(schema.applications)).toHaveLength(2);
      expect(await tx.select().from(schema.jobClosureOverrides)).toHaveLength(2);
      const created = await insertJob(tx, { companyId: jobs[0]!.companyId, title: "CLI job", titleNorm: "cli job", firstSeenAt: NOW, lastSeenAt: NOW,
        locationsJson: [{ label: "Example", city: null, countryCode: null, isPrimary: true }] });
      expect(created).toMatchObject({ status: "active", dormantAt: null, possiblyClosedAt: null, lastSeenAt: NOW });
      expect(created.locationsJson).toEqual([{ label: "Example", city: null, countryCode: null, isPrimary: true }]);
      expect(await maintain(tx)).toMatchObject({ dormant: { marked: 0, woke: 0 } });
      throw rollback;
    })).rejects.toBe(rollback);
  } finally { resetDormancyCache(); }
  expect(await dormancyReady(getDb())).toBe(true);
  expect(await marker(jobs[0]!.id)).toEqual(ago(1));
});

it("rolls back a standalone closure write when waking the job fails", async () => {
  const db = getDb();
  const job = await addJob({ dormantAt: ago(1) });
  await db.execute(sql`create function reject_test_wake() returns trigger language plpgsql as $$ begin raise exception 'forced wake failure'; end $$`);
  await db.execute(sql`create trigger reject_test_wake before update on jobs for each row execute function reject_test_wake()`);
  try {
    await expect(setClosureOverride(db, job.id, "closed", null)).rejects.toThrow();
    expect(await db.select().from(schema.jobClosureOverrides)).toHaveLength(0);
    await expect(restoreClosureOverride(db, job.id, { action: "open", note: null, createdAt: NOW })).rejects.toThrow();
    expect(await db.select().from(schema.jobClosureOverrides)).toHaveLength(0);
    expect(await marker(job.id)).toEqual(ago(1));
  } finally {
    await db.execute(sql`drop trigger reject_test_wake on jobs`);
    await db.execute(sql`drop function reject_test_wake()`);
  }
});
