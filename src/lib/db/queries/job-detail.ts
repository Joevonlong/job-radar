import { and, asc, desc, eq, getTableColumns, inArray, isNotNull, sql } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { Db } from "../client";
import type { Executor } from "../executor";
import { getFavoriteStates, type FavoriteState } from "../repos/favorites";
import type { ClosureOverride } from "../repos/closures";
import { uxTablesReady } from "../repos/ux-tables";
import { reasonEvidenceColumnReady } from "../repos/scores";
import { parseReasonEvidence, type ReasonEvidence } from "@/lib/scoring/evidence";
import { getGhostDetails } from "../repos/ghost";
import { getVisaDetails, type VisaDetail } from "../repos/visa";
import type { GhostOfJob } from "@/lib/ghost/types";
import { closedReason, effectiveJobStatus, type ClosedReason } from "@/lib/jobs/closure";
import { parseLinkCheck, type LinkCheckEvidence } from "@/lib/jobs/link-check-evidence";
import { APPLICATION_EVENT_LIMIT, listEventsByApplication, type Application, type ApplicationEvent } from "../repos/applications";
import { applications, companies, jobClosureOverrides, jobs, profileSnapshots, scores, signalScans, translations } from "../schema";
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
  /** Normalized salary; null = none stated or not readable (see `salaryDisclosed`). */
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

/** Preferences snapshots created before the market packs used the legacy EUR key. */
function parseSnapshotFloor(yaml: string): number | null {
  try {
    const parsed = z.object({ salary_floor_year: z.number().finite().nonnegative().optional(), salary_floor_eur_year: z.number().finite().nonnegative().optional() }).safeParse(parseYaml(yaml));
    return parsed.success ? (parsed.data.salary_floor_year ?? parsed.data.salary_floor_eur_year ?? null) : null;
  } catch {
    return null;
  }
}

async function floorsOfSnapshots(db: Executor, snapshotIds: readonly number[]): Promise<Map<number, number | null>> {
  if (snapshotIds.length === 0) return new Map();
  const rows = await db.select({ id: profileSnapshots.id, yaml: profileSnapshots.contentYaml }).from(profileSnapshots)
    .where(and(inArray(profileSnapshots.id, [...new Set(snapshotIds)]), eq(profileSnapshots.kind, "preferences")));
  return new Map(rows.map(({ id, yaml }) => [id, parseSnapshotFloor(yaml)]));
}

/**
 * The floor each job's newest filter result was made under (job id → EUR a year; null when the
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
  const floors = await floorsOfSnapshots(db, newest.flatMap((row) => row.snapshotId === null ? [] : [row.snapshotId]));
  for (const row of newest) out.set(row.jobId, row.snapshotId === null ? null : (floors.get(row.snapshotId) ?? null));
  return out;
}

/** Internal filter hashes are never needed by the page, including before their migration. */
async function scoreColumns(db: Executor) {
  const { reasonEvidence, filterInputHash, filterConfigHash, ...rest } = getTableColumns(scores);
  void [filterInputHash, filterConfigHash];
  return (await reasonEvidenceColumnReady(db)) ? { ...rest, reasonEvidence } : rest;
}

/** A pending re-score keeps the last AI score, with the latest filter result and its preferences snapshot. */
async function displayedScores(db: Executor, jobIds: number[]): Promise<Map<number, ScoreRow>> {
  const columns = await scoreColumns(db);
  const newest = await db.selectDistinctOn([scores.jobId], columns).from(scores).where(inArray(scores.jobId, jobIds))
    .orderBy(asc(scores.jobId), desc(scores.createdAt), desc(scores.id));
  const result = new Map<number, ScoreRow>(newest.map((row) => [row.jobId, row]));
  const pending = newest.filter((row) => row.score === null && row.filterResult === "passed");
  if (pending.length === 0) return result;
  const previous = await db.selectDistinctOn([scores.jobId], columns).from(scores)
    .where(and(inArray(scores.jobId, pending.map((row) => row.jobId)), isNotNull(scores.score)))
    .orderBy(asc(scores.jobId), desc(scores.createdAt), desc(scores.id));
  for (const row of previous) {
    const latest = result.get(row.jobId)!;
    result.set(row.jobId, { ...row, filterResult: latest.filterResult, filterReasons: latest.filterReasons, profileSnapshotId: latest.profileSnapshotId, stale: true });
  }
  return result;
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

/** Before the closure migration the detail reader falls back to the automatic status. */
async function loadClosures(db: Executor, jobIds: number[]): Promise<Map<number, { status: JobStatus; closure: JobClosure }>> {
  if (!(await uxTablesReady(db))) return new Map();
  const dormant = await dormancyReady(db);
  const rows = await db.select({
    id: jobs.id, autoStatus: jobs.status, json: jobs.linkCheckJson, dormant: dormantSql(dormant),
    override: { action: jobClosureOverrides.action, note: jobClosureOverrides.note, createdAt: jobClosureOverrides.createdAt },
  }).from(jobs).leftJoin(jobClosureOverrides, eq(jobClosureOverrides.jobId, jobs.id)).where(inArray(jobs.id, jobIds));
  return new Map(rows.map(({ id, autoStatus, json, dormant, override }) => {
    const linkCheck = parseLinkCheck(json);
    const action = override?.action ?? null;
    return [id, {
      status: effectiveJobStatus(autoStatus, action),
      closure: { autoStatus, reason: closedReason(autoStatus, action, linkCheck?.outcome ?? null, dormant), override, linkCheck },
    }];
  }));
}

export async function getJobDetail(db: Executor, id: number): Promise<JobDetail | null> {
  return (await getJobDetails(db, [id])).get(id) ?? null;
}

export async function getJobDetails(db: Executor, ids: readonly number[]): Promise<Map<number, JobDetail>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ job: detailColumns(await listingReady(db)), companyName: companies.name, companyNameNorm: companies.nameNorm, companyWatched: companies.watched })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(inArray(jobs.id, [...ids]));
  if (rows.length === 0) return new Map();
  const jobIds = rows.map(({ job }) => job.id);
  const [sources, signals, displayScores, translated, applicationRows, scans, favorites, closures, visas, ghosts] = await Promise.all([
    loadSources(db, jobIds),
    loadSignals(db, jobIds),
    displayedScores(db, jobIds),
    db.select({ jobId: translations.jobId, lang: translations.lang }).from(translations)
      .where(inArray(translations.jobId, jobIds)).orderBy(asc(translations.jobId), asc(translations.lang)),
    db.select().from(applications).where(inArray(applications.jobId, jobIds)),
    db.select({ jobId: signalScans.jobId, aiScannedAt: signalScans.aiScannedAt, aiDescriptionHash: signalScans.aiDescriptionHash, descriptionHash: signalScans.descriptionHash })
      .from(signalScans).where(inArray(signalScans.jobId, jobIds)),
    getFavoriteStates(db, jobIds),
    loadClosures(db, jobIds),
    getVisaDetails(db, jobIds),
    getGhostDetails(db, jobIds, ghostTrustedKeys()),
  ]);
  const [events, floors] = await Promise.all([
    listEventsByApplication(db, applicationRows.map(({ id }) => id), APPLICATION_EVENT_LIMIT),
    floorsOfSnapshots(db, [...displayScores.values()].flatMap((score) => isSalaryFiltered(score) && score.profileSnapshotId !== null ? [score.profileSnapshotId] : [])),
  ]);
  const byJob = new Map(applicationRows.map((row) => [row.jobId, row]));
  const scanByJob = new Map(scans.map((row) => [row.jobId, row]));
  const languages = new Map<number, string[]>();
  for (const { jobId, lang } of translated) {
    const list = languages.get(jobId) ?? [];
    list.push(lang);
    languages.set(jobId, list);
  }
  return new Map(rows.map((row) => {
    const { job } = row;
    const id = job.id;
    const score = displayScores.get(id);
    const scan = scanByJob.get(id);
    const application = byJob.get(id) ?? null;
    const closed = closures.get(id) ?? {
      status: job.status,
      closure: { autoStatus: job.status, reason: closedReason(job.status, null, null), override: null, linkCheck: null },
    };
    const filterFloorEur = score && isSalaryFiltered(score) && score.profileSnapshotId !== null ? floors.get(score.profileSnapshotId) ?? null : null;
    return [id, {
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
            stale: score.score !== null && score.stale,
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
      translatedLanguages: languages.get(id) ?? [],
      application,
      favorite: favorites.get(id) ?? null,
      applicationEvents: application ? events.get(application.id) ?? [] : [],
      visa: visas.get(id) ?? null,
      ghost: ghosts.get(id) ?? null,
    }];
  }));
}

function isSalaryFiltered(score: ScoreRow): boolean {
  return score.filterResult === "filtered_out" && score.filterReasons.some((reason) => reason.startsWith("salary_below_floor"));
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
