import { withRebuiltCurrentScores } from "../helpers/current-scores";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, inject, it } from "vitest";

import { GET as searchPalette } from "@/app/api/search/route";
import { closeDb, countJobList, getDb, getNavCounts, listCompanyFilterOptions, listCompanyOverview, listJobs, listPushCandidates, listScoreQueue, listTodayJobs, schema } from "@/lib/db";
import { listBreakdownCandidates } from "@/lib/db/repos/breakdowns";
import { listFilterCandidates } from "@/lib/db/repos/filter-results";
import { countGhostStats, listJobsToGhostCheck } from "@/lib/db/repos/ghost";
import { countVisaStats, listJobsToVisaScan } from "@/lib/db/repos/visa";
import { listTranslationCandidates } from "@/lib/db/repos/translations";
import { listJobsToTrapScan } from "@/lib/db/repos/traps";
import { countJobsToReview, listBonusRows, listJobsToReview, listJobsToScan, listJobsToSyncSalary, listRecentJobsForPreview } from "@/lib/db/repos/signals";
import { listRecentCycleKpis } from "@/lib/db/queries/today";
import { findMatchingJob } from "@/lib/pipeline/dedupe";
import { normalizeDraft } from "@/lib/pipeline/normalize";
import { shippedPipeline } from "../pipeline/helpers";
import { addJob, ago, NOW } from "./dormant-fixture";

beforeAll(() => { process.env.DATABASE_URL = inject("testDatabaseUrl"); });
afterAll(closeDb);
const ids = (rows: readonly ({ id: number } | { jobId: number })[]) => rows.map((row) => "id" in row ? row.id : row.jobId).sort((a, b) => a - b);

it("excludes dormancy from each automatic scan, review, preview, bonus and AI queue; explicit requests still work", async () => {
  const active = await addJob({ status: "active" });
  const possibly = await addJob();
  const dormant = await addJob({ dormantAt: ago(1) });
  const closed = await addJob({ status: "closed" });
  const db = getDb();
  const [snapshot] = await db.insert(schema.profileSnapshots).values({ kind: "preferences", contentYaml: "", hash: "queue" }).returning();
  for (const job of [active, possibly, dormant, closed]) {
    await withRebuiltCurrentScores(db, db.insert(schema.scores).values({ jobId: job.id, filterResult: "passed", profileSnapshotId: snapshot!.id, score: null, rankValue: 60 }));
    await db.insert(schema.signals).values({ jobId: job.id, tier: "T2", kind: "kw", quote: "Python", extractor: "rule" });
    await db.execute(sql`insert into signal_scans (job_id, description_hash, rules_hash, salary_hash, candidate_count)
      values (${job.id}, md5(${job.description}), 'old', 'outdated', 1)`);
  }
  const open = [active.id, possibly.id].sort((a, b) => a - b);
  const withClosed = [...open, closed.id].sort((a, b) => a - b);
  expect(ids(await listFilterCandidates(db, { afterId: 0, limit: 20 }))).toEqual(open);
  expect(ids(await listJobsToScan(db, { afterId: 0, limit: 20, rulesHash: "new" }))).toEqual(withClosed);
  expect(ids(await listJobsToSyncSalary(db, { afterId: 0, limit: 20 }))).toEqual(withClosed);
  const review = { limit: 20, promptVersion: "new", withoutCandidates: true };
  expect(ids(await listJobsToReview(db, review))).toEqual(open);
  expect(await countJobsToReview(db, review)).toBe(2);
  expect(ids(await listJobsToReview(db, { ...review, jobIds: [dormant.id] }))).toEqual([dormant.id]);
  expect(ids(await listRecentJobsForPreview(db, 20))).toEqual(open);
  expect(ids(await listJobsToTrapScan(db, { limit: 20, rulesHash: "new" }))).toEqual(withClosed);
  const visa = { limit: 20, rulesHash: "new", withTrapSpans: false };
  const ghost = { ...visa, trustedKeys: [], payloadChannels: [], now: NOW };
  expect(ids(await listJobsToVisaScan(db, visa))).toEqual(open);
  expect(ids(await listJobsToGhostCheck(db, ghost))).toEqual(open);
  expect(await countVisaStats(db)).toMatchObject({ unchecked: 2 });
  expect(await countGhostStats(db)).toMatchObject({ total: 2, unchecked: 2 });
  expect((await listTranslationCandidates(db, { lang: "zh", minRank: 0, limit: 20 })).map((r) => r.jobId).sort()).toEqual([...open].sort());
  expect((await listBreakdownCandidates(db, { minRank: 0, limit: 20 })).map((r) => r.jobId).sort()).toEqual([...open].sort());
  expect((await listBonusRows(db)).map((r) => r.jobId).sort()).toEqual([...withClosed].sort());
  expect(ids(await listFilterCandidates(db, { afterId: 0, limit: 20, jobIds: [dormant.id] }))).toEqual([dormant.id]);
  expect(ids(await listJobsToTrapScan(db, { limit: 20, rulesHash: "new", jobIds: [dormant.id] }))).toEqual([dormant.id]);
  expect(ids(await listJobsToVisaScan(db, { ...visa, jobIds: [dormant.id] }))).toEqual([dormant.id]);
  expect(ids(await listJobsToGhostCheck(db, { ...ghost, jobIds: [dormant.id] }))).toEqual([dormant.id]);
  expect((await listScoreQueue(db, { snapshotId: snapshot!.id })).map((r) => r.jobId)).not.toContain(dormant.id);
  expect((await listPushCandidates(db, { since: ago(100) })).map((r) => r.jobId)).not.toContain(dormant.id);

  // Deduplication must still find a dormant target for an incoming posting.
  const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, dormant.companyId));
  const pipeline = shippedPipeline();
  const normalized = normalizeDraft({ title: dormant.title, companyName: company!.name, locations: [], workplace: "unknown", description: dormant.description ?? "", applyUrl: null, sourceUrl: null }, pipeline);
  const matched = await findMatchingJob(db, { normalized, companyId: company!.id, companyName: company!.name, channelFamily: "manual", externalId: "incoming", rawPostingId: 0 }, pipeline);
  expect(matched?.job.id).toBe(dormant.id);
});

it("default lists, company counts, navigation and palette agree while explicit statuses include dormant jobs", async () => {
  const db = getDb();
  const active = await addJob({ status: "active", firstSeenAt: NOW, lastSeenAt: NOW });
  const possibly = await addJob();
  const dormant = await addJob({ dormantAt: ago(1) });
  const closed = await addJob({ status: "closed" });
  const manual = await addJob({ status: "active", firstSeenAt: NOW, lastSeenAt: NOW });
  const kept = await addJob({ status: "closed" });
  const filtered = await addJob({ status: "active" });
  await db.insert(schema.jobClosureOverrides).values([{ jobId: manual.id, action: "closed" }, { jobId: kept.id, action: "open" }]);
  await withRebuiltCurrentScores(db, db.insert(schema.scores).values({ jobId: filtered.id, filterResult: "filtered_out" }));
  const list = (statuses?: Array<"closed" | "possibly_closed">) => listJobs(db, { filters: statuses ? { statuses } : {}, sort: "first_seen", dir: "asc", page: 1, pageSize: 50, timezone: "UTC" });
  expect(ids((await list()).jobs)).toEqual([active.id, possibly.id, kept.id].sort((a, b) => a - b));
  const explicit = await list(["closed", "possibly_closed"]);
  expect(ids(explicit.jobs)).toEqual([possibly.id, dormant.id, closed.id, manual.id].sort((a, b) => a - b));
  expect(explicit.total).toBe(await countJobList(db, { filters: { statuses: ["closed", "possibly_closed"] }, timezone: "UTC" }));
  expect(ids((await list(["possibly_closed"])).jobs)).toEqual([possibly.id, dormant.id]);
  const companyOptions = await listCompanyFilterOptions(db, { limit: 50, timezone: "UTC" });
  expect(companyOptions.map((row) => row.name)).not.toContain((await db.select().from(schema.companies).where(eq(schema.companies.id, dormant.companyId)))[0]!.name);
  const overview = await listCompanyOverview(db, { q: "", sort: "jobs", dir: "desc", page: 1, pageSize: 50, timezone: "UTC" });
  expect(overview.rows.map((r) => r.id).sort()).toEqual([active.companyId, possibly.companyId, kept.companyId].sort());
  const counts = await getNavCounts(db, { now: NOW, timezone: "UTC" });
  expect(counts.jobs).toBe(await countJobList(db, { filters: {}, timezone: "UTC" }));
  expect(counts.today).toBe(1);
  expect((await listTodayJobs(db, { now: NOW, timezone: "UTC" })).length).toBe(counts.today);
  const response = await searchPalette(new Request(`http://localhost/api/search?q=${encodeURIComponent(dormant.title)}`));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ jobs: [] });
  // Historical KPI and today's list never depend on this old job's dormancy.
  const kpis = await listRecentCycleKpis(db, { limit: 14, qualifiedMinRank: 70 });
  const today = await listTodayJobs(db, { now: NOW, timezone: "UTC" });
  await db.update(schema.jobs).set({ dormantAt: null }).where(eq(schema.jobs.id, dormant.id));
  expect(await listRecentCycleKpis(db, { limit: 14, qualifiedMinRank: 70 })).toEqual(kpis);
  expect(await listTodayJobs(db, { now: NOW, timezone: "UTC" })).toEqual(today);
});
