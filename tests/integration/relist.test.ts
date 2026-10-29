import fs from "node:fs";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, it } from "vitest";

import { closeDb, countTodayRelisted, createConnection, getDb, getJobDetail, listJobs, listTodayJobs, schema, type Db } from "@/lib/db";
import { listingReady, recordJobListing, resetListingCache } from "@/lib/db/repos/listing";
import { resetDormancyCache } from "@/lib/db/repos/dormancy";
import { getJob, insertJob, recordLinkCheck, recordWatchedCheck, touchJobsSeen } from "@/lib/db/repos/jobs";
import { listTranslationCandidates } from "@/lib/db/repos/translations";
import { listBreakdownCandidates } from "@/lib/db/repos/breakdowns";
import { listFilterCandidates } from "@/lib/db/repos/filter-results";
import { listPushCandidates } from "@/lib/db/repos/notifications";
import { currentPreferences, runFilter } from "@/lib/filter";
import { reloadConfig } from "@/lib/config";
import { relistDecision } from "@/lib/jobs/relist";
import { runMaintenance, runPipeline } from "@/lib/pipeline";
import { descriptionHash } from "@/lib/translation/hash";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { relistCases } from "../jobs/relist-cases";
import { addJob, addSource, ago, NOW } from "./dormant-fixture";
import { addRun, maintenanceOptions, pipelineOptions, posting, relist } from "./relist-fixture";

const url = inject("testDatabaseUrl");
let temp: TempConfig;
beforeAll(() => { process.env.DATABASE_URL = url; });
beforeEach(() => { temp = makeTempConfig(); resetListingCache(); resetDormancyCache(); });
afterEach(() => { temp.cleanup(); resetListingCache(); resetDormancyCache(); });
afterAll(closeDb);
const list = (db: Db = getDb()) => listJobs(db, { filters: { scope: "all", relistedSince: ago(2) }, sort: "last_listed", page: 1, pageSize: 100, timezone: "UTC", visa: false });

it.each(relistCases)("SQL and TypeScript agree: $name", async (input) => {
  const job = await addJob({ status: "active", lastListedAt: input.lastListedAt });
  await addSource(job.id);
  if (input.absenceObserved) await addRun({ at: new Date("2026-09-05T12:00:00Z") });
  const actual = await recordJobListing(getDb(), { jobId: job.id, observedAt: input.observedAt, observedRunId: null, minGapDays: input.minGapDays });
  expect(actual).toBe(relistDecision(input));
  expect(actual).toBe(input.expected);
  const stored = await getJob(getDb(), job.id);
  expect(stored?.lastListedAt).toEqual(input.lastListedAt && input.lastListedAt > input.observedAt ? input.lastListedAt : input.observedAt);
  expect(stored?.relistCount ?? 0).toBe(input.expected ? 1 : 0);
});

it.each([
  { name: "no successful run", status: "failed" as const },
  { name: "partial run", status: "partial" as const },
  { name: "extended window", extended: true },
  { name: "no cycle", cycleId: null },
  { name: "not finished", finishedAt: null },
  { name: "run before baseline", at: ago(30) },
  { name: "run finishes at observation", finishedAt: NOW },
])("does not infer absence from $name", async (run) => {
  const job = await addJob({ lastListedAt: ago(20) });
  await addSource(job.id, NOW);
  await addRun(run);
  expect(await touchJobsSeen(getDb(), { relistMinGapDays: relist.minGapDays })).toMatchObject({ relisted: 0 });
  expect(await getJob(getDb(), job.id)).toMatchObject({ lastListedAt: NOW, relistedAt: null, relistCount: 0 });
});

it("records one relist from two postings in a cycle and keeps seen/reopened meanings", async () => {
  const job = await addJob({ status: "closed", lastListedAt: ago(20), lastSeenAt: ago(20) });
  const raw = await addSource(job.id, ago(1));
  await addRun();
  const recovery = await addRun({ at: ago(1) });
  await getDb().update(schema.rawPostings).set({ runId: recovery.id }).where(eq(schema.rawPostings.id, raw.id));
  const [other] = await getDb().insert(schema.rawPostings).values({ channelId: "fx", externalId: "other", fetchedAt: NOW, runId: recovery.id, payloadJson: {} }).returning();
  await getDb().insert(schema.jobSources).values({ jobId: job.id, channelId: "fx", rawPostingId: other!.id });
  expect(await touchJobsSeen(getDb(), { relistMinGapDays: relist.minGapDays })).toEqual({ seen: 1, reopened: 1, relisted: 1 });
  expect(await touchJobsSeen(getDb(), { relistMinGapDays: relist.minGapDays })).toEqual({ seen: 0, reopened: 0, relisted: 0 });
  expect(await getJob(getDb(), job.id)).toMatchObject({ lastListedAt: NOW, relistedAt: NOW, relistCount: 1, firstSeenAt: job.firstSeenAt });
});

it("two independent concurrent connections count the locked row only once", async () => {
  const job = await addJob({ lastListedAt: ago(20) });
  await addSource(job.id);
  await addRun();
  const a = createConnection(url, { max: 1 });
  const b = createConnection(url, { max: 1 });
  try {
    const input = { jobId: job.id, observedAt: NOW, observedRunId: null, minGapDays: relist.minGapDays };
    expect((await Promise.all([recordJobListing(a.db, input), recordJobListing(b.db, input)])).sort()).toEqual([false, true]);
    expect(await recordJobListing(a.db, { ...input, observedAt: ago(1) })).toBe(false);
    expect(await getJob(b.db, job.id)).toMatchObject({ lastListedAt: NOW, relistCount: 1 });
  } finally { await Promise.all([a.sql.end(), b.sql.end()]); }
});

it("alive link and watched checks leave listing observations alone, even when last_seen is later", async () => {
  const job = await addJob({ lastListedAt: ago(20) });
  await addSource(job.id, ago(1));
  await addRun();
  await recordLinkCheck(getDb(), job.id, { outcome: "alive", at: NOW });
  await recordWatchedCheck(getDb(), job.id, { outcome: "alive", at: NOW.toISOString(), httpStatus: 200, phrase: null, quote: null, url: null }, NOW);
  expect((await getJob(getDb(), job.id))?.lastListedAt).toEqual(ago(20));
  expect(await touchJobsSeen(getDb(), { relistMinGapDays: relist.minGapDays })).toEqual({ seen: 0, reopened: 0, relisted: 1 });
  expect(await getJob(getDb(), job.id)).toMatchObject({ lastSeenAt: NOW, lastListedAt: ago(1), relistedAt: ago(1) });
});

it.each(["manual", "phrase"])("keeps %s closure protection while recording relists", async (protection) => {
  const job = await addJob({ lastListedAt: ago(20), ...(protection === "phrase" ? { linkCheckJson: { outcome: "phrase", at: NOW.toISOString(), httpStatus: 200, phrase: "closed", quote: "This job is closed", url: null } } : {}) });
  if (protection === "manual") await getDb().insert(schema.jobClosureOverrides).values({ jobId: job.id, action: "closed" });
  await addSource(job.id, NOW);
  await addRun();
  expect((await touchJobsSeen(getDb(), { relistMinGapDays: relist.minGapDays })).relisted).toBe(1);
  const detail = await getJobDetail(getDb(), job.id);
  expect(detail?.closure.reason).toBe(protection);
  expect(detail?.status).toBe(protection === "manual" ? "closed" : "possibly_closed");
  expect(detail?.relistCount).toBe(1);
});

it("first maintenance establishes the latest fetched baseline without changing count or status", async () => {
  const job = await addJob({ lastListedAt: null, lastSeenAt: NOW, relistCount: 4, dormantAt: ago(1) });
  await addSource(job.id, ago(20));
  await addRun();
  expect(await touchJobsSeen(getDb(), { relistMinGapDays: relist.minGapDays })).toEqual({ seen: 0, reopened: 0, relisted: 0 });
  expect(await getJob(getDb(), job.id)).toMatchObject({ lastListedAt: ago(20), relistedAt: null, relistCount: 4, status: job.status, dormantAt: ago(1) });
});

it("pipeline merges and maintenance share the rule without double counting or moving late observations", async () => {
  const options = pipelineOptions();
  const job = await addJob({ status: "active", lastListedAt: ago(20), lastSeenAt: NOW });
  const raw = await addSource(job.id, ago(1));
  await addRun();
  await getDb().update(schema.rawPostings).set({ payloadJson: posting, parseStatus: "pending" }).where(eq(schema.rawPostings.id, raw.id));
  expect(await runPipeline(getDb(), options)).toMatchObject({ updated: 1, created: 0, relisted: 1, deferred: 0 });
  expect((await runMaintenance(getDb(), maintenanceOptions())).relisted).toBe(0);
  expect(await getJob(getDb(), job.id)).toMatchObject({ lastSeenAt: NOW, lastListedAt: ago(1), relistedAt: ago(1), relistCount: 1 });
  await getDb().update(schema.rawPostings).set({ fetchedAt: ago(2), parseStatus: "pending" }).where(eq(schema.rawPostings.id, raw.id));
  expect((await runPipeline(getDb(), options)).relisted).toBe(0);
  expect((await getJob(getDb(), job.id))?.lastListedAt).toEqual(ago(1));
});

it("a new URL merges into an existing job, while a new late-parsed job uses fetched_at", async () => {
  const options = pipelineOptions();
  await getDb().insert(schema.channels).values({ id: "fx", family: "manual", kind: "manual" });
  await getDb().insert(schema.rawPostings).values({ channelId: "fx", externalId: posting.id, fetchedAt: ago(20), payloadJson: posting });
  expect(await runPipeline(getDb(), options)).toMatchObject({ created: 1, relisted: 0 });
  const [job] = await getDb().select().from(schema.jobs);
  expect(job?.lastListedAt).toEqual(ago(20));
  await addRun();
  await getDb().insert(schema.rawPostings).values({ channelId: "fx", externalId: "new-url", fetchedAt: NOW, payloadJson: { ...posting, id: "new-url" } });
  expect(await runPipeline(getDb(), options)).toMatchObject({ created: 0, merged: { exact_key: 1 }, relisted: 1 });
  expect((await getJob(getDb(), job!.id))?.relistCount).toBe(1);
});

it("listing-only changes create no downstream work and archive config never changes filter fingerprints", async () => {
  const job = await addJob({ status: "active", lastListedAt: ago(20), firstSeenAt: ago(30), postedAt: ago(40), language: "en" });
  await addSource(job.id, NOW);
  await addRun();
  const current = await currentPreferences(getDb());
  const options = { preferences: { ...current.preferences, deal_breakers: [] }, snapshotId: current.snapshot.id, pipeline: pipelineOptions().config, me: null, watchedCompanies: [] };
  await runFilter(getDb(), options);
  await getDb().update(schema.scores).set({ score: 80, rankValue: 80, scoredAt: ago(20) }).where(eq(schema.scores.jobId, job.id));
  const hash = descriptionHash(job.description!);
  await getDb().insert(schema.translations).values({ jobId: job.id, lang: "zh", content: "translated", sourceHash: hash });
  await getDb().insert(schema.jobBreakdowns).values({ jobId: job.id, sourceHash: hash, promptVersion: "test", outputLang: "en", content: {}, droppedItems: 0 });
  const [before] = await getDb().select().from(schema.scores).where(eq(schema.scores.jobId, job.id));
  expect((await touchJobsSeen(getDb(), { relistMinGapDays: relist.minGapDays })).relisted).toBe(1);
  for (const values of [{ min_gap_days: 0, badge_days: 1 }, { min_gap_days: 300, badge_days: 90 }]) {
    fs.writeFileSync(path.join(temp.configDir, "job-archive.yaml"), `config_version: 1\nrelist:\n  min_gap_days: ${values.min_gap_days}\n  badge_days: ${values.badge_days}\n`);
    expect(reloadConfig("jobArchive").relist).toEqual(values);
    expect(await runFilter(getDb(), options)).toMatchObject({ created: 0, updated: 0 });
  }
  const [after] = await getDb().select().from(schema.scores).where(eq(schema.scores.jobId, job.id));
  expect(after).toEqual(before);
  expect(await listTranslationCandidates(getDb(), { lang: "zh", minRank: 1, limit: 10 })).toEqual([]);
  expect(await listBreakdownCandidates(getDb(), { minRank: 1, limit: 10 })).toEqual([]);
  expect(await listFilterCandidates(getDb(), { afterId: 0, limit: 10, snapshotId: current.snapshot.id, configHash: after!.filterConfigHash! })).toEqual([]);
  expect(await listPushCandidates(getDb(), { since: ago(1) })).toEqual([]);
  expect(await getDb().select().from(schema.notifications)).toEqual([]);
  expect(await listTodayJobs(getDb(), { now: NOW, timezone: "UTC", visa: false })).toEqual([]);
  expect(await getJob(getDb(), job.id)).toMatchObject({ firstSeenAt: ago(30), postedAt: ago(40) });
});

it("reads and writes work before the listing migration, including pipeline merge and last-listed sorting", async () => {
  const job = await addJob({ status: "closed" });
  const raw = await addSource(job.id, NOW);
  const options = pipelineOptions();
  await getDb().update(schema.rawPostings).set({ payloadJson: posting }).where(eq(schema.rawPostings.id, raw.id));
  const rollback = new Error("rollback schema probe");
  try {
    await getDb().transaction(async (tx) => {
      await tx.execute(sql`alter table jobs drop column last_listed_at, drop column relisted_at, drop column relist_count`);
      resetListingCache(); resetDormancyCache();
      expect(await listingReady(tx)).toBe(false);
      expect(await countTodayRelisted(tx as unknown as Db, { now: NOW, timezone: "UTC", badgeSince: ago(2) })).toBe(0);
      const db = tx as unknown as Db;
      expect((await getJob(tx, job.id))?.lastListedAt).toBeNull();
      expect((await getJobDetail(db, job.id))?.lastListedAt).toEqual(NOW);
      expect((await list(db)).jobs).toHaveLength(1); // relistedSince is ignored
      expect(await touchJobsSeen(tx, { relistMinGapDays: relist.minGapDays })).toEqual({ seen: 1, reopened: 1, relisted: 0 });
      expect(await runPipeline(db, options)).toMatchObject({ updated: 1, deferred: 0, relisted: 0 });
      expect(await insertJob(tx, { companyId: job.companyId, title: "Upgrade insert", titleNorm: "upgrade insert", lastListedAt: NOW, relistedAt: NOW, relistCount: 2 })).toMatchObject({ lastListedAt: null, relistedAt: null, relistCount: null });
      throw rollback;
    });
  } catch (error) { expect(error).toBe(rollback); }
  finally { resetListingCache(); resetDormancyCache(); }
  expect(await listingReady(getDb())).toBe(true);
});

it("recording a listing before maintenance does not report a second relist while seen catches up", async () => {
  const job = await addJob({ status: "closed", lastListedAt: ago(20), lastSeenAt: ago(20) });
  await addSource(job.id, NOW);
  await addRun();
  expect(await recordJobListing(getDb(), { jobId: job.id, observedAt: NOW, observedRunId: null, minGapDays: relist.minGapDays })).toBe(true);
  expect(await touchJobsSeen(getDb(), { relistMinGapDays: relist.minGapDays })).toEqual({ seen: 1, reopened: 1, relisted: 0 });
});

it("establishes forty thousand listing baselines within the migration budget", async () => {
  const db = getDb();
  const [company] = await db.insert(schema.companies).values({ name: "Baseline fixture", nameNorm: "baseline fixture" }).returning();
  await db.insert(schema.channels).values({ id: "baseline", family: "manual", kind: "manual" });
  await db.execute(sql`insert into jobs (company_id, title, title_norm, last_seen_at)
    select ${company!.id}, n::text, n::text, ${NOW.toISOString()}::timestamptz from generate_series(1, 40000) n`);
  await db.execute(sql`insert into raw_postings (channel_id, external_id, payload_json, fetched_at)
    select 'baseline', n::text, '{}'::jsonb, ${ago(20).toISOString()}::timestamptz from generate_series(1, 40000) n`);
  await db.execute(sql`insert into job_sources (job_id, raw_posting_id, channel_id)
    select j.id, r.id, 'baseline' from jobs j join raw_postings r on r.external_id = j.title`);
  const start = performance.now();
  expect(await touchJobsSeen(db, { relistMinGapDays: relist.minGapDays })).toEqual({ seen: 0, reopened: 0, relisted: 0 });
  const elapsedMs = performance.now() - start;
  console.info("listing baseline", { rows: 40000, elapsedMs: Math.round(elapsedMs) });
  expect(elapsedMs).toBeLessThanOrEqual(5000);
  const [row] = await db.execute<{ n: number }>(sql`select count(*)::int as n from jobs where last_listed_at is not null and relisted_at is null and coalesce(relist_count, 0) = 0`);
  expect(row?.n).toBe(40000);
});

it("maintenance racing an independent listing writer reports only its own increment", async () => {
  const job = await addJob({ status: "active", lastSeenAt: ago(20), lastListedAt: ago(20) });
  await addSource(job.id, NOW);
  await addRun();
  const other = createConnection(url, { max: 1 });
  try {
    const [recorded, touched] = await Promise.all([
      recordJobListing(other.db, { jobId: job.id, observedAt: NOW, observedRunId: null, minGapDays: relist.minGapDays }),
      touchJobsSeen(getDb(), { relistMinGapDays: relist.minGapDays }),
    ]);
    expect(Number(recorded) + touched.relisted).toBe(1);
    expect(touched.seen).toBe(1);
    expect((await getJob(getDb(), job.id))?.relistCount).toBe(1);
  } finally { await other.sql.end(); }
});

it("cards and details read the stored baseline and relist fields, with source fallback for null baselines", async () => {
  const stored = await addJob({ status: "active", lastListedAt: ago(20), relistedAt: ago(1), relistCount: 3 });
  await addSource(stored.id, NOW);
  const fallback = await addJob({ status: "active" });
  await addSource(fallback.id, ago(10));
  const cards = await listJobs(getDb(), { filters: { scope: "all" }, sort: "last_listed", page: 1, pageSize: 100, timezone: "UTC", visa: false });
  expect(cards.jobs.map((job) => job.id)).toEqual([fallback.id, stored.id]);
  expect(cards.jobs[1]).toMatchObject({ lastListedAt: ago(20), relistedAt: ago(1), relistCount: 3 });
  expect(await getJobDetail(getDb(), stored.id)).toMatchObject({ lastListedAt: ago(20), relistedAt: ago(1), relistCount: 3 });
  expect(await getJobDetail(getDb(), fallback.id)).toMatchObject({ lastListedAt: ago(10), relistedAt: null, relistCount: 0 });
  expect((await list()).jobs.map((job) => job.id)).toEqual([stored.id]);
});
