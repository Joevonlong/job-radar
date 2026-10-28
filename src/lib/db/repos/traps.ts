/** Reads and writes of the AI trap tables (`job_traps`, `trap_scans`). C9: every query of the feature lives here. */
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Executor } from "../executor";
import { companies, jobs, jobSources, jobTraps, rawPostings, scores, signalScans, trapScans } from "../schema";
import { notDormantSql } from "../queries/job-status";
import { dormancyReady } from "./dormancy";

// ---------------------------------------------------------------- availability

let tablesSeen = false;

/**
 * Whether the trap tables exist. A process that started before the migration ran (the host ai-worker during a deploy) must not
 * fail its scoring because of a missing table (42P01): callers skip the feature instead. Checked with `to_regclass`, which never
 * throws, so this is safe inside a transaction; once the tables are there the answer is cached.
 */
export async function trapTablesReady(db: Executor): Promise<boolean> {
  if (tablesSeen) return true;
  const [row] = await db.execute<{ scans: string | null; traps: string | null }>(sql`select to_regclass('trap_scans')::text as scans, to_regclass('job_traps')::text as traps`);
  tablesSeen = row?.scans !== null && row?.scans !== undefined && row.traps !== null && row.traps !== undefined;
  return tablesSeen;
}

/** For tests: forget that the tables were seen. */
export function resetTrapTablesCache(): void {
  tablesSeen = false;
}

// ---------------------------------------------------------------- the rule scan

export type JobTrapRow = typeof jobTraps.$inferSelect;
export type TrapScanRow = typeof trapScans.$inferSelect;

export interface TrapScanCandidate {
  jobId: number;
  /** md5 of `coalesce(description, '')`. */
  descriptionHash: string;
  /** md5 of the job's `raw_posting_id:payload_hash` list. */
  sourcesHash: string;
  /** The job was never scanned. */
  fresh: boolean;
}

/**
 * Jobs whose trap scan is missing or out of date (the JD, a source payload or the rules changed): never-scanned jobs first, newest
 * first. `jobIds` limits the list to these jobs; `force` lists them even when their scan is current.
 */
export async function listJobsToTrapScan(db: Executor, options: { rulesHash: string; limit: number; jobIds?: readonly number[] | null; force?: boolean }): Promise<TrapScanCandidate[]> {
  const ids = options.jobIds ?? null;
  if (ids !== null && ids.length === 0) return [];
  const only = ids === null ? notDormantSql(await dormancyReady(db), 'j') : sql`j.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
  const outdated = options.force
    ? sql`true`
    : sql`(ts.job_id is null or ts.description_hash <> j.description_md5 or ts.sources_hash <> coalesce(src.sources_hash, md5('')) or ts.rules_hash <> ${options.rulesHash})`;
  const rows = await db.execute<{ id: string | number; description_hash: string; sources_hash: string; fresh: boolean }>(sql`
    select j.id, j.description_md5 as description_hash, coalesce(src.sources_hash, md5('')) as sources_hash, (ts.job_id is null) as fresh
    from jobs j
    left join trap_scans ts on ts.job_id = j.id
    left join lateral (
      select md5(coalesce(string_agg(js.raw_posting_id::text || ':' || rp.payload_fingerprint, ',' order by js.raw_posting_id), '')) as sources_hash
      from job_sources js join raw_postings rp on rp.id = js.raw_posting_id
      where js.job_id = j.id
    ) src on true
    where ${only} and ${outdated}
    order by (ts.job_id is null) desc, j.first_seen_at desc, j.id desc
    limit ${options.limit}
  `);
  return Array.from(rows, (r) => ({ jobId: Number(r.id), descriptionHash: r.description_hash, sourcesHash: r.sources_hash, fresh: r.fresh }));
}

/**
 * Whether a job's trap scan is current: there is one, and it was made with these rules for the JD and source payloads the job has
 * now (the same test as `listJobsToTrapScan`). False when the tables are not there yet or the job does not exist. Throws when the
 * database cannot be read: a caller that hands the JD to an AI only on "current" fails closed.
 */
export async function trapScanIsCurrent(db: Executor, jobId: number, rulesHash: string): Promise<boolean> {
  if (!(await trapTablesReady(db))) return false;
  const outdated = await listJobsToTrapScan(db, { rulesHash, limit: 1, jobIds: [jobId] });
  if (outdated.length > 0) return false;
  // a job that does not exist is not listed as outdated either
  const [row] = await db.select({ jobId: trapScans.jobId }).from(trapScans).where(eq(trapScans.jobId, jobId)).limit(1);
  return row !== undefined;
}

/** Every job id, oldest first (the `--all` run of `pnpm traps:scan` pages through it). */
export async function listAllJobIds(db: Executor, options: { afterId: number; limit: number }): Promise<number[]> {
  const rows = await db.select({ id: jobs.id }).from(jobs).where(sql`${jobs.id} > ${options.afterId}`).orderBy(asc(jobs.id)).limit(options.limit);
  return rows.map((r) => r.id);
}

export interface TrapScanInput {
  jobId: number;
  description: string | null;
  sources: Array<{ rawPostingId: number; channelId: string; payload: unknown }>;
}

/** The JD and every source payload of the given jobs (what the rule scan reads; C1: the payloads are only read). */
export async function loadTrapScanInputs(db: Executor, jobIds: readonly number[]): Promise<TrapScanInput[]> {
  if (jobIds.length === 0) return [];
  const jobRows = await db.select({ id: jobs.id, description: jobs.description }).from(jobs).where(inArray(jobs.id, [...jobIds]));
  const sourceRows = await db
    .select({ jobId: jobSources.jobId, rawPostingId: jobSources.rawPostingId, channelId: jobSources.channelId, payload: rawPostings.payloadJson })
    .from(jobSources)
    .innerJoin(rawPostings, eq(rawPostings.id, jobSources.rawPostingId))
    .where(inArray(jobSources.jobId, [...jobIds]))
    .orderBy(asc(jobSources.priority), asc(jobSources.id));
  const byJob = new Map<number, TrapScanInput["sources"]>();
  for (const row of sourceRows) {
    const list = byJob.get(row.jobId) ?? [];
    list.push({ rawPostingId: row.rawPostingId, channelId: row.channelId, payload: row.payload });
    byJob.set(row.jobId, list);
  }
  return jobRows.map((row) => ({ jobId: row.id, description: row.description, sources: byJob.get(row.id) ?? [] }));
}

/** A finding to store (`TrapFinding` of `@/lib/traps` fits, plus the AI's columns). */
export interface TrapInsert {
  technique: string;
  method: string | null;
  severity: "trap" | "suspicious";
  quote: string;
  quoteSource: "description" | "raw";
  quoteOffset: number | null;
  location: string;
  rawPostingId: number | null;
  evidence: string | null;
  detail: Record<string, string | number>;
  inDescription: boolean;
  aiVerdict?: string | null;
  reason?: string | null;
}

export interface SaveTrapScanInput {
  jobId: number;
  descriptionHash: string;
  sourcesHash: string;
  rulesHash: string;
  findings: readonly TrapInsert[];
  needsAi: boolean;
  /** Hash of the JD pieces the findings remove from the AI input; null = none. */
  spansHash: string | null;
}

export interface SaveTrapScanResult {
  /** The stored rule findings changed (new job, other findings). */
  changed: boolean;
  /** The pieces removed from the AI input changed: the job's rule signals are scanned again (its `signal_scans` row was dropped). */
  spansChanged: boolean;
}

/** The comparable form of a rule finding: everything the scan decides. */
function ruleKey(f: Pick<TrapInsert, "technique" | "method" | "severity" | "quote" | "quoteSource" | "quoteOffset" | "location" | "rawPostingId" | "evidence" | "detail" | "inDescription">): string {
  const detail = Object.fromEntries(Object.entries(f.detail).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify([f.technique, f.method, f.severity, f.quote, f.quoteSource, f.quoteOffset, f.location, f.rawPostingId, f.evidence, detail, f.inDescription]);
}

const ruleRow = (jobId: number, f: TrapInsert): typeof jobTraps.$inferInsert => ({
  jobId,
  rawPostingId: f.rawPostingId,
  layer: "rule",
  technique: f.technique,
  method: f.method,
  severity: f.severity,
  quote: f.quote,
  quoteSource: f.quoteSource,
  quoteOffset: f.quoteOffset,
  location: f.location,
  evidence: f.evidence,
  detail: f.detail,
  inDescription: f.inDescription,
});

/** `trap_count` / `suspicious_count` of a job from its rows: a suspicious finding the AI confirmed counts as a trap, one it judged harmless not at all. */
const recount = (jobId: number) => sql`
  trap_count = (select count(*) from job_traps t where t.job_id = ${jobId} and (t.severity = 'trap' or t.ai_verdict = 'confirmed')),
  suspicious_count = (select count(*) from job_traps t where t.job_id = ${jobId} and t.severity = 'suspicious' and t.ai_verdict is distinct from 'confirmed' and t.ai_verdict is distinct from 'benign')`;

/**
 * Store a rule scan. When the rule findings are the same as stored, only the fingerprints move (the AI's judgement stays). Else the
 * job's findings (rule and AI) are replaced and the AI check state is cleared. When the pieces removed from the AI input changed,
 * the job's `signal_scans` row is dropped, so the signals step that follows scans its rule signals again without them.
 */
export async function saveTrapScan(db: Executor, input: SaveTrapScanInput): Promise<SaveTrapScanResult> {
  return db.transaction(async (tx) => {
    const [previous] = await tx.select().from(trapScans).where(eq(trapScans.jobId, input.jobId)).for("update").limit(1);
    const stored = await tx.select().from(jobTraps).where(and(eq(jobTraps.jobId, input.jobId), eq(jobTraps.layer, "rule"))).orderBy(asc(jobTraps.id));
    const fingerprints = { descriptionHash: input.descriptionHash, sourcesHash: input.sourcesHash, rulesHash: input.rulesHash, scannedAt: sql`now()` };
    const same =
      previous !== undefined &&
      previous.needsAi === input.needsAi &&
      (previous.spansHash ?? null) === input.spansHash &&
      stored.length === input.findings.length &&
      stored.every((row, index) => {
        const fresh = input.findings[index];
        return fresh !== undefined && ruleKey({ ...row, detail: (row.detail ?? {}) as Record<string, string | number> }) === ruleKey(fresh);
      });
    if (same) {
      await tx.update(trapScans).set(fingerprints).where(eq(trapScans.jobId, input.jobId));
      return { changed: false, spansChanged: false };
    }

    await tx.delete(jobTraps).where(eq(jobTraps.jobId, input.jobId));
    if (input.findings.length > 0) await tx.insert(jobTraps).values(input.findings.map((f) => ruleRow(input.jobId, f)));
    const spansChanged = (previous?.spansHash ?? null) !== input.spansHash;
    const foundAt = input.spansHash === null ? null : spansChanged ? sql`now()` : (previous?.foundAt ?? sql`now()`);
    const state = {
      ...fingerprints,
      trapCount: input.findings.filter((f) => f.severity === "trap").length,
      suspiciousCount: input.findings.filter((f) => f.severity === "suspicious").length,
      needsAi: input.needsAi,
      spansHash: input.spansHash,
      foundAt,
      aiDescriptionHash: null,
      aiPromptVersion: null,
      aiProvider: null,
      aiModel: null,
      aiCheckedAt: null,
    };
    await tx.insert(trapScans).values({ jobId: input.jobId, ...state }).onConflictDoUpdate({ target: trapScans.jobId, set: state });
    if (spansChanged) await tx.delete(signalScans).where(eq(signalScans.jobId, input.jobId));
    return { changed: true, spansChanged };
  });
}

/** The stored rule findings of a job in the comparable form (what `traps:scan` previews a change against). */
export async function listRuleTrapKeys(db: Executor, jobId: number): Promise<string[]> {
  const rows = await db.select().from(jobTraps).where(and(eq(jobTraps.jobId, jobId), eq(jobTraps.layer, "rule"))).orderBy(asc(jobTraps.id));
  return rows.map((row) => ruleKey({ ...row, detail: (row.detail ?? {}) as Record<string, string | number> }));
}

export { ruleKey as trapRuleKey };

// ---------------------------------------------------------------- the AI check

export interface TrapCheckCandidate {
  jobId: number;
}

/**
 * Jobs the AI check should look at, most findings first: `flagged` = the rules flagged them; `all` = also every active job that
 * passed the filter and has no AI score yet. Only scanned jobs whose scan matches the current JD, and only when the check is
 * missing or was made for another JD or prompt version.
 */
export async function listJobsToTrapCheck(db: Executor, options: { mode: "flagged" | "all"; promptVersion: string; limit: number }): Promise<TrapCheckCandidate[]> {
  const wanted =
    options.mode === "all"
      ? sql`(ts.needs_ai or (exists (select 1 from scores s where s.job_id = j.id and s.filter_result = 'passed') and not exists (select 1 from scores s where s.job_id = j.id and s.score is not null)))`
      : sql`ts.needs_ai`;
  const rows = await db.execute<{ job_id: string | number }>(sql`
    select ts.job_id
    from trap_scans ts
    join jobs j on j.id = ts.job_id
    where ${wanted}
      and j.status = 'active'
      and j.description is not null and btrim(j.description) <> ''
      and ts.description_hash = md5(coalesce(j.description, ''))
      and (ts.ai_description_hash is distinct from ts.description_hash or ts.ai_prompt_version is distinct from ${options.promptVersion})
    order by ts.trap_count desc, ts.suspicious_count desc, j.first_seen_at desc, j.id desc
    limit ${options.limit}
  `);
  return Array.from(rows, (r) => ({ jobId: Number(r.job_id) }));
}

export interface TrapCheckInput {
  jobId: number;
  title: string;
  company: string;
  description: string;
  descriptionHash: string;
  rules: JobTrapRow[];
}

/** What the AI check of one job needs: the JD, its title and company, and the rule findings. */
export async function getTrapCheckInput(db: Executor, jobId: number): Promise<TrapCheckInput | null> {
  const [row] = await db
    .select({ title: jobs.title, company: companies.name, description: jobs.description, descriptionHash: trapScans.descriptionHash })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .innerJoin(trapScans, eq(trapScans.jobId, jobs.id))
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!row || row.description === null) return null;
  const rules = await db.select().from(jobTraps).where(and(eq(jobTraps.jobId, jobId), eq(jobTraps.layer, "rule"))).orderBy(asc(jobTraps.id));
  return { jobId, title: row.title, company: row.company, description: row.description, descriptionHash: row.descriptionHash, rules };
}

export interface SaveTrapAiCheckInput {
  jobId: number;
  /** The scan's `description_hash` the check was made for; when the scan moved on meanwhile nothing is stored. */
  descriptionHash: string;
  promptVersion: string;
  provider: string;
  model: string;
  /** The AI's view of rule findings, by row id. */
  verdicts: ReadonlyArray<{ id: number; verdict: "confirmed" | "benign" | "disputed"; reason: string }>;
  /** Findings only the AI made. */
  findings: readonly TrapInsert[];
}

/** Store an AI check: the AI rows are replaced, the verdicts set, the counts and the check state updated. False when the scan changed meanwhile. */
export async function saveTrapAiCheck(db: Executor, input: SaveTrapAiCheckInput): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [scan] = await tx.select({ descriptionHash: trapScans.descriptionHash }).from(trapScans).where(eq(trapScans.jobId, input.jobId)).for("update").limit(1);
    if (!scan || scan.descriptionHash !== input.descriptionHash) return false;
    await tx.delete(jobTraps).where(and(eq(jobTraps.jobId, input.jobId), eq(jobTraps.layer, "ai")));
    await tx.update(jobTraps).set({ aiVerdict: null, reason: null }).where(eq(jobTraps.jobId, input.jobId));
    for (const verdict of input.verdicts) {
      await tx
        .update(jobTraps)
        .set({ aiVerdict: verdict.verdict, reason: verdict.reason })
        .where(and(eq(jobTraps.id, verdict.id), eq(jobTraps.jobId, input.jobId), eq(jobTraps.layer, "rule")));
    }
    if (input.findings.length > 0) {
      await tx.insert(jobTraps).values(input.findings.map((f) => ({ ...ruleRow(input.jobId, f), layer: "ai" as const, aiVerdict: null, reason: f.reason ?? null })));
    }
    const newInJd = input.findings.some((f) => f.inDescription);
    await tx.execute(sql`
      update trap_scans set ${recount(input.jobId)},
        ai_description_hash = ${input.descriptionHash}, ai_prompt_version = ${input.promptVersion}, ai_provider = ${input.provider}, ai_model = ${input.model}, ai_checked_at = now()
        ${newInJd ? sql`, found_at = coalesce(found_at, now())` : sql``}
      where job_id = ${input.jobId}
    `);
    return true;
  });
}

// ---------------------------------------------------------------- what the pages and the AI input read

export interface TrapSpanRowOfJob {
  quote: string;
  quoteOffset: number | null;
  technique: string;
  method: string | null;
}

/** The findings of the given jobs that sit in the JD (what `jdForAi` removes), by job. Empty when the tables are not there yet. */
export async function loadTrapSpanRows(db: Executor, jobIds: readonly number[]): Promise<Map<number, TrapSpanRowOfJob[]>> {
  const out = new Map<number, TrapSpanRowOfJob[]>();
  if (jobIds.length === 0 || !(await trapTablesReady(db))) return out;
  const rows = await db
    .select({ jobId: jobTraps.jobId, quote: jobTraps.quote, quoteOffset: jobTraps.quoteOffset, technique: jobTraps.technique, method: jobTraps.method })
    .from(jobTraps)
    .where(and(inArray(jobTraps.jobId, [...new Set(jobIds)]), eq(jobTraps.inDescription, true)))
    .orderBy(asc(jobTraps.quoteOffset), asc(jobTraps.id));
  for (const { jobId, ...row } of rows) {
    const list = out.get(jobId) ?? [];
    list.push(row);
    out.set(jobId, list);
  }
  return out;
}

export interface TrapCounts {
  traps: number;
  suspicious: number;
}

/** `trap_scans` counts of the given jobs (jobs without a scan are absent). Empty when the tables are not there yet. */
export async function loadTrapCounts(db: Executor, jobIds: readonly number[]): Promise<Map<number, TrapCounts>> {
  const out = new Map<number, TrapCounts>();
  if (jobIds.length === 0 || !(await trapTablesReady(db))) return out;
  const rows = await db
    .select({ jobId: trapScans.jobId, traps: trapScans.trapCount, suspicious: trapScans.suspiciousCount })
    .from(trapScans)
    .where(inArray(trapScans.jobId, [...new Set(jobIds)]));
  for (const row of rows) out.set(row.jobId, { traps: row.traps, suspicious: row.suspicious });
  return out;
}

/** A finding with the channel of the source posting it was found in (null for a finding of the JD text). */
export type JobTrapWithChannel = JobTrapRow & { channelId: string | null };

/** Every finding of a job (rule first, then AI; in JD order), and its scan; for the detail page and the resume-kit export. */
export async function listTrapsOfJob(db: Executor, jobId: number): Promise<{ rows: JobTrapWithChannel[]; scan: TrapScanRow | null }> {
  if (!(await trapTablesReady(db))) return { rows: [], scan: null };
  const [rows, [scan]] = await Promise.all([
    db
      .select({ trap: jobTraps, channelId: rawPostings.channelId })
      .from(jobTraps)
      .leftJoin(rawPostings, eq(rawPostings.id, jobTraps.rawPostingId))
      .where(eq(jobTraps.jobId, jobId))
      .orderBy(asc(jobTraps.layer), sql`${jobTraps.quoteOffset} asc nulls last`, asc(jobTraps.id)),
    db.select().from(trapScans).where(eq(trapScans.jobId, jobId)).limit(1),
  ]);
  return { rows: rows.map((r) => ({ ...r.trap, channelId: r.channelId })), scan: scan ?? null };
}

export interface TrapStats {
  /** Jobs with at least one trap. */
  jobsWithTraps: number;
  /** The same among jobs first seen since `since`. */
  recentJobsWithTraps: number;
  /** Jobs never scanned yet. */
  backlog: number;
}

/** Counts for `pnpm run doctor` (`data.traps`). */
export async function countTrapStats(db: Executor, options: { since: Date }): Promise<TrapStats> {
  const [row] = await db.execute<{ with_traps: string | number; recent: string | number; backlog: string | number }>(sql`
    select
      (select count(*) from trap_scans where trap_count > 0) as with_traps,
      (select count(*) from trap_scans ts join jobs j on j.id = ts.job_id where ts.trap_count > 0 and j.first_seen_at >= ${options.since.toISOString()}) as recent,
      (select count(*) from jobs j where not exists (select 1 from trap_scans ts where ts.job_id = j.id)) as backlog
  `);
  return { jobsWithTraps: Number(row?.with_traps ?? 0), recentJobsWithTraps: Number(row?.recent ?? 0), backlog: Number(row?.backlog ?? 0) };
}

/** Score rows made before the job's trap was found while the trap was in its JD (the trap reached the scoring prompt). */
function trappedScoresWhere() {
  return sql`${scores.score} is not null and ${scores.stale} = false and exists (
    select 1 from trap_scans ts where ts.job_id = "scores"."job_id" and ts.found_at is not null and "scores"."scored_at" < ts.found_at
  )`;
}

/** How many score rows `markTrappedScoresStale` would mark. */
export async function countTrappedScores(db: Executor): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(scores).where(trappedScoresWhere());
  return row?.n ?? 0;
}

/** `traps:scan --mark-stale`: mark exactly those score rows stale (they are scored again with the cleaned JD). Returns the job ids. */
export async function markTrappedScoresStale(db: Executor): Promise<number[]> {
  const rows = await db.update(scores).set({ stale: true }).where(trappedScoresWhere()).returning({ jobId: scores.jobId });
  return [...new Set(rows.map((r) => r.jobId))];
}
