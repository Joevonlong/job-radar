/** The stored breakdown of a job's JD and the queries around it (C9: all access to `job_breakdowns` lives here). */
import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";

import type { Executor } from "../executor";
import { companies, jobBreakdowns, jobs, scores } from "../schema";

import { descriptionHashSql } from "./translations";
import { notDormantSql } from "../queries/job-status";
import { dormancyReady } from "./dormancy";

export type JobBreakdownRow = typeof jobBreakdowns.$inferSelect;

export async function getJobBreakdown(db: Executor, jobId: number): Promise<JobBreakdownRow | null> {
  const [row] = await db.select().from(jobBreakdowns).where(eq(jobBreakdowns.jobId, jobId)).limit(1);
  return row ?? null;
}

export interface JobBreakdownInput {
  jobId: number;
  sourceHash: string;
  promptVersion: string;
  provider: string | null;
  model: string | null;
  content: unknown;
  droppedItems: number;
  /** The language the items are written in. */
  outputLang: string;
}

/** Insert or replace the job's breakdown (`analyzed_at` = now). */
export async function upsertJobBreakdown(db: Executor, input: JobBreakdownInput): Promise<void> {
  const at = new Date();
  await db
    .insert(jobBreakdowns)
    .values({ ...input, content: input.content, analyzedAt: at })
    .onConflictDoUpdate({
      target: jobBreakdowns.jobId,
      set: {
        sourceHash: input.sourceHash,
        promptVersion: input.promptVersion,
        provider: input.provider,
        model: input.model,
        content: input.content,
        droppedItems: input.droppedItems,
        outputLang: input.outputLang,
        analyzedAt: at,
      },
    });
}

export interface JobForBreakdown {
  id: number;
  title: string;
  company: string;
  description: string | null;
}

/** Title, company name and description for the prompt (null: unknown job). */
export async function getJobForBreakdown(db: Executor, jobId: number): Promise<JobForBreakdown | null> {
  const [row] = await db
    .select({ id: jobs.id, title: jobs.title, company: companies.name, description: jobs.description })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(eq(jobs.id, jobId))
    .limit(1);
  return row ?? null;
}

export interface BreakdownCandidate {
  jobId: number;
  rankValue: number;
}

/**
 * Jobs the automatic mode should break down: the newest score has rank_value >= minRank, the job is not closed, it has
 * a description, and it has no breakdown or one made from another description (`source_hash` differs). A breakdown of
 * an older prompt version does NOT make a job a candidate (no automatic re-run on a version change). Best rank first.
 */
export async function listBreakdownCandidates(db: Executor, args: { minRank: number; limit: number }): Promise<BreakdownCandidate[]> {
  const latest = db
    .selectDistinctOn([scores.jobId], { jobId: scores.jobId, rankValue: scores.rankValue })
    .from(scores)
    .orderBy(scores.jobId, desc(scores.createdAt), desc(scores.id))
    .as("latest_score");
  const rows = await db
    .select({ jobId: jobs.id, rankValue: latest.rankValue })
    .from(jobs)
    .innerJoin(latest, eq(latest.jobId, jobs.id))
    .leftJoin(jobBreakdowns, eq(jobBreakdowns.jobId, jobs.id))
    .where(
      and(
        isNotNull(latest.rankValue),
        sql`${latest.rankValue} >= ${args.minRank}`,
        ne(jobs.status, "closed"),
        notDormantSql(await dormancyReady(db)),
        isNotNull(jobs.description),
        sql`btrim(${jobs.description}) <> ''`,
        sql`(${jobBreakdowns.jobId} is null or ${jobBreakdowns.sourceHash} <> ${descriptionHashSql})`,
      ),
    )
    .orderBy(desc(latest.rankValue), jobs.id)
    .limit(args.limit);
  const out: BreakdownCandidate[] = [];
  for (const row of rows) if (row.rankValue !== null) out.push({ jobId: row.jobId, rankValue: row.rankValue });
  return out;
}
