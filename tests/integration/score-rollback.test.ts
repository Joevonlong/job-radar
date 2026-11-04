import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { closeDb, getDb, type Db } from "@/lib/db/client";
import { getNavCounts } from "@/lib/db/queries/nav-counts";
import { getJobDetail } from "@/lib/db/queries/job-detail";
import { listJobs } from "@/lib/db/queries/jobs";
import { listRegressFactRows } from "@/lib/db/queries/market-regress";
import { listTodayJobs } from "@/lib/db/queries/today";
import { listBreakdownCandidates } from "@/lib/db/repos/breakdowns";
import { scoreTransaction } from "@/lib/db/repos/current-scores";
import { insertFilterResults } from "@/lib/db/repos/filter-results";
import { getPushCandidate } from "@/lib/db/repos/notifications";
import { getLatestProfileSnapshot } from "@/lib/db/repos/profile-snapshots";
import { listHighScoreResearchCandidates } from "@/lib/db/repos/research-auto-runs";
import { promoteSnapshotScores, saveScore } from "@/lib/db/repos/scores";
import { listTranslationCandidates } from "@/lib/db/repos/translations";
import { jobCurrentScores, jobs, profileSnapshots } from "@/lib/db/schema";
import { recordProfileSnapshot, snapshotForProfileText } from "@/lib/profile/snapshots";
import { currentPreferencesSnapshotId } from "@/lib/scoring/profile";

import { expectNoDrift, fixture, scoreRow, scores } from "./current-scores-support";

beforeAll(() => { process.env.DATABASE_URL = inject("testDatabaseUrl"); });
afterAll(closeDb);

const OLD_TEXT = "version: old\n";
const NEW_TEXT = "version: new\n";
const now = new Date();
const timezone = "UTC";

type Job = typeof jobs.$inferSelect;

async function filterAndScore(db: Db, job: Job, snapshotId: number, score: number, level: string): Promise<void> {
  await scoreTransaction(db, (tx) => insertFilterResults(tx, snapshotId, [{ jobId: job.id, filterResult: "passed", filterReasons: [] }]));
  await saveRowScore(db, job, snapshotId, score, level);
}

/** What a scoring run stores in the job's row of the snapshot. */
async function saveRowScore(db: Db, job: Job, snapshotId: number, score: number, level: string): Promise<void> {
  const [row] = await db.select({ id: scores.id }).from(scores).where(and(eq(scores.jobId, job.id), eq(scores.profileSnapshotId, snapshotId)));
  await scoreTransaction(db, (tx) => saveScore(tx, {
    rowId: row!.id, jobId: job.id, profileSnapshotId: snapshotId, provider: "fixture", model: "fixture",
    aiScore: score, germanPenalty: 0, score, signalBonus: 0, rankValue: score, fitReasons: [`reason ${score}`], gaps: [],
    summaries: { en: `Summary ${score}` }, outputLang: "en", germanLevel: level, germanLevelAi: level, germanLevelSource: "rule", promptVersion: "fixture",
  }));
}

/** One job scored 60 under the old version, then 90 under the new one. */
async function scoredTwice(db: Db) {
  const [job] = await fixture(db);
  const { snapshot: older } = await recordProfileSnapshot(db, "preferences", OLD_TEXT);
  await filterAndScore(db, job!, older.id, 60, "b1");
  const { snapshot: newer } = await recordProfileSnapshot(db, "preferences", NEW_TEXT);
  await filterAndScore(db, job!, newer.id, 90, "c2");
  return { job: job!, older, newer };
}

describe("rolling the preferences back", () => {
  it("every reader shows the rescored row of the version rolled back to, not the abandoned one", async () => {
    const db = getDb();
    const { job, older } = await scoredTwice(db);
    await recordProfileSnapshot(db, "preferences", OLD_TEXT);
    await saveRowScore(db, job, older.id, 65, "b1");

    // the detail page
    expect((await getJobDetail(db, job.id))?.score).toMatchObject({ score: 65, stale: false, fitReasons: ["reason 65"] });
    // the lists, Today and MCP's search read the projection through the same card query
    expect((await db.select().from(jobCurrentScores))[0]).toMatchObject({ score: 65, rankValue: 65, stale: false });
    await expectNoDrift(db);
    const page = await listJobs(db, { filters: {}, sort: "rank", page: 1, pageSize: 20, timezone });
    expect(page.jobs.map((card) => card.rank?.score)).toEqual([65]);
    const today = await listTodayJobs(db, { now, timezone });
    expect(today.find((card) => card.id === job.id)?.rank?.score).toBe(65);
    // the push and the automatic follow-ups pick by the newest row's rank: 65 is under a line of 80, the abandoned 90 is not
    expect((await getPushCandidate(db, job.id))?.score).toMatchObject({ score: 65, rankValue: 65 });
    await db.update(jobs).set({ description: "A description." }).where(eq(jobs.id, job.id));
    expect(await listTranslationCandidates(db, { lang: "zh", minRank: 80, limit: 10 })).toEqual([]);
    expect(await listBreakdownCandidates(db, { minRank: 80, limit: 10 })).toEqual([]);
    expect(await listHighScoreResearchCandidates(db, { minRank: 80, maxAgeDays: 365, limit: 10, now, isExcludedCompany: () => false })).toEqual([]);
    // the market regression snapshot reads the same row
    expect((await listRegressFactRows(db)).find((row) => Number(row.id) === job.id)).toMatchObject({ german_level: "b1" });
  });

  it("shows the old version's score, marked stale, until it is rescored", async () => {
    const db = getDb();
    const { job } = await scoredTwice(db);
    const rollback = await recordProfileSnapshot(db, "preferences", OLD_TEXT);
    expect(rollback.staleMarked).toBe(1);
    expect((await getJobDetail(db, job.id))?.score).toMatchObject({ score: 60, stale: true });
    expect((await db.select().from(jobCurrentScores))[0]).toMatchObject({ score: 60, stale: true });
    await expectNoDrift(db);
  });

  it("the filter result of the version rolled back to decides whether the job is listed", async () => {
    const db = getDb();
    const [job] = await fixture(db);
    const { snapshot: older } = await recordProfileSnapshot(db, "preferences", OLD_TEXT);
    await scoreTransaction(db, (tx) => insertFilterResults(tx, older.id, [{ jobId: job!.id, filterResult: "filtered_out", filterReasons: ["excluded"] }]));
    const { snapshot: newer } = await recordProfileSnapshot(db, "preferences", NEW_TEXT);
    await scoreTransaction(db, (tx) => insertFilterResults(tx, newer.id, [{ jobId: job!.id, filterResult: "passed", filterReasons: [] }]));
    expect((await getNavCounts(db, { now, timezone })).jobs).toBe(1);
    await recordProfileSnapshot(db, "preferences", OLD_TEXT);
    expect((await getNavCounts(db, { now, timezone })).jobs).toBe(0);
    await expectNoDrift(db);
  });

  it("keeps a job without a row for that version on the score it has", async () => {
    const db = getDb();
    const [job] = await fixture(db);
    await recordProfileSnapshot(db, "preferences", OLD_TEXT);
    const { snapshot: newer } = await recordProfileSnapshot(db, "preferences", NEW_TEXT);
    await filterAndScore(db, job!, newer.id, 90, "c2");
    await recordProfileSnapshot(db, "preferences", OLD_TEXT);
    expect((await getJobDetail(db, job!.id))?.score).toMatchObject({ score: 90, stale: true });
    await expectNoDrift(db);
  });

  it("does not bring back a version by saving a score into an abandoned row afterwards", async () => {
    const db = getDb();
    const { job, older, newer } = await scoredTwice(db);
    await recordProfileSnapshot(db, "preferences", OLD_TEXT);
    await saveRowScore(db, job, older.id, 65, "b1");
    await saveRowScore(db, job, newer.id, 95, "c2"); // a scoring run that started before the rollback
    expect((await getJobDetail(db, job.id))?.score).toMatchObject({ score: 65 });
    await expectNoDrift(db);
  });

  it("does not change the row order of a profile file scores are not filed under", async () => {
    const db = getDb();
    const { job } = await scoredTwice(db);
    await recordProfileSnapshot(db, "me", "me: 1\n");
    await recordProfileSnapshot(db, "me", "me: 2\n");
    await recordProfileSnapshot(db, "me", "me: 1\n");
    expect((await getJobDetail(db, job.id))?.score).toMatchObject({ score: 90 });
  });
});

describe("a preferences file edited back to old text by hand", () => {
  it("makes the old version the current one for scoring and reconciliation alike", async () => {
    const db = getDb();
    const { job, older, newer } = await scoredTwice(db);
    expect((await getLatestProfileSnapshot(db, "preferences"))?.id).toBe(newer.id);

    const snapshotId = await currentPreferencesSnapshotId(db, { meYaml: "me: 1\n", preferencesYaml: OLD_TEXT });
    expect(snapshotId).toBe(older.id);
    expect((await getLatestProfileSnapshot(db, "preferences"))?.id).toBe(older.id);
    // like a rollback in the app: the other version goes stale, and the page shows the version in the file
    const rows = await db.select().from(scores).where(eq(scores.profileSnapshotId, newer.id));
    expect(rows).toMatchObject([{ stale: true }]);
    expect((await getJobDetail(db, job.id))?.score).toMatchObject({ score: 60 });
    await expectNoDrift(db);
  });

  it("changes nothing when the text is the current version already", async () => {
    const db = getDb();
    const { newer } = await scoredTwice(db);
    const before = await db.select().from(scores).orderBy(scores.id);
    expect((await snapshotForProfileText(db, "preferences", NEW_TEXT)).savedAt).toEqual(newer.savedAt);
    expect(await db.select().from(scores).orderBy(scores.id)).toEqual(before);
  });
});

describe("rows left out of order before this was fixed", () => {
  it("are put in order again, and a second run changes nothing", async () => {
    const db = getDb();
    const [one, two] = await fixture(db, 2);
    const [older] = await db.insert(profileSnapshots).values({ kind: "preferences", hash: "older", contentYaml: OLD_TEXT }).returning();
    const [newer] = await db.insert(profileSnapshots).values({ kind: "preferences", hash: "newer", contentYaml: NEW_TEXT }).returning();
    const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
    await scoreTransaction(db, async (tx) => {
      await tx.insert(scores).values([
        { ...scoreRow(one!.id, 60), profileSnapshotId: older!.id, createdAt: at(1) },
        { ...scoreRow(one!.id, 90), profileSnapshotId: newer!.id, createdAt: at(2) },
        { ...scoreRow(two!.id, 70), profileSnapshotId: older!.id, createdAt: at(3) },
      ]);
      tx.touch([one!.id, two!.id]);
    });

    expect(await scoreTransaction(db, (tx) => promoteSnapshotScores(tx, older!.id))).toBe(1);
    expect((await getJobDetail(db, one!.id))?.score).toMatchObject({ score: 60 });
    await expectNoDrift(db);
    // the row that was the newest already keeps its date
    const [untouched] = await db.select().from(scores).where(eq(scores.jobId, two!.id));
    expect(untouched!.createdAt).toEqual(at(3));
    expect(await scoreTransaction(db, (tx) => promoteSnapshotScores(tx, older!.id))).toBe(0);
  });

  it("sorts first even when another row is dated ahead of the clock", async () => {
    const db = getDb();
    const [job] = await fixture(db);
    const [older] = await db.insert(profileSnapshots).values({ kind: "preferences", hash: "older", contentYaml: OLD_TEXT }).returning();
    const [newer] = await db.insert(profileSnapshots).values({ kind: "preferences", hash: "newer", contentYaml: NEW_TEXT }).returning();
    await scoreTransaction(db, async (tx) => {
      await tx.insert(scores).values([
        { ...scoreRow(job!.id, 60), profileSnapshotId: older!.id },
        { ...scoreRow(job!.id, 90), profileSnapshotId: newer!.id, createdAt: new Date(Date.now() + 86_400_000) },
      ]);
      tx.touch([job!.id]);
    });
    await scoreTransaction(db, (tx) => promoteSnapshotScores(tx, older!.id));
    expect((await getJobDetail(db, job!.id))?.score).toMatchObject({ score: 60 });
    expect(await scoreTransaction(db, (tx) => promoteSnapshotScores(tx, older!.id))).toBe(0);
  });
});
