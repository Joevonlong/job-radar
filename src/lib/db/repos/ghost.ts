/**
 * Reads and writes of the ghost job check (`job_ghost`). C9: every query of the feature lives here (the `/jobs` filter condition
 * too). Every function first checks that the table exists: before the migration ran, readers see "not checked yet" and writers skip.
 * C1: `raw_postings` is only read.
 */
import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";

import { GHOST_LEVELS, ghostReasonListSchema, isDismissActive, type GhostFilter, type GhostLevel, type GhostOfJob, type GhostReason, type GhostReasonCode, GHOST_REASONS } from "@/lib/ghost/types";

import type { Executor } from "../executor";
import { companies, jobBreakdowns, jobGhost, jobs, jobSources, rawPostings } from "../schema";
import { checkTableReady } from "./job-checks";

// ---------------------------------------------------------------- the check

export interface GhostCheckCandidate {
  jobId: number;
  /** Hash of the inputs the result will be made from (see `ghostInputHashSql`). */
  inputHash: string;
  /** The job was never checked. */
  fresh: boolean;
}

export interface GhostCheckListOptions {
  /** Hash of the rules, the limits and the channel declarations (`@/lib/ghost/step`). */
  rulesHash: string;
  /** ui.yaml `job_checks.ghost.trusted_companies` as `companies.name_norm` keys. */
  trustedKeys: readonly string[];
  /** Channels whose payload is read (a trusted posted date or a repost label): their payloads are an input. */
  payloadChannels: readonly string[];
  /** The trap tables exist and the trap check is on: the hidden pieces of the JD (`trap_scans.spans_hash`) are an input too. */
  withTrapSpans: boolean;
  limit: number;
  /** Jobs whose `recheck_at` is at or before this are listed again (a new "open for long" tier). */
  now: Date;
  /** Only these jobs (closed ones included). */
  jobIds?: readonly number[] | null;
  /** List the jobs even when their result is current. */
  force?: boolean;
}

const textArray = (values: readonly string[]): SQL => (values.length === 0 ? sql`array[]::text[]` : sql`array[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`);

/**
 * md5 of everything a result is made from: the JD, the job's status and first sighting, the rules, whether the company is trusted,
 * every source (channel, id, payload where it is read, first sighting, place, priority), the AI breakdown and the hidden pieces of
 * the JD. Expects the aliases `j` (jobs), `c` (companies) and, with trap spans, `ts` (trap_scans).
 */
function ghostInputHashSql(options: GhostCheckListOptions): SQL {
  const spans = options.withTrapSpans ? sql`coalesce(ts.spans_hash, '')` : sql`''`;
  const payloadChannels = textArray(options.payloadChannels);
  const sources = sql`coalesce((
    select string_agg(concat_ws('|', s.channel_id, r.external_id,
      case when s.channel_id = any(${payloadChannels}) then coalesce(r.payload_hash, md5(r.payload_json::text)) else '' end,
      extract(epoch from s.first_seen_at)::text, coalesce(s.location_label, ''), s.priority::text), ',' order by s.id)
    from job_sources s join raw_postings r on r.id = s.raw_posting_id
    where s.job_id = j.id), '')`;
  const breakdown = sql`coalesce((select concat_ws('|', b.source_hash, b.prompt_version, md5(b.content::text)) from job_breakdowns b where b.job_id = j.id), '')`;
  const trusted = sql`(coalesce(c.name_norm, '') = any(${textArray(options.trustedKeys)}))::text`;
  return sql`md5(concat_ws(':', md5(coalesce(j.description, '')), j.status::text, extract(epoch from j.first_seen_at)::text, ${options.rulesHash}::text, ${trusted}, ${sources}, ${breakdown}, ${spans}))`;
}

/**
 * Jobs whose ghost result is missing, was made from other inputs, or reached its `recheck_at` (the next "open for long" tier): open
 * jobs only (unless `jobIds` names them), never-checked first, newest first.
 */
export async function listJobsToGhostCheck(db: Executor, options: GhostCheckListOptions): Promise<GhostCheckCandidate[]> {
  if (!(await checkTableReady(db, "job_ghost"))) return [];
  const ids = options.jobIds ?? null;
  if (ids !== null && ids.length === 0) return [];
  const hash = ghostInputHashSql(options);
  const only = ids === null ? sql`j.status <> 'closed'` : sql`j.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
  const outdated = options.force ? sql`true` : sql`(g.job_id is null or g.input_hash <> ${hash} or (g.recheck_at is not null and g.recheck_at <= ${options.now.toISOString()}::timestamptz))`;
  const trapJoin = options.withTrapSpans ? sql`left join trap_scans ts on ts.job_id = j.id` : sql``;
  const rows = await db.execute<{ id: string | number; input_hash: string; fresh: boolean }>(sql`
    select j.id, ${hash} as input_hash, (g.job_id is null) as fresh
    from jobs j
    left join companies c on c.id = j.company_id
    ${trapJoin}
    left join job_ghost g on g.job_id = j.id
    where ${only} and ${outdated}
    order by (g.job_id is null) desc, j.first_seen_at desc, j.id desc
    limit ${options.limit}
  `);
  return Array.from(rows, (r) => ({ jobId: Number(r.id), inputHash: r.input_hash, fresh: r.fresh }));
}

/** One source posting of a job as the check reads it; `payload` only for the channels asked for. */
export interface GhostSourceRow {
  channelId: string;
  externalId: string;
  firstSeenAt: Date;
  locationLabel: string | null;
  priority: number;
  payload: unknown;
}

export interface GhostInputRow {
  jobId: number;
  status: "active" | "possibly_closed" | "closed";
  firstSeenAt: Date;
  description: string | null;
  companyNameNorm: string | null;
  sources: GhostSourceRow[];
  breakdown: { sourceHash: string; promptVersion: string; content: unknown } | null;
}

/** The stored rows the check of the given jobs is made from (C1: only read), in one query per table. */
export async function loadGhostInputs(db: Executor, jobIds: readonly number[], options: { payloadChannels: readonly string[] }): Promise<GhostInputRow[]> {
  const ids = [...new Set(jobIds)];
  if (ids.length === 0) return [];
  const payloadChannels = new Set(options.payloadChannels);
  const withPayload = options.payloadChannels.length > 0 ? inArray(jobSources.channelId, [...payloadChannels]) : sql`false`;
  const [jobRows, sourceRows, breakdownRows] = await Promise.all([
    db
      .select({ jobId: jobs.id, status: jobs.status, firstSeenAt: jobs.firstSeenAt, description: jobs.description, companyNameNorm: companies.nameNorm })
      .from(jobs)
      .leftJoin(companies, eq(companies.id, jobs.companyId))
      .where(inArray(jobs.id, ids)),
    db
      .select({
        jobId: jobSources.jobId,
        channelId: jobSources.channelId,
        externalId: rawPostings.externalId,
        firstSeenAt: jobSources.firstSeenAt,
        locationLabel: jobSources.locationLabel,
        priority: jobSources.priority,
        payload: sql<unknown>`case when ${withPayload} then ${rawPostings.payloadJson} else null end`,
      })
      .from(jobSources)
      .innerJoin(rawPostings, eq(rawPostings.id, jobSources.rawPostingId))
      .where(inArray(jobSources.jobId, ids))
      .orderBy(jobSources.id),
    db
      .select({ jobId: jobBreakdowns.jobId, sourceHash: jobBreakdowns.sourceHash, promptVersion: jobBreakdowns.promptVersion, content: jobBreakdowns.content })
      .from(jobBreakdowns)
      .where(inArray(jobBreakdowns.jobId, ids)),
  ]);
  const sources = new Map<number, GhostSourceRow[]>();
  for (const row of sourceRows) {
    const list = sources.get(row.jobId) ?? [];
    list.push({ channelId: row.channelId, externalId: row.externalId, firstSeenAt: row.firstSeenAt, locationLabel: row.locationLabel, priority: row.priority, payload: row.payload });
    sources.set(row.jobId, list);
  }
  const breakdowns = new Map(breakdownRows.map((row) => [row.jobId, { sourceHash: row.sourceHash, promptVersion: row.promptVersion, content: row.content }]));
  return jobRows.map((row) => ({
    jobId: row.jobId,
    status: row.status,
    firstSeenAt: row.firstSeenAt,
    description: row.description,
    companyNameNorm: row.companyNameNorm,
    sources: sources.get(row.jobId) ?? [],
    breakdown: breakdowns.get(row.jobId) ?? null,
  }));
}

export interface SaveGhostCheckInput {
  jobId: number;
  level: GhostLevel;
  score: number;
  reasons: GhostReason[];
  inputHash: string;
  recheckAt: Date | null;
}

/**
 * Stores a job's result (with `write: false`, only compares). Whether the level or the reasons differ from what was stored (a job
 * without a row always differs). The owner's dismissal (`dismissed_*`) is kept: a new reason code shows the mark again by itself.
 */
export async function saveGhostCheck(db: Executor, input: SaveGhostCheckInput, options: { write: boolean } = { write: true }): Promise<boolean> {
  if (!(await checkTableReady(db, "job_ghost"))) return false;
  const reasons = ghostReasonListSchema.parse(input.reasons);
  const [stored] = await db.select({ level: jobGhost.level, score: jobGhost.score, evidence: jobGhost.evidence }).from(jobGhost).where(eq(jobGhost.jobId, input.jobId)).limit(1);
  // both sides through the schema: jsonb returns the keys in its own order
  const changed = stored === undefined || stored.level !== input.level || Number(stored.score) !== input.score || JSON.stringify(parseReasons(stored.evidence)) !== JSON.stringify(reasons);
  if (!options.write) return changed;
  const values = { level: input.level, score: input.score, evidence: reasons, inputHash: input.inputHash, recheckAt: input.recheckAt, checkedAt: sql`now()` };
  await db
    .insert(jobGhost)
    .values({ jobId: input.jobId, ...values })
    .onConflictDoUpdate({ target: jobGhost.jobId, set: values });
  return changed;
}

// ---------------------------------------------------------------- what the pages read

const levels = new Set<string>(GHOST_LEVELS);
const codes = new Set<string>(GHOST_REASONS);

function parseReasons(value: unknown): GhostReason[] {
  const parsed = ghostReasonListSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

const parseLevel = (value: string): GhostLevel | null => (levels.has(value) ? (value as GhostLevel) : null);
const parseCodes = (value: readonly string[] | null): GhostReasonCode[] | null => (value === null ? null : value.filter((code): code is GhostReasonCode => codes.has(code)));

/** A job's mark on the lists. */
export interface GhostMark {
  level: Exclude<GhostLevel, "none">;
  score: number;
  /** The reasons, strongest first (the tooltip shows the first three). */
  top: GhostReason[];
}

/** The reasons strongest first (ties in `GHOST_REASONS` order). */
export function strongestFirst(reasons: readonly GhostReason[]): GhostReason[] {
  return [...reasons].sort((a, b) => b.points - a.points || GHOST_REASONS.indexOf(a.code) - GHOST_REASONS.indexOf(b.code));
}

/** The marks of the given jobs (watch and likely, not dismissed; others are absent). Empty when the table is not there yet. */
export async function loadGhostLevels(db: Executor, jobIds: readonly number[]): Promise<Map<number, GhostMark>> {
  const out = new Map<number, GhostMark>();
  if (jobIds.length === 0 || !(await checkTableReady(db, "job_ghost"))) return out;
  const rows = await db
    .select({ jobId: jobGhost.jobId, level: jobGhost.level, score: jobGhost.score, evidence: jobGhost.evidence, dismissedCodes: jobGhost.dismissedCodes })
    .from(jobGhost)
    .where(and(inArray(jobGhost.jobId, [...new Set(jobIds)]), ne(jobGhost.level, "none")));
  for (const row of rows) {
    const level = parseLevel(row.level);
    if (level === null || level === "none") continue;
    const reasons = parseReasons(row.evidence);
    if (isDismissActive(row.dismissedCodes, reasons)) continue;
    out.set(row.jobId, { level, score: Number(row.score), top: strongestFirst(reasons) });
  }
  return out;
}

/** One job's result with its reasons, for the detail page; null when the job is not checked yet or the table is not there. */
export async function getGhostOfJob(db: Executor, jobId: number): Promise<GhostOfJob | null> {
  if (!(await checkTableReady(db, "job_ghost"))) return null;
  const [row] = await db.select().from(jobGhost).where(eq(jobGhost.jobId, jobId)).limit(1);
  if (!row) return null;
  const level = parseLevel(row.level);
  if (level === null) return null;
  const reasons = parseReasons(row.evidence);
  const dismissedCodes = row.dismissedAt === null ? null : parseCodes(row.dismissedCodes ?? []);
  return {
    level,
    score: Number(row.score),
    reasons,
    checkedAt: row.checkedAt,
    dismissedAt: row.dismissedAt,
    dismissedCodes,
    dismissed: level !== "none" && isDismissActive(dismissedCodes, reasons),
  };
}

/**
 * "Not a ghost job": keeps the reason codes the job has now; only a new code shows the mark again. False when the job has no
 * watch / likely result (nothing to dismiss) or the table is not there.
 */
export async function setGhostDismissed(db: Executor, jobId: number): Promise<boolean> {
  if (!(await checkTableReady(db, "job_ghost"))) return false;
  const rows = await db
    .update(jobGhost)
    .set({ dismissedAt: sql`now()`, dismissedCodes: sql`array(select distinct e ->> 'code' from jsonb_array_elements(${jobGhost.evidence}) e order by 1)` })
    .where(and(eq(jobGhost.jobId, jobId), ne(jobGhost.level, "none")))
    .returning({ jobId: jobGhost.jobId });
  return rows.length > 0;
}

/** Undoes "not a ghost job". False when nothing was dismissed. */
export async function clearGhostDismissed(db: Executor, jobId: number): Promise<boolean> {
  if (!(await checkTableReady(db, "job_ghost"))) return false;
  const rows = await db
    .update(jobGhost)
    .set({ dismissedAt: null, dismissedCodes: null })
    .where(and(eq(jobGhost.jobId, jobId), sql`${jobGhost.dismissedAt} is not null`))
    .returning({ jobId: jobGhost.jobId });
  return rows.length > 0;
}

/** A dismissal that still holds, in SQL (alias `g` for job_ghost): every current reason code was dismissed. */
const DISMISS_ACTIVE = sql`(g.dismissed_codes is not null and not exists (select 1 from jsonb_array_elements(g.evidence) e where not ((e ->> 'code') = any(g.dismissed_codes))))`;

/**
 * The `/jobs` condition of the ghost filter over `jobId` (the jobs' id column): `only` = watch and likely jobs not dismissed;
 * `hide` = every job except the likely ones not dismissed; `all` = none. Call only when the table exists.
 */
export function ghostFilterCondition(filter: GhostFilter, jobId: SQL | typeof jobs.id): SQL | null {
  if (filter === "all") return null;
  if (filter === "only") return sql`exists (select 1 from job_ghost g where g.job_id = ${jobId} and g.level in ('watch', 'likely') and not ${DISMISS_ACTIVE})`;
  return sql`not exists (select 1 from job_ghost g where g.job_id = ${jobId} and g.level = 'likely' and not ${DISMISS_ACTIVE})`;
}

export interface GhostStats {
  /** Open jobs by level (dismissed ones included). */
  byLevel: Record<GhostLevel, number>;
  /** Open watch / likely jobs the owner dismissed (the dismissal still holds). */
  dismissed: number;
  /** Open jobs not checked yet. */
  unchecked: number;
  /** All open jobs. */
  total: number;
}

/** How the open jobs stand (for `pnpm ghost:check --json`); null when the table is not there yet. */
export async function countGhostStats(db: Executor): Promise<GhostStats | null> {
  if (!(await checkTableReady(db, "job_ghost"))) return null;
  const rows = await db.execute<{ level: string | null; dismissed: boolean | null; n: string | number }>(sql`
    select g.level, (g.level <> 'none' and ${DISMISS_ACTIVE}) as dismissed, count(*) as n
    from jobs j
    left join job_ghost g on g.job_id = j.id
    where j.status <> 'closed'
    group by 1, 2
  `);
  const stats: GhostStats = { byLevel: { none: 0, watch: 0, likely: 0 }, dismissed: 0, unchecked: 0, total: 0 };
  for (const row of rows) {
    const n = Number(row.n);
    stats.total += n;
    const level = row.level === null ? null : parseLevel(row.level);
    if (level === null) {
      stats.unchecked += n;
      continue;
    }
    stats.byLevel[level] += n;
    if (row.dismissed === true) stats.dismissed += n;
  }
  return stats;
}
