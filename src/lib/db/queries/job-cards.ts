import { currentScoresTableExists, invalidateCurrentScores, missingCurrentScores } from "../repos/current-scores";
import { and, asc, desc, eq, inArray, isNotNull, notInArray, sql, type SQL, WithSubquery, is } from "drizzle-orm";
import { alias, PgTransaction } from "drizzle-orm/pg-core";
import type { SubqueryWithSelection } from "drizzle-orm/pg-core";

import type { Executor } from "../executor";
import { getApplicationStatuses } from "../repos/applications";
import { getFavoriteStates } from "../repos/favorites";
import { seenSql } from "../repos/seen";
import { parseLinkCheck } from "@/lib/jobs/link-check-evidence";
import { ghostTrustedKeys } from "@/lib/ghost/settings";
import { closedReasonSql, effectiveStatusSql, lastListedSql } from "./job-status";
import { loadGhostLevels } from "../repos/ghost";
import { loadTrapCounts } from "../repos/traps";
import { loadVisaStatuses } from "../repos/visa";
import { channels, companies, jobSources, jobs, scores, signals, jobCurrentScores } from "../schema";
import { asContract, asGermanLevel, parseLocations, parseSalary } from "./parse";
import type { JobCard, JobRank, JobSignal, JobSourceRef } from "./types";
import { summariesOf } from "../summaries";

/** numeric columns come back as text through a raw `case` expression */
const nullableNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** The columns of the newest `scores` row of a job that the lists read. */
const newestColumns = () => ({
  jobId: scores.jobId,
  filterResult: scores.filterResult,
  filterReasons: scores.filterReasons,
  score: scores.score,
  rankValue: scores.rankValue,
  signalBonus: scores.signalBonus,
  stale: scores.stale,
  germanLevel: scores.germanLevel,
  summaries: scores.summaries,
  summaryZh: scores.summaryZh,
  summaryEn: scores.summaryEn,
  outputLang: scores.outputLang,
});

/** The columns of the newest `scores` row of a job that has an AI score (the stale fallback). */
const scoredColumns = () => ({
  jobId: scores.jobId,
  score: scores.score,
  rankValue: scores.rankValue,
  signalBonus: scores.signalBonus,
  germanLevel: scores.germanLevel,
  summaries: scores.summaries,
  summaryZh: scores.summaryZh,
  summaryEn: scores.summaryEn,
  outputLang: scores.outputLang,
});

/** "Newest" for a job's `scores` rows: the latest created, the higher id on a tie. */
const newestFirst = () => [desc(scores.createdAt), desc(scores.id)] as const;

/** What a job shows as its score, from its newest row and its newest scored row (see `latestScoreCte`). */
function latestColumns(newest: SubqueryWithSelection<ReturnType<typeof newestColumns>, "newest_score">, scored: SubqueryWithSelection<ReturnType<typeof scoredColumns>, "scored_score">) {
  const fallback = sql`(${newest.score} is null and ${newest.filterResult} = 'passed' and ${scored.jobId} is not null)`;
  return {
    jobId: newest.jobId,
    filterResult: newest.filterResult,
    filterReasons: newest.filterReasons,
    rankValue: sql<number | null>`case when ${fallback} then ${scored.rankValue} else ${newest.rankValue} end`.mapWith(nullableNumber).as("rank_value"),
    score: sql<number | null>`case when ${fallback} then ${scored.score} else ${newest.score} end`.as("score"),
    signalBonus: sql<number>`case when ${fallback} then ${scored.signalBonus} else ${newest.signalBonus} end`.mapWith(Number).as("signal_bonus"),
    stale: sql<boolean>`case when ${fallback} then true else (${newest.score} is not null and ${newest.stale}) end`.as("stale"),
    germanLevel: sql<string | null>`case when ${fallback} then ${scored.germanLevel} else ${newest.germanLevel} end`.as("german_level"),
    summaryZh: sql<string | null>`case when ${fallback} then ${scored.summaryZh} else ${newest.summaryZh} end`.as("summary_zh"),
    summaryEn: sql<string | null>`case when ${fallback} then ${scored.summaryEn} else ${newest.summaryEn} end`.as("summary_en"),
    summaries: sql<unknown>`case when ${fallback} then ${scored.summaries} else ${newest.summaries} end`.as("summaries"),
    outputLang: sql<string | null>`case when ${fallback} then ${scored.outputLang} else ${newest.outputLang} end`.as("output_lang"),
  };
}

/**
 * What a job shows as its score, as a CTE the list queries left-join: the newest `scores` row, except
 * that a newest row which passed the hard filter but has no AI score yet (a profile change made a new
 * snapshot row that is waiting to be scored) shows the newest row that does have a score, marked
 * stale, so the lists never go blank after the user edits a profile. The filter result and reasons
 * always come from the newest row.
 *
 * The CTE works out the score of every job at once: the right shape for the /jobs list, which sorts all
 * its jobs by rank. A query over a few jobs (Today, a cycle) uses `latestScoreLateral` instead.
 */
export function latestScoreCte(db: Executor, jobIds?: readonly number[], sources = false) {
  const newest = db
    .selectDistinctOn([scores.jobId], { ...newestColumns(), ...(sources ? { id: scores.id } : {}) })
    .from(scores)
    .where(jobIds ? inArray(scores.jobId, [...jobIds]) : undefined)
    .orderBy(scores.jobId, ...newestFirst())
    .as("newest_score");
  const scored = db
    .selectDistinctOn([scores.jobId], { ...scoredColumns(), ...(sources ? { id: scores.id } : {}) })
    .from(scores)
    .where(and(isNotNull(scores.score), jobIds ? inArray(scores.jobId, [...jobIds]) : undefined))
    .orderBy(scores.jobId, ...newestFirst())
    .as("scored_score");
  return db.$with("latest_score").as(db.select({ ...latestColumns(newest, scored), ...(sources ? sourceColumns() : {}) }).from(newest).leftJoin(scored, eq(scored.jobId, newest.jobId)));
}

/**
 * The same score as `latestScoreCte` for the job of the current row of `jobs`, as a subquery to join with
 * `leftJoinLateral` on true: two index lookups per job (`scores_job_latest_idx`,
 * `scores_job_latest_scored_idx`) instead of the score of every job. For queries that select few jobs; a
 * job without `scores` rows gets nulls, as with the CTE.
 */
export function latestScoreLateral(db: Executor, jobIds?: readonly number[], sources = false) {
  const newest = db
    .select({ ...newestColumns(), ...(sources ? { id: scores.id } : {}) })
    .from(scores)
    .where(eq(scores.jobId, jobIds ? sql`selected_jobs.job_id` : jobs.id))
    .orderBy(...newestFirst())
    .limit(1)
    .as("newest_score");
  const scored = db
    .select({ ...scoredColumns(), ...(sources ? { id: scores.id } : {}) })
    .from(scores)
    .where(and(eq(scores.jobId, jobIds ? sql`selected_jobs.job_id` : jobs.id), isNotNull(scores.score)))
    .orderBy(...newestFirst())
    .limit(1)
    .as("scored_score");
  const query = db.select({ ...latestColumns(newest, scored), ...(sources ? sourceColumns() : {}) });
  if (jobIds) return query.from(sql`unnest(${`{${jobIds.join(",")}}`}::bigint[]) as selected_jobs(job_id)`)
    .innerJoinLateral(newest, sql`true`).leftJoinLateral(scored, sql`true`).as("latest_score");
  return query.from(newest).leftJoin(scored, eq(scored.jobId, newest.jobId)).as("latest_score");
}

function sourceColumns() {
  return {
    newestScoreId: sql<number>`"newest_score"."id"`.as("newest_score_id"),
    scoredScoreId: sql<number | null>`"scored_score"."id"`.as("scored_score_id"),
  };
}

/** Temporary deployment compatibility: remove existence/fallback branches in the next minor release.
 * The rule builders remain the authority for refresh and consistency checks.
 */
const projectedScore = () => alias(jobCurrentScores, "latest_score");
export function currentScore(db: Executor, shape: "set"): Promise<ReturnType<typeof projectedScore> | ReturnType<typeof latestScoreCte>>;
export function currentScore(db: Executor, shape: "few"): ReturnType<typeof currentScoreFew>;
export async function currentScore(db: Executor, shape: "set" | "few") {
  if (shape === "few") return currentScoreFew(db);
  if (await currentScoresTableExists(db)) return projectedScore();
  return latestScoreCte(db);
}

/** Attach CTEs only for the legacy source; a projected source is an ordinary table join. */
export function withCurrentScore(db: Executor, latest: LatestScore, ...ctes: WithSubquery[]) {
  return db.with(...(is(latest, WithSubquery) ? [latest] : []), ...ctes);
}

/** The few-job source retains its lateral join shape, with a direct indexed projection lookup. */
export async function currentScoreFew(db: Executor) {
  if (!(await currentScoresTableExists(db))) return latestScoreLateral(db);
  return db.select({
    jobId: jobCurrentScores.jobId, filterResult: jobCurrentScores.filterResult, filterReasons: jobCurrentScores.filterReasons,
    score: jobCurrentScores.score, rankValue: jobCurrentScores.rankValue, signalBonus: jobCurrentScores.signalBonus,
    stale: jobCurrentScores.stale, germanLevel: jobCurrentScores.germanLevel, summaries: jobCurrentScores.summaries,
    summaryZh: jobCurrentScores.summaryZh, summaryEn: jobCurrentScores.summaryEn, outputLang: jobCurrentScores.outputLang,
  }).from(jobCurrentScores).where(eq(jobCurrentScores.jobId, jobs.id)).as("latest_score");
}

/** Retry a deployment-window missing-table error once after invalidating the positive cache. */
export async function currentScoreRead<T>(db: Executor, read: () => Promise<T>): Promise<T> {
  const attempt = () => is(db, PgTransaction) ? db.transaction(() => read()) : read();
  try { return await attempt(); } catch (error) {
    if (!missingCurrentScores(error)) throw error;
    invalidateCurrentScores(db);
    return attempt();
  }
}

/** Either form of the latest score: the helpers below read the same columns from both. */
export type LatestScore = ReturnType<typeof latestScoreCte> | ReturnType<typeof latestScoreLateral> | ReturnType<typeof projectedScore> | Awaited<ReturnType<typeof currentScoreFew>>;

/**
 * The German level a job requires as the dashboard shows it: the one the scoring settled on (rule
 * value cross-checked with the AI) when the job has been scored, else the pipeline's rule value.
 */
export function resolvedGermanLevel(latest: LatestScore): SQL<string> {
  return sql<string>`coalesce(${latest.germanLevel}, ${jobs.germanLevelRequired})`;
}

/** WHERE condition that hides jobs requiring one of `levels` (the "hide German-required" quick filter). */
export function hideGermanLevels(latest: LatestScore, levels: readonly string[]): SQL | undefined {
  return levels.length > 0 ? notInArray(resolvedGermanLevel(latest), [...levels]) : undefined;
}

/**
 * Columns of `jobs` + company name + latest score the card needs; select them with these. `ux`: the seen / closure tables exist
 * (`uxTablesReady`); before the migration every job reads as seen.
 */
export function cardColumns(latest: LatestScore, ux = true, dormant = false, listing = false) {
  return {
    id: jobs.id,
    title: jobs.title,
    companyId: jobs.companyId,
    companyName: companies.name,
    locationsJson: jobs.locationsJson,
    workplace: jobs.workplace,
    contract: jobs.contract,
    isAgency: jobs.isAgency,
    germanLevelRequired: resolvedGermanLevel(latest),
    status: effectiveStatusSql(ux),
    closedReason: closedReasonSql(ux, dormant),
    linkCheckJson: ux ? sql<unknown>`${jobs.linkCheckJson}` : sql<unknown>`null`,
    postedAt: jobs.postedAt,
    firstSeenAt: jobs.firstSeenAt,
    lastSeenAt: jobs.lastSeenAt,
    lastListedAt: lastListedSql(listing),
    relistedAt: listing ? jobs.relistedAt : sql<Date | null>`null`,
    relistCount: listing ? sql<number>`coalesce(${jobs.relistCount}, 0)`.mapWith(Number) : sql<number>`0`,
    salaryJson: jobs.salaryJson,
    skills: jobs.skills,
    rankValue: latest.rankValue,
    score: latest.score,
    signalBonus: latest.signalBonus,
    filterResult: latest.filterResult,
    filterReasons: latest.filterReasons,
    stale: latest.stale,
    summaryZh: latest.summaryZh,
    summaryEn: latest.summaryEn,
    summaries: latest.summaries,
    outputLang: latest.outputLang,
    seen: ux ? seenSql() : sql<boolean>`true`,
  };
}

export type CardRow = {
  id: number;
  title: string;
  companyId: number;
  companyName: string;
  locationsJson: unknown;
  workplace: JobCard["workplace"];
  contract: string;
  isAgency: boolean;
  germanLevelRequired: string;
  status: JobCard["status"];
  closedReason: JobCard["closedReason"];
  linkCheckJson: unknown;
  postedAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastListedAt: Date | null;
  relistedAt: Date | null;
  relistCount: number;
  salaryJson: unknown;
  skills: string[];
  rankValue: number | null;
  score: number | null;
  signalBonus: number | null;
  filterResult: "passed" | "filtered_out" | null;
  filterReasons: string[] | null;
  stale: boolean | null;
  summaryZh: string | null;
  summaryEn: string | null;
  summaries: unknown;
  outputLang: string | null;
  seen: boolean;
};

/** Sources of the given jobs, best apply link (lowest priority number) first. */
export async function loadSources(db: Executor, jobIds: readonly number[]): Promise<Map<number, JobSourceRef[]>> {
  const out = new Map<number, JobSourceRef[]>();
  if (jobIds.length === 0) return out;
  const rows = await db
    .select({
      jobId: jobSources.jobId,
      channelId: jobSources.channelId,
      family: channels.family,
      url: jobSources.url,
      applyUrl: jobSources.applyUrl,
      locationLabel: jobSources.locationLabel,
      priority: jobSources.priority,
    })
    .from(jobSources)
    .innerJoin(channels, eq(channels.id, jobSources.channelId))
    .where(inArray(jobSources.jobId, [...jobIds]))
    .orderBy(asc(jobSources.priority), asc(jobSources.firstSeenAt), asc(jobSources.id));
  for (const { jobId, ...ref } of rows) {
    const list = out.get(jobId) ?? [];
    list.push(ref);
    out.set(jobId, list);
  }
  return out;
}

export async function loadSignals(db: Executor, jobIds: readonly number[]): Promise<Map<number, JobSignal[]>> {
  const out = new Map<number, JobSignal[]>();
  if (jobIds.length === 0) return out;
  const rows = await db
    .select({
      id: signals.id,
      jobId: signals.jobId,
      tier: signals.tier,
      kind: signals.kind,
      value: signals.valueJson,
      quote: signals.quote,
      quoteOffset: signals.quoteOffset,
      quoteSource: signals.quoteSource,
      extractor: signals.extractor,
    })
    .from(signals)
    .where(inArray(signals.jobId, [...jobIds]))
    .orderBy(asc(signals.tier), asc(signals.id));
  for (const { jobId, ...signal } of rows) {
    const list = out.get(jobId) ?? [];
    list.push(signal);
    out.set(jobId, list);
  }
  return out;
}

export function toRank(row: Pick<CardRow, "rankValue" | "score" | "signalBonus" | "filterResult" | "filterReasons" | "stale">): JobRank | null {
  if (row.filterResult === null) return null;
  return {
    rankValue: row.rankValue,
    score: row.score,
    signalBonus: row.signalBonus ?? 0,
    filterResult: row.filterResult,
    filterReasons: row.filterReasons ?? [],
    stale: row.score !== null && (row.stale ?? false),
  };
}

/** The AI one-line summary per language and the language of the AI texts; `texts` null when the job has none. */
export function toSummary(row: Pick<CardRow, "summaries" | "summaryZh" | "summaryEn" | "outputLang">): JobCard["summary"] {
  const texts = summariesOf(row);
  return Object.keys(texts).length === 0 ? null : { texts, outputLang: row.outputLang };
}

/** What `hydrateCards` attaches besides the always-needed parts. */
export interface HydrateOptions {
  /** Load the visa check results (the list badge); false when the badge is hidden, saving the query. Default true. */
  visa?: boolean;
  /** Load the ghost job marks (the list's score cell); only when ui.yaml turns the check on. Default false. */
  ghost?: boolean;
}

/** Turn card rows into cards by attaching sources, signals and the application status (3 queries for the whole page). */
export async function hydrateCards(db: Executor, rows: readonly CardRow[], options: HydrateOptions = {}): Promise<JobCard[]> {
  const ids = rows.map((r) => r.id);
  const [sources, signalMap, statuses, favorites, traps, visa, ghost] = await Promise.all([
    loadSources(db, ids),
    loadSignals(db, ids),
    getApplicationStatuses(db, ids),
    getFavoriteStates(db, ids),
    loadTrapCounts(db, ids),
    options.visa === false ? new Map<number, never>() : loadVisaStatuses(db, ids),
    options.ghost === true ? loadGhostLevels(db, ids, ghostTrustedKeys()) : new Map<number, never>(),
  ]);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    companyId: row.companyId,
    companyName: row.companyName,
    locations: parseLocations(row.locationsJson),
    workplace: row.workplace,
    contract: asContract(row.contract),
    isAgency: row.isAgency,
    germanLevelRequired: asGermanLevel(row.germanLevelRequired),
    status: row.status,
    postedAt: row.postedAt,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    lastListedAt: row.lastListedAt,
    relistedAt: row.relistedAt,
    relistCount: row.relistCount,
    salaryDisclosed: row.salaryJson !== null && row.salaryJson !== undefined,
    salary: parseSalary(row.salaryJson),
    skills: row.skills ?? [],
    sources: sources.get(row.id) ?? [],
    applicationStatus: statuses.get(row.id) ?? null,
    favorite: favorites.get(row.id) ?? null,
    rank: toRank(row),
    summary: toSummary(row),
    signals: signalMap.get(row.id) ?? [],
    traps: traps.get(row.id) ?? null,
    visa: visa.get(row.id) ?? null,
    ghost: ghost.get(row.id) ?? null,
    seen: row.seen,
    closedReason: row.closedReason,
    linkCheck: parseLinkCheck(row.linkCheckJson),
  }));
}
