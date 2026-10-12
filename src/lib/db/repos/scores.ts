import { and, count, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";

import type { ReasonEvidence } from "@/lib/scoring/evidence";

import type { Db } from "../client";
import type { Executor } from "../executor";
import { companies, jobs, profileSnapshots, scores } from "../schema";
import { effectivelyActiveSql } from "../queries/job-status";
import { uxTablesReady } from "./ux-tables";

// The score queue takes the jobs that show as active (`effectivelyActiveSql`): one the user marked closed is not scored, one
// the user kept open ("Still open") is, even when a check marked it possibly closed.

/**
 * What `scores.stale` means: the row HAS AI output (`score IS NOT NULL`) that was produced under
 * an outdated profile or prompt. A row without a score (the hard filter's result waiting for the AI, or
 * a filtered-out job that is never scored) is never stale, whichever snapshot or prompt version it
 * carries. Every code path that sets the flag must include this condition.
 */
const hasAiScore = isNotNull(scores.score);

/**
 * Profile changed: every score computed from another snapshot is out of date (the scorer re-scores
 * those). Scores without a snapshot reference are left alone, and so are rows without a score
 * (filter-step rows have nothing to be out of date). Returns the number of rows newly marked stale.
 */
export async function markScoresStaleExcept(db: Db, currentSnapshotId: number): Promise<number> {
  const rows = await db
    .update(scores)
    .set({ stale: true })
    .where(and(hasAiScore, ne(scores.profileSnapshotId, currentSnapshotId), eq(scores.stale, false)))
    .returning({ id: scores.id });
  return rows.length;
}

/** Number of scores (rows with AI output) currently flagged stale: what "rescore N" would process. */
export async function countStaleScores(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(scores).where(and(hasAiScore, eq(scores.stale, true)));
  return row?.n ?? 0;
}

// ---------------------------------------------------------------- AI scoring

/** A job the scoring task should send to the AI, with what is needed to build the prompt. */
export interface ScoreCandidate {
  jobId: number;
  title: string;
  company: string;
  locationsJson: unknown;
  workplace: string;
  seniority: string;
  contract: string;
  salaryJson: unknown;
  description: string | null;
  /** The pipeline's rule-based German level (`jobs.german_level_required`). */
  germanLevelRule: string;
  /** The job's row for the current profile snapshot, made by the hard filter. */
  existing: { id: number; signalBonus: number; hasScore: boolean };
}

export interface ListScoreCandidatesOptions {
  /** The current preferences snapshot: scores live in the job's row for this snapshot. */
  snapshotId: number;
  limit: number;
  /** `stale`: only re-scores (the "rescore N" control); default: new jobs first, then stale scores. */
  only?: "stale";
  /** Only these jobs (those that need a score; the others are not returned). */
  jobIds?: readonly number[];
}

/** The job's `scores` row for one profile snapshot (at most one: the filter step and scoring share it). */
function rowsOfSnapshot(db: Executor, snapshotId: number) {
  return db
    .$with("snapshot_row")
    .as(
      db
        .select({ id: scores.id, jobId: scores.jobId, filterResult: scores.filterResult, filterReasons: scores.filterReasons, score: scores.score, stale: scores.stale, signalBonus: scores.signalBonus })
        .from(scores)
        .where(eq(scores.profileSnapshotId, snapshotId)),
    );
}

/**
 * Active jobs that still need an AI score, newest first (`first_seen_at`). Only jobs the hard filter
 * has passed under the current snapshot are scored: a row with filter_result `passed` that
 * has no score yet, or a stale score. A job without a row for the snapshot is left for the filter
 * step of the next cycle (it runs before the `ai` step); filtered-out jobs are never scored. New jobs
 * come before stale re-scores so a profile change cannot starve new postings.
 */
export async function listScoreCandidates(db: Executor, options: ListScoreCandidatesOptions): Promise<ScoreCandidate[]> {
  const row = rowsOfSnapshot(db, options.snapshotId);
  const isStaleScore = and(isNotNull(row.score), eq(row.stale, true));
  const needsScore = and(eq(row.filterResult, "passed"), or(isNull(row.score), isStaleScore));
  const staleOnly = and(eq(row.filterResult, "passed"), isStaleScore);
  const rows = await db
    .with(row)
    .select({
      jobId: jobs.id,
      title: jobs.title,
      company: companies.name,
      locationsJson: jobs.locationsJson,
      workplace: jobs.workplace,
      seniority: jobs.seniority,
      contract: jobs.contract,
      salaryJson: jobs.salaryJson,
      description: jobs.description,
      germanLevelRule: jobs.germanLevelRequired,
      rowId: row.id,
      signalBonus: row.signalBonus,
      filterReasons: row.filterReasons,
      score: row.score,
    })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .innerJoin(row, eq(row.jobId, jobs.id))
    .where(and(effectivelyActiveSql(await uxTablesReady(db)), options.only === "stale" ? staleOnly : needsScore, options.jobIds ? inArray(jobs.id, [...options.jobIds]) : undefined))
    .orderBy(sql`(${row.stale} is true and ${row.score} is not null) asc`, desc(jobs.firstSeenAt), desc(jobs.id))
    .limit(Math.max(0, options.limit));
  return rows.map((r) => ({
    jobId: r.jobId,
    title: r.title,
    company: r.company,
    locationsJson: r.locationsJson,
    workplace: r.workplace,
    seniority: r.seniority,
    contract: r.contract,
    salaryJson: r.salaryJson,
    description: r.description,
    germanLevelRule: r.germanLevelRule,
    existing: { id: r.rowId, signalBonus: r.signalBonus ?? 0, hasScore: r.score !== null },
  }));
}

/**
 * A job waiting for a score, with only what the cheap pre-score reads (no description: the queue can
 * hold hundreds of jobs and the AI only gets the top of it).
 */
export interface ScoreQueueItem {
  jobId: number;
  title: string;
  company: string;
  locationsJson: unknown;
  workplace: string;
  seniority: string;
  germanLevelRule: string;
  postedAt: Date | null;
  firstSeenAt: Date;
  /** The signal bonus stored in the job's row for the snapshot (0 until the signals step ran). */
  signalBonus: number;
  /** The hard filter's notes on the kept job (`scores.filter_reasons`), e.g. `remote_scope_unknown`. */
  filterReasons: string[];
  /** True for a stale re-score, false for a job that never had a score. */
  hasScore: boolean;
}

/**
 * Every job that needs an AI score under the snapshot (the same set as `listScoreCandidates`, without
 * a limit), in no particular order: the scoring run ranks them (`orderByPriority`) and takes the top.
 */
export async function listScoreQueue(db: Executor, options: { snapshotId: number; only?: "stale"; jobIds?: readonly number[] }): Promise<ScoreQueueItem[]> {
  const row = rowsOfSnapshot(db, options.snapshotId);
  const isStaleScore = and(isNotNull(row.score), eq(row.stale, true));
  const needsScore = and(eq(row.filterResult, "passed"), or(isNull(row.score), isStaleScore));
  const staleOnly = and(eq(row.filterResult, "passed"), isStaleScore);
  const rows = await db
    .with(row)
    .select({
      jobId: jobs.id,
      title: jobs.title,
      company: companies.name,
      locationsJson: jobs.locationsJson,
      workplace: jobs.workplace,
      seniority: jobs.seniority,
      germanLevelRule: jobs.germanLevelRequired,
      postedAt: jobs.postedAt,
      firstSeenAt: jobs.firstSeenAt,
      signalBonus: row.signalBonus,
      filterReasons: row.filterReasons,
      score: row.score,
    })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .innerJoin(row, eq(row.jobId, jobs.id))
    .where(and(effectivelyActiveSql(await uxTablesReady(db)), options.only === "stale" ? staleOnly : needsScore, options.jobIds ? inArray(jobs.id, [...options.jobIds]) : undefined));
  return rows.map((r) => ({
    jobId: r.jobId,
    title: r.title,
    company: r.company,
    locationsJson: r.locationsJson,
    workplace: r.workplace,
    seniority: r.seniority,
    germanLevelRule: r.germanLevelRule,
    postedAt: r.postedAt,
    firstSeenAt: r.firstSeenAt,
    signalBonus: r.signalBonus ?? 0,
    filterReasons: r.filterReasons,
    hasScore: r.score !== null,
  }));
}

/** How many jobs `listScoreCandidates` would return without the limit, split by kind. */
export async function countScoreBacklog(db: Executor, snapshotId: number): Promise<{ unscored: number; stale: number }> {
  const row = rowsOfSnapshot(db, snapshotId);
  const rows = await db
    .with(row)
    .select({
      unscored: sql<number>`count(*) filter (where ${row.id} is null or ${row.score} is null)`.mapWith(Number),
      stale: sql<number>`count(*) filter (where ${row.score} is not null and ${row.stale} is true)`.mapWith(Number),
    })
    .from(jobs)
    .innerJoin(row, eq(row.jobId, jobs.id))
    .where(and(effectivelyActiveSql(await uxTablesReady(db)), eq(row.filterResult, "passed")));
  return { unscored: rows[0]?.unscored ?? 0, stale: rows[0]?.stale ?? 0 };
}

/**
 * Passed jobs that never had an AI score under the newest saved preferences snapshot: what "score the
 * backlog" would work through (the web app has no profile file in hand, so it asks the newest snapshot).
 */
export async function countUnscoredJobs(db: Db): Promise<number> {
  const [snapshot] = await db
    .select({ id: profileSnapshots.id })
    .from(profileSnapshots)
    .where(eq(profileSnapshots.kind, "preferences"))
    .orderBy(desc(profileSnapshots.savedAt), desc(profileSnapshots.id))
    .limit(1);
  if (!snapshot) return 0;
  return (await countScoreBacklog(db, snapshot.id)).unscored;
}

/** Whether the job waits for a score (or a re-score) under the newest saved preferences snapshot: passed the filter, active, no score or a stale one. */
export async function jobWaitsForScore(db: Db, jobId: number): Promise<boolean> {
  const [snapshot] = await db
    .select({ id: profileSnapshots.id })
    .from(profileSnapshots)
    .where(eq(profileSnapshots.kind, "preferences"))
    .orderBy(desc(profileSnapshots.savedAt), desc(profileSnapshots.id))
    .limit(1);
  if (!snapshot) return false;
  return (await listScoreQueue(db, { snapshotId: snapshot.id, jobIds: [jobId] })).length > 0;
}

export interface SaveScoreInput {
  jobId: number;
  /** The job's row for this snapshot, made by the hard filter (`ScoreCandidate.existing.id`). */
  rowId: number;
  profileSnapshotId: number | null;
  provider: string;
  model: string;
  aiScore: number;
  germanPenalty: number;
  score: number;
  signalBonus: number;
  rankValue: number;
  fitReasons: string[];
  gaps: string[];
  /** The one-line summary per language (empty texts are left out). */
  summaries: Readonly<Record<string, string>>;
  /** The language of the reasons and gaps. */
  outputLang: string;
  germanLevel: string;
  germanLevelAi: string;
  germanLevelSource: string;
  promptVersion: string;
  /** Where each reason and gap comes from, aligned by index; null when reason sources are off (an older value is cleared). */
  reasonEvidence?: ReasonEvidence | null;
}

let evidenceColumn = false;

/**
 * Whether `scores.reason_evidence` exists yet. An ai-worker restarted before the runner applied the migration must not fail its
 * scores (or a page its detail view) over the missing column (42703): until then the evidence is not written and reads as none.
 * Checked in the catalog, which never throws; once the column is there the answer is cached for the life of the process.
 */
export async function reasonEvidenceColumnReady(db: Executor): Promise<boolean> {
  if (evidenceColumn) return true;
  const [row] = await db.execute<{ ok: boolean }>(sql`
    select exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'scores' and column_name = 'reason_evidence') as ok`);
  evidenceColumn = row?.ok === true;
  return evidenceColumn;
}

/** For tests: forget the cached answer. */
export function resetReasonEvidenceColumnCache(): void {
  evidenceColumn = false;
}

/** What `saveScore` did with the reason sources: written (also a null that clears older ones), or left out because the column is missing. */
export type SavedEvidence = "written" | "column_missing";

/** The summaries without empty texts, trimmed. */
export function cleanSummaries(summaries: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(summaries)
      .map(([lang, text]) => [lang, text.trim()] as const)
      .filter(([, text]) => text !== ""),
  );
}

/**
 * Store a score in the job's row for the current profile snapshot (the row the filter step made):
 * the row is updated in place and un-staled, never a second row for the same (job, snapshot).
 * `filter_result` and `filter_reasons` stay as the filter left them.
 */
export async function saveScore(db: Executor, input: SaveScoreInput): Promise<{ evidence: SavedEvidence }> {
  // before the migration the text arrays are written alone (the evidence is lost for this score, the score itself is not)
  const evidenceReady = await reasonEvidenceColumnReady(db);
  const updated = await db
    .update(scores)
    .set({
      profileSnapshotId: input.profileSnapshotId,
      provider: input.provider,
      model: input.model,
      score: input.score,
      aiScore: input.aiScore,
      germanPenalty: input.germanPenalty,
      germanLevel: input.germanLevel,
      germanLevelAi: input.germanLevelAi,
      germanLevelSource: input.germanLevelSource,
      signalBonus: input.signalBonus,
      rankValue: input.rankValue,
      fitReasons: input.fitReasons,
      gaps: input.gaps,
      summaries: cleanSummaries(input.summaries),
      outputLang: input.outputLang,
      // The old columns are still written, so a rollback finds the summaries where it reads them
      summaryZh: cleanSummaries(input.summaries).zh ?? null,
      summaryEn: cleanSummaries(input.summaries).en ?? null,
      promptVersion: input.promptVersion,
      // always written once the column exists: a re-score without sources must not keep the sources of the reasons it replaced
      ...(evidenceReady ? { reasonEvidence: input.reasonEvidence ?? null } : {}),
      scoredAt: sql`now()`, // the database clock, like every persisted timestamp
      stale: false,
    })
    .where(and(eq(scores.id, input.rowId), eq(scores.jobId, input.jobId)))
    .returning({ id: scores.id });
  if (updated.length === 0) throw new Error(`saveScore: score row ${input.rowId} of job ${input.jobId} does not exist`);
  return { evidence: evidenceReady ? "written" : "column_missing" };
}

/**
 * The scoring prompt changed: every score made by another prompt version is out of date. Scores
 * without a version (hand-made or seed data) and rows without a score are left alone. Returns the rows newly marked stale.
 */
export async function markScoresStaleByPromptVersion(db: Executor, currentVersion: string): Promise<number> {
  const rows = await db
    .update(scores)
    .set({ stale: true })
    .where(and(hasAiScore, isNotNull(scores.promptVersion), ne(scores.promptVersion, currentVersion), eq(scores.stale, false)))
    .returning({ id: scores.id });
  return rows.length;
}

// ---------------------------------------------------------------- German level re-check

/** A scored row with everything needed to settle its German level again without calling the AI. */
export interface GermanRecheckRow {
  id: number;
  jobId: number;
  aiScore: number;
  signalBonus: number;
  germanPenalty: number;
  germanLevel: string | null;
  germanLevelAi: string;
  germanLevelSource: string | null;
  /** The pipeline's rule-based level of the job (`jobs.german_level_required`). */
  rule: string;
  description: string | null;
}

/**
 * Scored rows (current, not stale) that kept the AI's own German reading: the German deduction is a
 * pure function of the rule level, that reading and the profile, so it can be redone when the rule
 * level of the job changed (the pipeline rules were improved, the posting was re-read).
 */
export async function listGermanRecheckRows(db: Executor): Promise<GermanRecheckRow[]> {
  const rows = await db
    .select({
      id: scores.id,
      jobId: scores.jobId,
      aiScore: scores.aiScore,
      signalBonus: scores.signalBonus,
      germanPenalty: scores.germanPenalty,
      germanLevel: scores.germanLevel,
      germanLevelAi: scores.germanLevelAi,
      germanLevelSource: scores.germanLevelSource,
      rule: jobs.germanLevelRequired,
      description: jobs.description,
    })
    .from(scores)
    .innerJoin(jobs, eq(jobs.id, scores.jobId))
    .where(and(hasAiScore, isNotNull(scores.aiScore), isNotNull(scores.germanLevelAi), eq(scores.stale, false)))
    .orderBy(scores.id);
  return rows.flatMap((r) => (r.aiScore === null || r.germanLevelAi === null ? [] : [{ ...r, aiScore: r.aiScore, germanLevelAi: r.germanLevelAi }]));
}

export interface GermanOutcomeUpdate {
  germanLevel: string;
  germanLevelSource: string;
  germanPenalty: number;
  score: number;
  rankValue: number;
}

/** Store a re-settled German level with the deduction, match score and rank value that follow from it. */
export async function updateGermanOutcome(db: Executor, id: number, update: GermanOutcomeUpdate): Promise<void> {
  await db.update(scores).set(update).where(eq(scores.id, id));
}

/**
 * Current scores made with the scoring prompt version `version` (an AI score, not stale). Changing the scoring
 * criteria changes the version, so this many scores would be re-scored.
 */
export async function countScoresAtPromptVersion(db: Executor, version: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(scores).where(and(hasAiScore, eq(scores.promptVersion, version), eq(scores.stale, false)));
  return row?.n ?? 0;
}
