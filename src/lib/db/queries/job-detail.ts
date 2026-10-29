import { and, desc, eq, getTableColumns, inArray, isNotNull, sql } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { Db } from "../client";
import { getFavorite, type FavoriteState } from "../repos/favorites";
import { getClosureOverride, type ClosureOverride } from "../repos/closures";
import { uxTablesReady } from "../repos/ux-tables";
import { reasonEvidenceColumnReady } from "../repos/scores";
import { parseReasonEvidence, type ReasonEvidence } from "@/lib/scoring/evidence";
import { getGhostOfJob } from "../repos/ghost";
import { getVisaOfJob, type VisaDetail } from "../repos/visa";
import type { GhostOfJob } from "@/lib/ghost/types";
import { closedReason, effectiveJobStatus, type ClosedReason } from "@/lib/jobs/closure";
import { parseLinkCheck, type LinkCheckEvidence } from "@/lib/jobs/link-check-evidence";
import { getApplicationByJobId, listApplicationEvents, type Application, type ApplicationEvent } from "../repos/applications";
import { companies, jobs, profileSnapshots, scores, signalScans, translations } from "../schema";
import { loadSignals, loadSources } from "./job-cards";
import { summarizeMonthSalaries } from "@/lib/domain/salary";
import { ghostTrustedKeys } from "@/lib/ghost/settings";
import { listMonthSalaryFigures } from "./jobs";
import { asContract, asGermanLevel, asJobLanguage, parseLocations, parseSalary } from "./parse";
import type { Contract, GermanLevel, JobLanguage, JobLocation, JobSalary, JobSignal, JobSourceRef, JobStatus, Workplace } from "./types";
import { summariesOf } from "../summaries";
import { listingReady } from "../repos/listing";
import { dormancyReady } from "../repos/dormancy";
import { dormantSql, lastListedSql } from "./job-status";

/** The newest score of a job with everything the detail page shows. */
export interface JobScoreDetail {
  rankValue: number | null;
  score: number | null;
  signalBonus: number;
  filterResult: "passed" | "filtered_out";
  filterReasons: string[];
  /**
   * `salary_floor_year` of the preferences the hard filter judged this job with (the snapshot its newest score row was made under);
   * only read when the filter removed the job for its salary, null otherwise or when that snapshot cannot be read.
   */
  filterFloorEur: number | null;
  fitReasons: string[];
  gaps: string[];
  /** Where each reason and gap comes from, aligned with `fitReasons` / `gaps`; null for a score made without reason sources. */
  reasonEvidence: ReasonEvidence | null;
  /** The one-line summary per language. */
  summaries: Record<string, string>;
  /** The language of `fitReasons` / `gaps`; null when unknown (no AI output). */
  outputLang: string | null;
  stale: boolean;
  /** What the model answered, the German deduction, and how the German level was settled. */
  aiScore: number | null;
  germanPenalty: number;
  germanLevel: GermanLevel | null;
  germanLevelAi: GermanLevel | null;
  germanLevelSource: string | null;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  scoredAt: Date | null;
}

export interface JobDetail {
  id: number;
  title: string;
  /** `nameNorm`: the company key (what the visa rules compare with `exclude_companies`). */
  company: { id: number; name: string; nameNorm: string; watched: boolean };
  locations: JobLocation[];
  workplace: Workplace;
  seniority: string;
  contract: Contract;
  isAgency: boolean;
  language: JobLanguage;
  /** The level the dashboard shows: the scoring's settled level once scored, else the pipeline's rule value. */
  germanLevelRequired: GermanLevel;
  /** The pipeline's rule-based reading of the posting (`jobs.german_level_required`). */
  germanLevelRule: GermanLevel;
  /** The status the job shows (the user's closed / open judgement on top of the automatic one). */
  status: JobStatus;
  /** The automatic status alone, why it shows as closed, the user's judgement and the evidence of the last recheck. */
  closure: JobClosure;
  postedAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastListedAt: Date | null;
  relistedAt: Date | null;
  relistCount: number;
  /** Original JD text (null when the source gave none). */
  description: string | null;
  /** Normalized salary; null = none stated (C3) or not readable (see `salaryDisclosed`). */
  salary: JobSalary | null;
  salaryDisclosed: boolean;
  /** Skill names the pipeline found in the posting. */
  skills: string[];
  /** Best apply link first. */
  sources: JobSourceRef[];
  signals: JobSignal[];
  /** What the signals step has done for this job; null before the first scan (the signals are then still pending). */
  signalScan: { ruleScanned: true; aiReviewed: boolean } | null;
  score: JobScoreDetail | null;
  /** Languages a translation exists for. */
  translatedLanguages: string[];
  application: Application | null;
  /** The user's star on this job. */
  favorite: FavoriteState | null;
  applicationEvents: ApplicationEvent[];
  /** What the JD says about visa sponsorship (the visa check); null before the job was checked. */
  visa: VisaDetail | null;
  /** The ghost job check's stored result (also a dismissed one); null before the check or without the table. */
  ghost: GhostOfJob | null;
}

type ScoreRow = Omit<typeof scores.$inferSelect, "reasonEvidence" | "filterInputHash" | "filterConfigHash"> & { reasonEvidence?: unknown };

/**
 * The score row the detail page shows: the newest one, except that a newest row which passed the
 * filter but has no AI score yet (the profile changed, re-scoring is pending) shows the newest row
 * that has a score, marked stale, so the page never goes blank after a profile edit.
 */
/** The preferences snapshot a filter result was made under: its salary floor, or null when the YAML cannot be read. */
async function floorOfSnapshot(db: Db, snapshotId: number | null): Promise<number | null> {
  if (snapshotId === null) return null;
  const [row] = await db
    .select({ yaml: profileSnapshots.contentYaml })
    .from(profileSnapshots)
    .where(and(eq(profileSnapshots.id, snapshotId), eq(profileSnapshots.kind, "preferences")))
    .limit(1);
  if (!row) return null;
  try {
    // snapshots saved before the market packs call it `salary_floor_eur_year`
    const parsed = z.object({ salary_floor_year: z.number().finite().nonnegative().optional(), salary_floor_eur_year: z.number().finite().nonnegative().optional() }).safeParse(parseYaml(row.yaml));
    return parsed.success ? (parsed.data.salary_floor_year ?? parsed.data.salary_floor_eur_year ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * `floorOfSnapshot` for a page of list rows: the floor each job's newest filter result was made under (job id → EUR a year; null when the
 * snapshot cannot be read). Two queries for the whole page. Only jobs the filter removed for their salary need it (the list says
 * "below the floor of the time" in the detail page's words).
 */
export async function getFilterFloors(db: Db, jobIds: readonly number[]): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>();
  if (jobIds.length === 0) return out;
  const newest = await db
    .selectDistinctOn([scores.jobId], { jobId: scores.jobId, snapshotId: scores.profileSnapshotId })
    .from(scores)
    .where(inArray(scores.jobId, [...jobIds]))
    .orderBy(scores.jobId, desc(scores.createdAt), desc(scores.id));
  const floors = new Map<number, number | null>();
  for (const snapshotId of new Set(newest.flatMap((row) => (row.snapshotId === null ? [] : [row.snapshotId])))) floors.set(snapshotId, await floorOfSnapshot(db, snapshotId));
  for (const row of newest) out.set(row.jobId, row.snapshotId === null ? null : (floors.get(row.snapshotId) ?? null));
  return out;
}

/** Internal filter hashes are never needed by the page, including before their migration. */
async function scoreColumns(db: Db) {
  const { reasonEvidence, filterInputHash, filterConfigHash, ...rest } = getTableColumns(scores);
  void [filterInputHash, filterConfigHash];
  return (await reasonEvidenceColumnReady(db)) ? { ...rest, reasonEvidence } : rest;
}

async function displayedScore(db: Db, jobId: number): Promise<ScoreRow | null> {
  const columns = await scoreColumns(db);
  const [newest] = await db.select(columns).from(scores).where(eq(scores.jobId, jobId)).orderBy(desc(scores.createdAt), desc(scores.id)).limit(1);
  if (!newest || newest.score !== null || newest.filterResult !== "passed") return newest ?? null;
  const [scored] = await db
    .select(columns)
    .from(scores)
    .where(and(eq(scores.jobId, jobId), isNotNull(scores.score)))
    .orderBy(desc(scores.createdAt), desc(scores.id))
    .limit(1);
  // the filter fields stay those of the newest row
  // (and the snapshot the filter result was made under, which is all `profileSnapshotId` is used for below)
  return scored ? { ...scored, filterResult: newest.filterResult, filterReasons: newest.filterReasons, profileSnapshotId: newest.profileSnapshotId, stale: true } : newest;
}

export interface JobClosure {
  autoStatus: JobStatus;
  reason: ClosedReason | null;
  override: ClosureOverride | null;
  linkCheck: LinkCheckEvidence | null;
}

/** The columns of `jobs` the page reads (all but the migration-gated closure and dormancy columns, read apart so the page works before the migration). */
function detailColumns(listing: boolean) {
  const { lastListedAt, relistedAt, relistCount, linkCheckJson, dormantAt, possiblyClosedAt, searchTsv, descriptionMd5, descriptionHasText, salaryMd5, ...columns } = getTableColumns(jobs);
  void [lastListedAt, linkCheckJson, dormantAt, possiblyClosedAt, searchTsv, descriptionMd5, descriptionHasText, salaryMd5];
  return {
    ...columns,
    lastListedAt: lastListedSql(listing),
    relistedAt: listing ? relistedAt : sql<Date | null>`null`,
    relistCount: listing ? sql<number>`coalesce(${relistCount}, 0)`.mapWith(Number) : sql<number>`0`,
  };
}

/** The closed state of a job; before the migration the automatic status alone. */
async function loadClosure(db: Db, id: number, autoStatus: JobStatus): Promise<{ status: JobStatus; closure: JobClosure }> {
  if (!(await uxTablesReady(db))) return { status: autoStatus, closure: { autoStatus, reason: closedReason(autoStatus, null, null), override: null, linkCheck: null } };
  const dormant = await dormancyReady(db);
  const [[check], override] = await Promise.all([db.select({ json: jobs.linkCheckJson, dormant: dormantSql(dormant) }).from(jobs).where(eq(jobs.id, id)).limit(1), getClosureOverride(db, id)]);
  const linkCheck = parseLinkCheck(check?.json);
  const action = override?.action ?? null;
  return {
    status: effectiveJobStatus(autoStatus, action),
    closure: { autoStatus, reason: closedReason(autoStatus, action, linkCheck?.outcome ?? null, check?.dormant ?? false), override, linkCheck },
  };
}

export async function getJobDetail(db: Db, id: number): Promise<JobDetail | null> {
  const [row] = await db
    .select({ job: detailColumns(await listingReady(db)), companyName: companies.name, companyNameNorm: companies.nameNorm, companyWatched: companies.watched })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(eq(jobs.id, id))
    .limit(1);
  if (!row) return null;
  const { job } = row;

  const [sources, signals, score, translated, application, [scan], favorite, closed, visa, ghost] = await Promise.all([
    loadSources(db, [id]),
    loadSignals(db, [id]),
    displayedScore(db, id),
    db.select({ lang: translations.lang }).from(translations).where(eq(translations.jobId, id)),
    getApplicationByJobId(db, id),
    db.select({ aiScannedAt: signalScans.aiScannedAt, aiDescriptionHash: signalScans.aiDescriptionHash, descriptionHash: signalScans.descriptionHash }).from(signalScans).where(eq(signalScans.jobId, id)).limit(1),
    getFavorite(db, id),
    loadClosure(db, id, job.status),
    getVisaOfJob(db, id),
    getGhostOfJob(db, id, ghostTrustedKeys()),
  ]);
  const applicationEvents = application ? await listApplicationEvents(db, application.id) : [];
  const salaryFiltered = score?.filterResult === "filtered_out" && score.filterReasons.some((reason) => reason.startsWith("salary_below_floor"));
  const filterFloorEur = salaryFiltered ? await floorOfSnapshot(db, score?.profileSnapshotId ?? null) : null;

  return {
    id: job.id,
    title: job.title,
    company: { id: job.companyId, name: row.companyName, nameNorm: row.companyNameNorm, watched: row.companyWatched },
    locations: parseLocations(job.locationsJson),
    workplace: job.workplace,
    seniority: job.seniority,
    contract: asContract(job.contract),
    isAgency: job.isAgency,
    language: asJobLanguage(job.language),
    germanLevelRequired: asGermanLevel(score?.germanLevel ?? job.germanLevelRequired),
    germanLevelRule: asGermanLevel(job.germanLevelRequired),
    status: closed.status,
    closure: closed.closure,
    postedAt: job.postedAt,
    firstSeenAt: job.firstSeenAt,
    lastSeenAt: job.lastSeenAt,
    lastListedAt: job.lastListedAt,
    relistedAt: job.relistedAt,
    relistCount: job.relistCount,
    description: job.description,
    salary: parseSalary(job.salaryJson),
    salaryDisclosed: job.salaryJson !== null && job.salaryJson !== undefined,
    skills: job.skills,
    sources: sources.get(id) ?? [],
    signals: signals.get(id) ?? [],
    signalScan: scan ? { ruleScanned: true, aiReviewed: scan.aiScannedAt !== null && scan.aiDescriptionHash === scan.descriptionHash } : null,
    score: score
      ? {
          rankValue: score.rankValue,
          score: score.score,
          signalBonus: score.signalBonus,
          filterResult: score.filterResult,
          filterReasons: score.filterReasons,
          filterFloorEur,
          fitReasons: score.fitReasons,
          gaps: score.gaps,
          reasonEvidence: parseReasonEvidence(score.reasonEvidence, { fit: score.fitReasons.length, gaps: score.gaps.length }),
          summaries: summariesOf(score),
          outputLang: score.outputLang,
          stale: score.score !== null && score.stale, // only a row with AI output can be outdated
          aiScore: score.aiScore,
          germanPenalty: score.germanPenalty,
          germanLevel: score.germanLevel === null ? null : asGermanLevel(score.germanLevel),
          germanLevelAi: score.germanLevelAi === null ? null : asGermanLevel(score.germanLevelAi),
          germanLevelSource: score.germanLevelSource,
          provider: score.provider,
          model: score.model,
          promptVersion: score.promptVersion,
          scoredAt: score.scoredAt,
        }
      : null,
    translatedLanguages: translated.map((t) => t.lang),
    application,
    favorite,
    applicationEvents,
    visa,
    ghost,
  };
}

/** Whether a job with this id exists (used to reject mutations of unknown jobs before touching `applications`). */
export async function jobExists(db: Db, id: number): Promise<boolean> {
  const [row] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, id)).limit(1);
  return row !== undefined;
}

/** The stated salaries of the current month, as the detail page compares a job with them. */
export interface MonthSalaryStats {
  /** Jobs first seen this month whose salary gives a comparable annual EUR figure, the job itself included. */
  count: number;
  /** Median of those figures, EUR a year; null below `minSample`. */
  median: number | null;
  /** Share (0-100) of the other jobs of the month that this job's figure is above; null below `minSample` or when the job has no figure. */
  percentile: number | null;
}

export interface MonthSalaryStatsInput {
  now: Date;
  /** The month starts at midnight of the first day in this time zone (`schedule.yaml: timezone`). */
  timeZone: string;
  /** The job on screen: left out of the percentile's denominator. */
  jobId: number;
  /** The job's own figure (`annualBaseFigure`), base currency a year; null = no comparable salary. */
  figure: number | null;
  /** The market's base currency: the figures of the month are in it. */
  currency: string;
  /** `ui.yaml: salary_stats.min_sample`. */
  minSample: number;
}

/**
 * Median and percentile of this month's stated salaries (jobs first seen in the month of `now`): this month's figures
 * (`listMonthSalaryFigures`) summarized by `summarizeMonthSalaries`, the same function the job list uses for every row.
 */
export async function loadMonthSalaryStats(db: Db, input: MonthSalaryStatsInput): Promise<MonthSalaryStats> {
  const figures = await listMonthSalaryFigures(db, { now: input.now, timeZone: input.timeZone, currency: input.currency });
  return summarizeMonthSalaries(figures, { jobId: input.jobId, figure: input.figure, minSample: input.minSample });
}
