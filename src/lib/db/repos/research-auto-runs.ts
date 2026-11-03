/** The automatic research runs: what limits them per 24 hours, and which job counted when. */
import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";

import type { Executor } from "../executor";
import { notDormantSql } from "../queries/job-status";
import { jobFavorites, jobs, researchAutoRuns, scores } from "../schema";
import { dormancyReady } from "./dormancy";

export const RESEARCH_AUTO_TRIGGERS = ["favorite", "status", "high_score_new"] as const;
export type ResearchAutoTrigger = (typeof RESEARCH_AUTO_TRIGGERS)[number];

/** What each part of a run did; stored as it was at the end of the run. */
export type ResearchAutoItems = Record<string, string>;

/** Advisory lock key of the automatic research limits (any constant; only this code takes it). */
const AUTO_LOCK = 147_002;

const DAY_MS = 86_400_000;

const sinceDay = (now: Date): Date => new Date(now.getTime() - DAY_MS);

const counted = (trigger: ResearchAutoTrigger): readonly ResearchAutoTrigger[] => (trigger === "high_score_new" ? ["high_score_new"] : ["favorite", "status"]);

export async function hasRecentAutoRun(db: Executor, jobId: number, now: Date): Promise<boolean> {
  const [row] = await db.select({ id: researchAutoRuns.id }).from(researchAutoRuns).where(and(eq(researchAutoRuns.jobId, jobId), gte(researchAutoRuns.createdAt, sinceDay(now)))).limit(1);
  return row !== undefined;
}

export type AutoRunReservation = { state: "reserved"; runId: number } | { state: "recent" } | { state: "cap_reached"; used: number };

/**
 * Take one automatic run for a job: the job must not have had one in the last 24 hours, and its trigger's own limit must have
 * room (saved and status changes share one, high-score new jobs have another). Counted and inserted under one lock, so
 * concurrent saves can never pass the limit or count a job twice.
 */
export async function reserveAutoResearchRun(db: Executor, input: { jobId: number; trigger: ResearchAutoTrigger; items: ResearchAutoItems; maxPerDay: number; now: Date }): Promise<AutoRunReservation> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${AUTO_LOCK})`);
    if (await hasRecentAutoRun(tx, input.jobId, input.now)) return { state: "recent" };
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(researchAutoRuns)
      .where(and(inArray(researchAutoRuns.trigger, [...counted(input.trigger)]), gte(researchAutoRuns.createdAt, sinceDay(input.now))));
    const used = count?.n ?? 0;
    if (used >= input.maxPerDay) return { state: "cap_reached", used };
    const [row] = await tx.insert(researchAutoRuns).values({ jobId: input.jobId, trigger: input.trigger, items: input.items, createdAt: input.now }).returning({ id: researchAutoRuns.id });
    if (!row) throw new Error("reserveAutoResearchRun: insert returned no row");
    return { state: "reserved", runId: row.id };
  });
}

export async function updateAutoRunItems(db: Executor, runId: number, items: ResearchAutoItems): Promise<void> {
  await db.update(researchAutoRuns).set({ items }).where(eq(researchAutoRuns.id, runId));
}

/**
 * High-score new jobs that may be researched: rank value at least `minRank`, first seen within `maxAgeDays`, open, not starred
 * (a star has its own trigger), and without a run yet; the best first.
 */
export async function listHighScoreResearchCandidates(db: Executor, args: { minRank: number; maxAgeDays: number; limit: number; now: Date }): Promise<number[]> {
  const latest = db.selectDistinctOn([scores.jobId], { jobId: scores.jobId, rankValue: scores.rankValue }).from(scores).orderBy(scores.jobId, desc(scores.createdAt), desc(scores.id)).as("latest_score");
  const rows = await db
    .select({ jobId: jobs.id })
    .from(jobs)
    .innerJoin(latest, eq(latest.jobId, jobs.id))
    .leftJoin(jobFavorites, eq(jobFavorites.jobId, jobs.id))
    .leftJoin(researchAutoRuns, eq(researchAutoRuns.jobId, jobs.id))
    .where(
      and(
        isNotNull(latest.rankValue),
        sql`${latest.rankValue} >= ${args.minRank}`,
        gte(jobs.firstSeenAt, new Date(args.now.getTime() - args.maxAgeDays * DAY_MS)),
        ne(jobs.status, "closed"),
        notDormantSql(await dormancyReady(db)),
        isNull(jobFavorites.jobId),
        isNull(researchAutoRuns.id),
      ),
    )
    .orderBy(desc(latest.rankValue), jobs.id)
    .limit(args.limit);
  return rows.map((row) => row.jobId);
}
