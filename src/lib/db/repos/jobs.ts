import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, not, or, sql, type SQL } from "drizzle-orm";

import { FOLLOWING_STATUSES } from "@/lib/applications/following";
import type { LinkCheckEvidence } from "@/lib/jobs/link-check-evidence";

import type { Executor } from "../executor";
import { applications, channels, companies, jobClosureOverrides, jobFavorites, jobSources, jobs, rawPostings } from "../schema";

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobPatch = Partial<Omit<NewJob, "id" | "searchTsv">>;
export type JobStatus = Job["status"];

const PHRASE_OUTCOME = "phrase";

/**
 * A job whose posting says it no longer takes applications (link check outcome `phrase`) stays possibly closed when a
 * source returns it again: the source may still list a dead posting. Any other job a source returns is active again.
 * The one rule behind every "seen again" write (`touchJobsSeen` in SQL, the pipeline through this function). It reads
 * only the stored `outcome` key, exactly like the SQL, so a record that does not fully parse still counts.
 */
export function statusWhenSeenAgain(job: Pick<Job, "status" | "linkCheckJson">): JobStatus {
  const record = job.linkCheckJson;
  const outcome = typeof record === "object" && record !== null && !Array.isArray(record) ? (record as Record<string, unknown>).outcome : undefined;
  return job.status === "possibly_closed" && outcome === PHRASE_OUTCOME ? "possibly_closed" : "active";
}

export async function getJob(db: Executor, id: number): Promise<Job | null> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return row ?? null;
}

export async function insertJob(db: Executor, values: NewJob): Promise<Job> {
  const [row] = await db.insert(jobs).values(values).returning();
  if (!row) throw new Error("insertJob: insert returned no row");
  return row;
}

export async function updateJob(db: Executor, id: number, patch: JobPatch): Promise<void> {
  await db.update(jobs).set(patch).where(eq(jobs.id, id));
}

/**
 * Forget the facts the pipeline's rules read out of the text (work mode, German level, contract, agency flag),
 * so a re-read of every raw posting starts from nothing: merging never replaces a known value by
 * `unknown` and the agency flag only accumulates, which would keep what the old rules got wrong.
 * `pnpm reprocess` calls it right before it puts all raw postings back to pending. Returns the number of jobs.
 */
export async function resetRuleDerivedFacts(db: Executor): Promise<number> {
  const rows = await db.update(jobs).set({ workplace: "unknown", germanLevelRequired: "unknown", contract: "unknown", isAgency: false }).returning({ id: jobs.id });
  return rows.length;
}

/**
 * Same-source match: the job that already holds a posting with this external id from any channel of
 * the same family (e.g. the same LinkedIn job delivered by two LinkedIn channels).
 */
export async function findJobByFamilyExternalId(
  db: Executor,
  input: { family: string; externalId: string; excludeRawPostingId: number },
): Promise<Job | null> {
  const [row] = await db
    .select({ jobId: jobSources.jobId })
    .from(jobSources)
    .innerJoin(rawPostings, eq(rawPostings.id, jobSources.rawPostingId))
    .where(
      and(
        eq(rawPostings.externalId, input.externalId),
        sql`${rawPostings.id} <> ${input.excludeRawPostingId}`,
        inArray(rawPostings.channelId, db.select({ id: channels.id }).from(channels).where(eq(channels.family, input.family))),
      ),
    )
    .orderBy(asc(jobSources.jobId))
    .limit(1);
  return row ? getJob(db, row.jobId) : null;
}

/** Jobs of one company with this normalized title (cross-source exact-key candidates). */
export async function listJobsByCompanyTitle(db: Executor, companyId: number, titleNorm: string): Promise<Job[]> {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.companyId, companyId), eq(jobs.titleNorm, titleNorm)))
    .orderBy(asc(jobs.id));
}

/** Jobs of one company that have a SimHash (cross-source near-duplicate candidates). */
export async function listJobsWithSimhash(db: Executor, companyId: number): Promise<Array<Pick<Job, "id" | "simhash">>> {
  return db
    .select({ id: jobs.id, simhash: jobs.simhash })
    .from(jobs)
    .where(and(eq(jobs.companyId, companyId), isNotNull(jobs.simhash)))
    .orderBy(asc(jobs.id));
}

/** Jobs of other companies with the same normalized title and a SimHash (cross-company near-duplicate candidates), with their company's key. */
export async function listJobsOfOtherCompaniesByTitle(
  db: Executor,
  companyId: number,
  titleNorm: string,
): Promise<Array<Pick<Job, "id" | "simhash"> & { companyNameNorm: string }>> {
  return db
    .select({ id: jobs.id, simhash: jobs.simhash, companyNameNorm: companies.nameNorm })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(and(eq(jobs.titleNorm, titleNorm), isNotNull(jobs.simhash), ne(jobs.companyId, companyId)))
    .orderBy(asc(jobs.id));
}

export interface SeenResult {
  /** Jobs whose `last_seen_at` moved forward. */
  seen: number;
  /** Of those, jobs that were `possibly_closed` / `closed` and are `active` again. */
  reopened: number;
}

/**
 * `jobs.last_seen_at` = the latest time any source returned the posting (`raw_postings.fetched_at`,
 * refreshed by every collect). A job a source returns again after it was possibly_closed / closed is
 * active again. Never moves `last_seen_at` backwards. Jobs are updated, never deleted.
 */
export async function touchJobsSeen(db: Executor): Promise<SeenResult> {
  const rows = await db.execute<{ seen: number; reopened: number }>(sql`
    with latest as (
      select js.job_id, max(r.fetched_at) as seen
      from job_sources js
      join raw_postings r on r.id = js.raw_posting_id
      group by js.job_id
    ),
    changed as (
      select j.id, j.status as old_status, l.seen
      from jobs j
      join latest l on l.job_id = j.id
      where l.seen > j.last_seen_at
    ),
    upd as (
      update jobs j
      -- a job whose posting says it no longer takes applications stays possibly closed (the source may still list it)
      set last_seen_at = c.seen,
          status = case when j.status = 'possibly_closed' and j.link_check_json->>'outcome' = ${PHRASE_OUTCOME} then j.status else 'active' end
      from changed c
      where j.id = c.id
      returning j.id, j.status
    )
    select (select count(*) from upd)::int as seen,
           (select count(*) from changed c join upd u on u.id = c.id where c.old_status <> 'active' and u.status = 'active')::int as reopened
  `);
  const row = rows[0];
  return { seen: row?.seen ?? 0, reopened: row?.reopened ?? 0 };
}

/**
 * Active jobs no source has returned for `days` days become `possibly_closed` (C2: only when every
 * source channel of the job completed a successful run after the job fell overdue, so a channel that
 * was down or failing never closes its jobs). Returns the ids that changed.
 */
export async function markJobsPossiblyClosed(db: Executor, input: { now: Date; days: number }): Promise<number[]> {
  const cutoff = new Date(input.now.getTime() - input.days * 86_400_000);
  const rows = await db.execute<{ id: string }>(sql`
    update jobs
    set status = 'possibly_closed'
    where status = 'active'
      and last_seen_at < ${cutoff.toISOString()}::timestamptz
      and exists (select 1 from job_sources js where js.job_id = jobs.id)
      and not exists (
        select 1 from job_sources js
        where js.job_id = jobs.id
          and not exists (
            select 1 from runs r
            where r.channel_id = js.channel_id
              and r.status = 'succeeded'
              and r.started_at >= jobs.last_seen_at + make_interval(days => ${input.days})
          )
      )
    returning id
  `);
  return rows.map((r) => Number(r.id)); // bigint columns arrive as strings through raw SQL
}

/** The job is watched: starred, or an application the user follows (its posting is rechecked by `listWatchedJobsForRecheck`). */
function watchedSql(): SQL<boolean> {
  return sql<boolean>`(exists (select 1 from ${jobFavorites} where ${jobFavorites.jobId} = "jobs"."id")
    or exists (select 1 from ${applications} where ${applications.jobId} = "jobs"."id" and ${applications.status} in (${sql.join(
      FOLLOWING_STATUSES.map((status) => sql`${status}`),
      sql`, `,
    )})))`;
}

/** The last watched recheck got no answer (robots.txt forbade the page, or no usable response). */
function lastRecheckUnansweredSql(): SQL<boolean> {
  return sql<boolean>`coalesce("jobs"."link_check_json"->>'outcome' in ('robots', 'unknown'), false)`;
}

/** The user judged the job closed or open (the checks leave it alone). */
function hasClosureOverrideSql(): SQL<boolean> {
  return sql<boolean>`exists (select 1 from ${jobClosureOverrides} where ${jobClosureOverrides.jobId} = "jobs"."id")`;
}

/**
 * `possibly_closed` jobs and, with `unseen`, active jobs unseen since `seenBefore` due a link check. Never-checked first
 * (possibly closed before active), then least recently checked so both kinds take turns. Watched jobs are left to the
 * watched recheck when it is on (`skipWatched`), unless its last answer was `robots` or `unknown` (the plain link check may still
 * settle those); jobs the user judged are left alone. A possibly-closed job marked by the posting's own phrase is never listed:
 * the plain check only sees a live link, not the page text, so its answer is no evidence against that mark.
 * Unseen jobs wait until `checkedBefore`; with `skipWatched`, unanswered rechecks also use `unseenCheckedAt` in the evidence
 * so frequent watched rechecks cannot keep postponing their fallback check. With `unseen`, unanswered active jobs also
 * queue by `unseenCheckedAt`, the time of their last fallback check, rather than the watched recheck's time. This is safe
 * regardless of `skipWatched`: the marker still names their last plain check when watched rechecking is off.
 * Without `unseen`, the original ordering by `link_checked_at`, `last_seen_at` and id stays unchanged.
 */
export async function listJobsForLinkCheck(db: Executor, limit: number, options: { skipWatched?: boolean; unseen?: { seenBefore: Date; checkedBefore: Date } } = {}): Promise<Job[]> {
  if (limit <= 0) return [];
  const phraseExcluded = sql`${jobs.linkCheckJson}->>'outcome' is distinct from ${PHRASE_OUTCOME}`;
  const status = options.unseen
    ? or(
        and(eq(jobs.status, "possibly_closed"), phraseExcluded),
        and(
          eq(jobs.status, "active"),
          lt(jobs.lastSeenAt, options.unseen.seenBefore),
          or(
            isNull(jobs.linkCheckedAt),
            lt(jobs.linkCheckedAt, options.unseen.checkedBefore),
            options.skipWatched
              ? and(lastRecheckUnansweredSql(), sql`(${jobs.linkCheckJson}->>'unseenCheckedAt' is null or (${jobs.linkCheckJson}->>'unseenCheckedAt')::timestamptz < ${options.unseen.checkedBefore.toISOString()}::timestamptz)`)
              : undefined,
          ),
        ),
      )
    : eq(jobs.status, "possibly_closed");
  const lastPlainCheck = options.unseen
    ? sql`case when ${jobs.status} = 'active' and ${lastRecheckUnansweredSql()} then (${jobs.linkCheckJson}->>'unseenCheckedAt')::timestamptz else ${jobs.linkCheckedAt} end`
    : jobs.linkCheckedAt;
  return db
    .select()
    .from(jobs)
    .where(and(status, not(hasClosureOverrideSql()), options.unseen ? undefined : phraseExcluded, options.skipWatched ? or(not(watchedSql()), lastRecheckUnansweredSql()) : undefined))
    .orderBy(sql`${lastPlainCheck} asc nulls first`, ...(options.unseen ? [sql`(${jobs.status} = 'possibly_closed') desc`] : []), asc(jobs.lastSeenAt), asc(jobs.id))
    .limit(limit);
}

/** Record the outcome of a link check. `alive` brings the job back to active (the posting is online). */
export async function recordLinkCheck(db: Executor, id: number, input: { outcome: "gone" | "alive" | "unknown"; at: Date }): Promise<void> {
  const patch: JobPatch = { linkCheckedAt: input.at };
  if (input.outcome === "gone") patch.status = "closed";
  if (input.outcome === "alive") {
    patch.status = "active";
    patch.lastSeenAt = input.at;
  }
  await updateJob(db, id, patch);
}

/** Record a fallback check's `unseenCheckedAt` marker only in unanswered watched recheck evidence; never replaces evidence. */
export async function recordUnseenCheck(db: Executor, id: number, at: Date): Promise<void> {
  await db.execute(sql`
    update jobs
    set link_check_json = link_check_json || jsonb_build_object('unseenCheckedAt', ${at.toISOString()}::text)
    where id = ${id} and link_check_json->>'outcome' in ('robots', 'unknown')
  `);
}

export interface WatchedJob {
  id: number;
  status: JobStatus;
}

/**
 * Watched jobs (starred, or an application in interested … offer) due a recheck of their posting: open or possibly closed,
 * not judged by the user, never checked or last checked before `olderThan`; never-checked first, then least recently checked.
 */
export async function listWatchedJobsForRecheck(db: Executor, input: { limit: number; olderThan: Date }): Promise<WatchedJob[]> {
  if (input.limit <= 0) return [];
  return db
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(
      and(
        inArray(jobs.status, ["active", "possibly_closed"]),
        not(hasClosureOverrideSql()),
        watchedSql(),
        or(isNull(jobs.linkCheckedAt), lt(jobs.linkCheckedAt, input.olderThan)),
      ),
    )
    .orderBy(sql`${jobs.linkCheckedAt} asc nulls first`, asc(jobs.id))
    .limit(input.limit);
}

/**
 * Record a recheck of a watched job. `gone` (404 / 410) closes it; `phrase` marks it possibly closed (the user confirms);
 * `alive` opens a possibly closed job again (whatever marked it) and moves its last-seen time, like a passing link check. `unknown` / `robots` keep
 * the evidence of an earlier gone / phrase. Every outcome carries forward an existing `unseenCheckedAt` fallback marker,
 * so it survives every recheck. The check time is always written, so the job waits `interval_hours` for the next one.
 */
export async function recordWatchedCheck(db: Executor, id: number, evidence: LinkCheckEvidence, at: Date): Promise<void> {
  const json = JSON.stringify(evidence);
  const status =
    evidence.outcome === "gone"
      ? sql`'closed'::job_status`
      : evidence.outcome === "phrase"
        ? sql`'possibly_closed'::job_status`
        : evidence.outcome === "alive"
          ? sql`(case when status = 'possibly_closed' then 'active'::job_status else status end)`
          : sql`status`;
  // a live posting is a sighting, like a passing link check: a possibly closed job is open again and its last-seen time moves on
  const lastSeen = evidence.outcome === "alive" ? sql`(case when status = 'possibly_closed' then ${at.toISOString()}::timestamptz else last_seen_at end)` : sql`last_seen_at`;
  const freshEvidence = sql`${json}::jsonb || (case when link_check_json ? 'unseenCheckedAt' then jsonb_build_object('unseenCheckedAt', link_check_json->'unseenCheckedAt') else '{}'::jsonb end)`;
  const evidenceSql =
    evidence.outcome === "unknown" || evidence.outcome === "robots"
      ? sql`(case when link_check_json->>'outcome' in ('gone', 'phrase') then link_check_json else ${freshEvidence} end)`
      : freshEvidence;
  await db.execute(sql`
    update jobs
    set link_checked_at = ${at.toISOString()}::timestamptz,
        status = ${status},
        last_seen_at = ${lastSeen},
        link_check_json = ${evidenceSql}
    where id = ${id}
  `);
}
