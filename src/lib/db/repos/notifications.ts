import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { z } from "zod";

import { jobSalarySchema, type JobSalary } from "@/lib/domain/types";

import type { Executor } from "../executor";
import { companies, jobSources, jobs, notifications, scores, signals } from "../schema";
import { loadTrapCounts } from "./traps";
import { summariesOf } from "../summaries";
import { effectivelyActiveSql } from "../queries/job-status";
import { uxTablesReady } from "./ux-tables";
import { jobReadColumns } from "./dormancy";
import type { Job } from "./jobs";

/**
 * `notifications` rows. The table has no dedicated key column, so the key of an
 * alert / job lives in `payload_json`:
 *
 * | kind               | payload_json                         | meaning                                            |
 * |--------------------|--------------------------------------|----------------------------------------------------|
 * | `cycle_summary`    | `{ ... counts }`                     | the per-cycle summary message                      |
 * | `job`              | `{ jobId, rankValue }`               | a job message that was sent                        |
 * | `job_overflow`     | `{ jobId, rankValue }`               | eligible but cut by `max_per_cycle` (never pushed) |
 * | `alert:<kind>`     | `{ key }`                            | an alert that was sent (deduped by kind + key)     |
 * | `alert.<kind>`     | `{ key?, title?, detail? }`          | an alert queued by another feature (unsent: `sent_at` is null) |
 * | `reminder`         | `{ items }` or `{ empty: true }`     | the daily application reminder (or "nothing due")  |
 * | `test`             | `{}`                                 | `pnpm telegram:test`                               |
 */
export const NOTIFICATION_KINDS = {
  cycleSummary: "cycle_summary",
  job: "job",
  jobOverflow: "job_overflow",
  reminder: "reminder",
  test: "test",
} as const;

/** Alerts raised by this feature are stored with this prefix, already sent. */
export const ALERT_KIND_PREFIX = "alert:";
/** Alerts queued by other features (e.g. backups) as unsent rows; the notify step delivers them. */
export const QUEUED_ALERT_PREFIX = "alert.";

export type Notification = typeof notifications.$inferSelect;

export interface NotificationInput {
  kind: string;
  cycleId?: number | null;
  payload?: unknown;
  sentAt?: Date | null;
  telegramMessageId?: number | null;
}

export async function recordNotification(db: Executor, input: NotificationInput): Promise<Notification> {
  const [row] = await db
    .insert(notifications)
    .values({
      kind: input.kind,
      cycleId: input.cycleId ?? null,
      payloadJson: input.payload ?? null,
      sentAt: input.sentAt === undefined ? new Date() : input.sentAt,
      telegramMessageId: input.telegramMessageId ?? null,
    })
    .returning();
  if (!row) throw new Error("recordNotification: insert returned no row");
  return row;
}

export async function hasNotificationForCycle(db: Executor, kind: string, cycleId: number): Promise<boolean> {
  const [row] = await db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.kind, kind), eq(notifications.cycleId, cycleId))).limit(1);
  return row !== undefined;
}

export async function getLastNotificationAt(db: Executor, kind: string): Promise<Date | null> {
  const [row] = await db
    .select({ sentAt: notifications.sentAt })
    .from(notifications)
    .where(and(eq(notifications.kind, kind), isNotNull(notifications.sentAt)))
    .orderBy(desc(notifications.sentAt))
    .limit(1);
  return row?.sentAt ?? null;
}

export interface SentAlert {
  /** Alert kind without the `alert:` / `alert.` prefix. */
  kind: string;
  key: string;
  sentAt: Date;
}

const keyPayload = z.object({ key: z.string().optional() });

/** Alerts actually delivered at or after `since` (rows with a Telegram message id), newest first: the dedupe window. */
export async function listAlertsSentSince(db: Executor, since: Date): Promise<SentAlert[]> {
  const rows = await db
    .select({ kind: notifications.kind, payload: notifications.payloadJson, sentAt: notifications.sentAt })
    .from(notifications)
    .where(
      and(
        or(like(notifications.kind, `${ALERT_KIND_PREFIX}%`), like(notifications.kind, `${QUEUED_ALERT_PREFIX}%`)),
        isNotNull(notifications.telegramMessageId),
        gte(notifications.sentAt, since),
      ),
    )
    .orderBy(desc(notifications.sentAt));
  const result: SentAlert[] = [];
  for (const row of rows) {
    const payload = keyPayload.safeParse(row.payload);
    if (!payload.success || row.sentAt === null) continue;
    // both prefixes are six characters long
    result.push({ kind: row.kind.slice(ALERT_KIND_PREFIX.length), key: payload.data.key ?? "", sentAt: row.sentAt });
  }
  return result;
}

export interface QueuedAlert {
  id: number;
  /** Kind without the `alert.` prefix. */
  kind: string;
  payload: unknown;
}

/** Alerts other features queued (`alert.*`, `sent_at` null), oldest first. */
export async function listUnsentQueuedAlerts(db: Executor, limit = 50): Promise<QueuedAlert[]> {
  const rows = await db
    .select({ id: notifications.id, kind: notifications.kind, payload: notifications.payloadJson })
    .from(notifications)
    .where(and(like(notifications.kind, `${QUEUED_ALERT_PREFIX}%`), isNull(notifications.sentAt)))
    .orderBy(asc(notifications.id))
    .limit(limit);
  return rows.map((r) => ({ id: r.id, kind: r.kind.slice(QUEUED_ALERT_PREFIX.length), payload: r.payload }));
}

/**
 * Mark a queued row handled. `messageId` is the Telegram message it went out as; null with
 * `deduped` means "not sent: the same alert went out within the dedupe window" (recorded in the payload).
 */
export async function markNotificationSent(db: Executor, id: number, input: { messageId: number | null; sentAt: Date; deduped?: boolean }): Promise<void> {
  await db
    .update(notifications)
    .set({
      sentAt: input.sentAt,
      telegramMessageId: input.messageId,
      ...(input.deduped ? { payloadJson: sql`coalesce(${notifications.payloadJson}, '{}'::jsonb) || '{"deduped": true}'::jsonb` } : {}),
    })
    .where(eq(notifications.id, id));
}

const jobIdPayload = sql<string | null>`${notifications.payloadJson} ->> 'jobId'`;

/** Which of `jobIds` already have a `job` (sent) or `job_overflow` (cut by the cap) notification. */
export async function listNotifiedJobIds(db: Executor, jobIds: readonly number[]): Promise<Set<number>> {
  if (jobIds.length === 0) return new Set();
  const rows = await db
    .select({ jobId: jobIdPayload })
    .from(notifications)
    .where(and(inArray(notifications.kind, [NOTIFICATION_KINDS.job, NOTIFICATION_KINDS.jobOverflow]), inArray(jobIdPayload, jobIds.map(String))));
  return new Set(rows.flatMap((r) => (r.jobId === null ? [] : [Number(r.jobId)])));
}

// ---------------------------------------------------------------- push candidates

export interface PushCandidateScore {
  filterResult: "passed" | "filtered_out";
  /** AI match score; null until the AI has scored the job. */
  score: number | null;
  signalBonus: number;
  rankValue: number | null;
  /** The one-line summary per language. */
  summaries: Readonly<Record<string, string>>;
  /** The language the AI wrote in; null when unknown. */
  outputLang: string | null;
}

/** Everything the push selection and the job message need, as plain data. */
export interface PushCandidate {
  jobId: number;
  title: string;
  companyName: string;
  /** `companies.name_norm`, to match the watched-company list of interests.yaml. */
  companyNameNorm: string;
  companyWatched: boolean;
  /** City or label of each location, primary first. */
  locations: string[];
  workplace: "onsite" | "hybrid" | "remote" | "unknown";
  germanLevelRequired: string;
  firstSeenAt: Date;
  /** Latest score row; null when the job has none yet. */
  score: PushCandidateScore | null;
  /** Normalized salary of the posting (for the 💰 badge); null when it states none. */
  salary: JobSalary | null;
  /** Distinct signal category ids found in the posting (whatever interests.yaml says of them; the caller keeps the active ones). */
  signalTiers: string[];
  /**
   * Whether one of its signals makes it high value (a `high_value` category; an amount only when it reaches the salary
   * floor and is local pay); undefined when the caller passed no `isHighValue` (then it is not).
   */
  highValue?: boolean;
  /** Apply link of the best source (company ATS before LinkedIn before boards). */
  sourceUrl: string | null;
  /** AI traps found in the posting (0 = none or not scanned). */
  trapCount?: number;
}

const locationsSchema = z.array(z.object({ label: z.string(), city: z.string().nullable().optional(), isPrimary: z.boolean().optional() }));

function locationNames(raw: unknown): string[] {
  const parsed = locationsSchema.safeParse(raw);
  if (!parsed.success) return [];
  const primaryFirst = [...parsed.data].sort((a, b) => Number(b.isPrimary ?? false) - Number(a.isPrimary ?? false));
  return [...new Set(primaryFirst.map((l) => (l.city && l.city.length > 0 ? l.city : l.label)))];
}

function parseSalary(value: unknown): JobSalary | null {
  const parsed = jobSalarySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Whether one stored signal makes its job high value (`isHighValueSignal` of `@/lib/signals` with the current policy). */
export type HighValueCheck = (signal: { tier: string; value: unknown }) => boolean;

async function assembleCandidates(
  db: Executor,
  rows: Array<{ job: Job; company: typeof companies.$inferSelect }>,
  isHighValue?: HighValueCheck,
): Promise<PushCandidate[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.job.id);

  const scoreRows = await db
    .selectDistinctOn([scores.jobId], {
      jobId: scores.jobId,
      filterResult: scores.filterResult,
      score: scores.score,
      signalBonus: scores.signalBonus,
      rankValue: scores.rankValue,
      summaries: scores.summaries,
      summaryZh: scores.summaryZh,
      summaryEn: scores.summaryEn,
      outputLang: scores.outputLang,
    })
    .from(scores)
    .where(inArray(scores.jobId, ids))
    .orderBy(scores.jobId, desc(scores.createdAt), desc(scores.id));
  const scoreByJob = new Map(scoreRows.map((s) => [s.jobId, s]));

  const tierRows = await db.select({ jobId: signals.jobId, tier: signals.tier, value: signals.valueJson }).from(signals).where(inArray(signals.jobId, ids));
  const tiersByJob = new Map<number, Set<string>>();
  const highValueJobs = new Set<number>();
  for (const t of tierRows) {
    tiersByJob.set(t.jobId, (tiersByJob.get(t.jobId) ?? new Set()).add(t.tier));
    if (isHighValue?.(t)) highValueJobs.add(t.jobId);
  }

  const sourceRows = await db
    .select({ jobId: jobSources.jobId, url: jobSources.url, applyUrl: jobSources.applyUrl })
    .from(jobSources)
    .where(inArray(jobSources.jobId, ids))
    .orderBy(asc(jobSources.priority), asc(jobSources.id));
  const sourceByJob = new Map<number, string | null>();
  for (const s of sourceRows) if (!sourceByJob.has(s.jobId) || sourceByJob.get(s.jobId) === null) sourceByJob.set(s.jobId, s.applyUrl ?? s.url);
  const traps = await loadTrapCounts(db, ids);

  return rows.map(({ job, company }): PushCandidate => {
    const score = scoreByJob.get(job.id);
    return {
      jobId: job.id,
      title: job.title,
      companyName: company.name,
      companyNameNorm: company.nameNorm,
      companyWatched: company.watched,
      locations: locationNames(job.locationsJson),
      workplace: job.workplace,
      germanLevelRequired: job.germanLevelRequired,
      firstSeenAt: job.firstSeenAt,
      score: score
        ? { filterResult: score.filterResult, score: score.score, signalBonus: score.signalBonus, rankValue: score.rankValue, summaries: summariesOf(score), outputLang: score.outputLang }
        : null,
      salary: parseSalary(job.salaryJson),
      signalTiers: [...(tiersByJob.get(job.id) ?? [])],
      ...(isHighValue ? { highValue: highValueJobs.has(job.id) } : {}),
      sourceUrl: sourceByJob.get(job.id) ?? null,
      trapCount: traps.get(job.id)?.traps ?? 0,
    };
  });
}

/**
 * Active jobs first seen at or after `since`, or scored at or after it (a job scored late, e.g. with "score now" or
 * from the backlog, is pushed like a new one), oldest first. Whether they were pushed already is a separate lookup.
 */
export async function listPushCandidates(db: Executor, input: { since: Date; isHighValue?: HighValueCheck }): Promise<PushCandidate[]> {
  // written out with table names: a column interpolated into a subquery can render without its table (UAT r2 P2-5)
  const scoredSince = sql`exists (select 1 from scores sc where sc.job_id = "jobs"."id" and sc.scored_at >= ${input.since.toISOString()})`;
  const rows = await db
    .select({ job: await jobReadColumns(db), company: companies })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(and(effectivelyActiveSql(await uxTablesReady(db)), or(gte(jobs.firstSeenAt, input.since), scoredSince), eq(companies.blacklisted, false)))
    .orderBy(asc(jobs.firstSeenAt), asc(jobs.id));
  return assembleCandidates(db, rows, input.isHighValue);
}

/** One job in the same shape (rebuilding a message after a button press); null when the job does not exist. */
export async function getPushCandidate(db: Executor, jobId: number): Promise<PushCandidate | null> {
  const rows = await db
    .select({ job: await jobReadColumns(db), company: companies })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(eq(jobs.id, jobId))
    .limit(1);
  const [candidate] = await assembleCandidates(db, rows);
  return candidate ?? null;
}
