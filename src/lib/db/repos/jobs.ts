import { and, asc, eq, getTableColumns, inArray, isNotNull, isNull, lt, ne, not, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import { FOLLOWING_STATUSES } from "@/lib/applications/following";
import type { LinkCheckEvidence } from "@/lib/jobs/link-check-evidence";

import type { Executor } from "../executor";
import { applications, channels, companies, jobClosureOverrides, jobFavorites, jobFilterOverrides, jobSources, jobs, rawPostings } from "../schema";
import { dormancyReady, jobReadColumns } from "./dormancy";
import { listingColumnsSql, listingReady, listingSetSql } from "./listing";
import { notDormantSql } from "../queries/job-status";

export type Job = Omit<typeof jobs.$inferSelect, "searchTsv" | "descriptionMd5" | "descriptionHasText" | "salaryMd5">;
export type NewJob = Omit<typeof jobs.$inferInsert, "descriptionMd5" | "descriptionHasText" | "salaryMd5">;
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
  const [row] = await db.select(await jobReadColumns(db)).from(jobs).where(eq(jobs.id, id)).limit(1);
  return row ?? null;
}

export async function insertJob(db: Executor, values: NewJob): Promise<Job> {
  // Drizzle lists omitted nullable columns as DEFAULT too. Name only supplied domain columns so
  // a web/worker request can insert before the runner has added the internal fingerprint columns.
  const columns: Record<string, PgColumn> = getTableColumns(jobs);
  const dormant = await dormancyReady(db);
  const listing = await listingReady(db);
  const internal = new Set(["descriptionMd5", "descriptionHasText", "salaryMd5", "searchTsv", ...(!dormant ? ["dormantAt", "possiblyClosedAt"] : []), ...(!listing ? ["lastListedAt", "relistedAt", "relistCount"] : [])]);
  const entries = Object.entries(values).filter(([key, value]) => value !== undefined && key in columns && !internal.has(key));
  return db.transaction(async (tx) => {
    const [inserted] = await tx.execute<{ id: string | number }>(sql`insert into ${jobs}
      (${sql.join(entries.map(([key]) => sql.identifier(columns[key]!.name)), sql`, `)})
      values (${sql.join(entries.map(([key, value]) => sql.param(value, columns[key])), sql`, `)}) returning id`);
    const row = inserted ? await getJob(tx, Number(inserted.id)) : null;
    if (!row) throw new Error("insertJob: insert returned no row");
    return row;
  });
}

/** A posting of the job seen at `observedAt` (see `recordJobListing`). */
export interface JobListingObservation {
  observedAt: Date;
  observedRunId: number | null;
  minGapDays: number;
}

/**
 * Apply the patch. With `listing`, the same single UPDATE records the listing (one row version, one `search_tsv`
 * computation); the result says whether it counted a relisting. Repeated and out-of-order observations leave the
 * listing columns as they are and are not counted: the gap test needs `observedAt >= last_listed_at + gap` and
 * `last_listed_at` only moves forward. Without `listing`, or while the listing columns do not exist yet, the result is false.
 */
export async function updateJob(db: Executor, id: number, patch: JobPatch, listing?: JobListingObservation): Promise<boolean> {
  if (listing === undefined || !(await listingReady(db))) {
    await db.update(jobs).set(patch).where(eq(jobs.id, id));
    return false;
  }
  const observed = sql`${listing.observedAt.toISOString()}::timestamptz`;
  const cycle = sql`(select cycle_id from runs where id = ${listing.observedRunId})`;
  // the row version before this statement (locked), to tell a counted relisting from a repeat of the same observation
  const prior = db.select({ lastListedAt: jobs.lastListedAt }).from(jobs).where(eq(jobs.id, id)).for("update").as("prior");
  const [row] = await db
    .update(jobs)
    .set({ ...patch, ...listingColumnsSql(observed, cycle, listing.minGapDays) })
    .from(prior)
    .where(eq(jobs.id, id))
    .returning({ relisted: sql<boolean>`coalesce(${jobs.relistedAt} = ${observed} and ${prior.lastListedAt} < ${observed}, false)` });
  return row?.relisted === true;
}

/** The next `limit` jobs above `afterId` with their title and title key (for recomputing the keys when the key function changes). */
export async function listJobTitleKeys(db: Executor, input: { afterId: number; limit: number }): Promise<Array<Pick<Job, "id" | "title" | "titleNorm">>> {
  return db
    .select({ id: jobs.id, title: jobs.title, titleNorm: jobs.titleNorm })
    .from(jobs)
    .where(sql`${jobs.id} > ${input.afterId}`)
    .orderBy(asc(jobs.id))
    .limit(input.limit);
}

/**
 * Store new title keys, one `update` for all rows; a row whose title changed since it was read keeps its key (the writer of
 * the new title wrote its key). Returns the ids that changed.
 */
export async function setJobTitleNorms(db: Executor, rows: ReadonlyArray<{ id: number; title: string; titleNorm: string }>): Promise<number[]> {
  if (rows.length === 0) return [];
  const values = sql.join(rows.map((row) => sql`(${row.id}::bigint, ${row.title}::text, ${row.titleNorm}::text)`), sql`, `);
  const changed = await db.execute<{ id: string | number }>(
    sql`update jobs set title_norm = v.title_norm from (values ${values}) as v(id, title, title_norm) where jobs.id = v.id and jobs.title = v.title returning jobs.id`,
  );
  return [...changed].map((row) => Number(row.id));
}

/** Of these jobs, the ones with something the user did on them: an application (status, notes), a favourite, a filter or closure override. */
export async function jobIdsWithUserState(db: Executor, ids: readonly number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const list = [...ids];
  const found = await Promise.all([
    db.select({ id: applications.jobId }).from(applications).where(inArray(applications.jobId, list)),
    db.select({ id: jobFavorites.jobId }).from(jobFavorites).where(inArray(jobFavorites.jobId, list)),
    db.select({ id: jobFilterOverrides.jobId }).from(jobFilterOverrides).where(inArray(jobFilterOverrides.jobId, list)),
    db.select({ id: jobClosureOverrides.jobId }).from(jobClosureOverrides).where(inArray(jobClosureOverrides.jobId, list)),
  ]);
  return new Set(found.flat().map((row) => row.id));
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
  // A partial upgrade may already hold both guest spellings. Match legacy ids too without discarding either raw payload.
  const canonicalId = input.family === "linkedin" ? input.externalId.replace(/^li-/, "") : input.externalId;
  const externalIds = input.family === "linkedin" ? [canonicalId, `li-${canonicalId}`] : [canonicalId];
  const [row] = await db
    .select({ jobId: jobSources.jobId })
    .from(jobSources)
    .innerJoin(rawPostings, eq(rawPostings.id, jobSources.rawPostingId))
    .where(
      and(
        inArray(rawPostings.externalId, externalIds),
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
    .select(await jobReadColumns(db))
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
  /** Source observations that qualified as a relist. */
  relisted: number;
}

/**
 * `jobs.last_seen_at` = the latest time any source returned the posting (`raw_postings.fetched_at`,
 * refreshed by every collect). A job a source returns again after it was possibly_closed / closed is
 * active again. Never moves `last_seen_at` backwards. Jobs are updated, never deleted.
 */
export async function touchJobsSeen(db: Executor, options: { relistMinGapDays: number }): Promise<SeenResult> {
  const dormant = await dormancyReady(db);
  const listing = await listingReady(db);
  const advances = sql`(c.seen > jobs.last_seen_at)`;
  const listingChanged = listing ? sql`(j.last_listed_at is null or l.seen > j.last_listed_at)` : sql`false`;
  const rows = await db.execute<{ seen: number; reopened: number; relisted: number }>(sql`
    with latest as (
      select distinct on (js.job_id) js.job_id, r.fetched_at as seen, r.run_id
      from job_sources js join raw_postings r on r.id = js.raw_posting_id
      order by js.job_id, r.fetched_at desc, r.id desc
    ), changed as (
      select j.id, j.status as old_status, j.last_seen_at as old_seen, l.seen, l.run_id,
        ${listing ? sql`coalesce(j.relist_count, 0)` : sql`0`} as old_relist_count
      from jobs j join latest l on l.job_id = j.id
      where l.seen > j.last_seen_at or ${listingChanged}
      -- Keep the old counters/status locked too, so RETURNING counts only this statement's changes.
      for update of j
    ), upd as (
      update jobs
      set last_seen_at = greatest(jobs.last_seen_at, c.seen),
          status = case when ${advances} then
            case when jobs.status = 'possibly_closed' and jobs.link_check_json->>'outcome' = ${PHRASE_OUTCOME}
              then jobs.status else 'active' end else jobs.status end
          ${dormant ? sql`, dormant_at = case when ${advances} then null else jobs.dormant_at end` : sql``}
          ${listing ? sql`, ${listingSetSql(sql`c.seen`, sql`(select cycle_id from runs where id = c.run_id)`, options.relistMinGapDays)}` : sql``}
      from changed c
      where jobs.id = c.id and (c.seen > jobs.last_seen_at
        ${listing ? sql`or jobs.last_listed_at is null or c.seen > jobs.last_listed_at` : sql``})
      returning jobs.id, jobs.status, c.old_status, c.seen > c.old_seen as seen,
        ${listing ? sql`coalesce(jobs.relist_count, 0) > c.old_relist_count` : sql`false`} as relisted
    )
    select count(*) filter (where seen)::int as seen,
      count(*) filter (where seen and old_status <> 'active' and status = 'active')::int as reopened,
      count(*) filter (where relisted)::int as relisted from upd
  `);
  const row = rows[0];
  return { seen: row?.seen ?? 0, reopened: row?.reopened ?? 0, relisted: row?.relisted ?? 0 };
}

/**
 * Active jobs no source has returned for `days` days become `possibly_closed` only when every source
 * channel completed a successful run after the job fell overdue. A run stretched beyond its base window by
 * catch-up or backfill is not evidence: a wider window under the same result cap can be filled by older postings.
 * Jobs it leaves unmarked are caught by the unseen-job link check. An ATS source whose board was checked
 * since then also needs a complete board read after that point, in a successful run with the normal search
 * window so its returned postings were persisted.
 * Non-ATS sources are unaffected by the board rule; removed or disabled boards stop blocking once their last
 * check falls before the overdue point. Returns the ids that changed.
 */
export async function markJobsPossiblyClosed(db: Executor, input: { now: Date; days: number }): Promise<number[]> {
  const cutoff = new Date(input.now.getTime() - input.days * 86_400_000);
  const rows = await db.execute<{ id: string }>(sql`
    update jobs
    set status = 'possibly_closed'
      ${await dormancyReady(db) ? sql`, possibly_closed_at = ${input.now.toISOString()}::timestamptz` : sql``}
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
              and not r.window_extended
              and r.started_at >= jobs.last_seen_at + make_interval(days => ${input.days})
          )
      )
      and not exists (
        -- an ATS source whose board was checked after the job fell overdue but has not been read
        -- completely since then by a successful run that kept the normal search window
        select 1 from job_sources js
        join raw_postings rp on rp.id = js.raw_posting_id
        join ats_boards b on b.ats = rp.channel_id and b.token = rp.payload_json #>> '{source,token}'
        where js.job_id = jobs.id
          and b.last_checked_at >= jobs.last_seen_at + make_interval(days => ${input.days})
          and (b.last_ok_at is null
               or b.last_ok_at < jobs.last_seen_at + make_interval(days => ${input.days})
               or (select r.window_extended = false and r.status = 'succeeded' from runs r
                   where r.channel_id = b.ats and r.started_at <= b.last_ok_at
                   order by r.started_at desc limit 1) is not true)
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
    .select(await jobReadColumns(db))
    .from(jobs)
    .where(and(status, notDormantSql(await dormancyReady(db)), not(hasClosureOverrideSql()), options.unseen ? undefined : phraseExcluded, options.skipWatched ? or(not(watchedSql()), lastRecheckUnansweredSql()) : undefined))
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
  if (input.outcome !== "unknown" && await dormancyReady(db)) patch.dormantAt = null;
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
  const dormant = await dormancyReady(db);
  await db.execute(sql`
    update jobs
    set link_checked_at = ${at.toISOString()}::timestamptz,
        status = ${status},
        last_seen_at = ${lastSeen},
        link_check_json = ${evidenceSql}
        ${dormant && (evidence.outcome === "alive" || evidence.outcome === "gone") ? sql`, dormant_at = null` : sql``}
        ${dormant && evidence.outcome === "phrase" ? sql`, possibly_closed_at = case when jobs.status <> 'possibly_closed' then ${at.toISOString()}::timestamptz else possibly_closed_at end` : sql``}
    where id = ${id}
  `);
}
