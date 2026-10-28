/**
 * Reads and writes of the visa check (`job_visa`). C9: every query of the feature lives here (and the `/jobs` filter condition in
 * `queries/jobs.ts`). Every function first checks that the table exists: before the migration ran, readers see "not checked yet"
 * and writers skip.
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";

import { visaEvidenceListSchema, visaKindOf, type VisaEvidence, type VisaKind, type VisaStatus, VISA_STATUSES } from "@/lib/visa/types";

import type { Executor } from "../executor";
import { companies, jobs, jobVisa } from "../schema";
import { checkTableReady } from "./job-checks";
import { notDormantSql } from "../queries/job-status";
import { dormancyReady } from "./dormancy";

// ---------------------------------------------------------------- the scan

export interface VisaScanCandidate {
  jobId: number;
  /** Hash of the inputs the result will be made from (see `visaInputHashSql`). */
  inputHash: string;
  /** The job was never checked. */
  fresh: boolean;
}

export interface VisaScanListOptions {
  /** `CompiledVisaRules.fingerprint`. */
  rulesHash: string;
  limit: number;
  /** The trap tables exist and the trap check is on: the hidden pieces of the JD (`trap_scans.spans_hash`) are an input too. */
  withTrapSpans: boolean;
  /** Only these jobs (closed ones included). */
  jobIds?: readonly number[] | null;
  /** List the jobs even when their result is current. */
  force?: boolean;
}

/**
 * `md5(md5(description) : rules hash : company name_norm : trap spans hash)`, the same string `inputHash` of `@/lib/job-checks`
 * hashes. Expects the aliases `j` (jobs), `c` (companies) and, with trap spans, `ts` (trap_scans).
 */
function visaInputHashSql(rulesHash: string, withTrapSpans: boolean): SQL {
  const spans = withTrapSpans ? sql`coalesce(ts.spans_hash, '')` : sql`''`;
  return sql`md5(concat_ws(':', md5(coalesce(j.description, '')), ${rulesHash}::text, coalesce(c.name_norm, ''), ${spans}))`;
}

/**
 * Jobs whose visa result is missing or was made from other inputs (the JD, the rules, the company or the hidden pieces of the JD
 * changed): open jobs only (unless `jobIds` names them), never-checked first, newest first.
 */
export async function listJobsToVisaScan(db: Executor, options: VisaScanListOptions): Promise<VisaScanCandidate[]> {
  if (!(await checkTableReady(db, "job_visa"))) return [];
  const ids = options.jobIds ?? null;
  if (ids !== null && ids.length === 0) return [];
  const hash = visaInputHashSql(options.rulesHash, options.withTrapSpans);
  const only = ids === null ? sql`j.status <> 'closed' and ${notDormantSql(await dormancyReady(db), 'j')}` : sql`j.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
  const outdated = options.force ? sql`true` : sql`(v.job_id is null or v.input_hash <> ${hash})`;
  const trapJoin = options.withTrapSpans ? sql`left join trap_scans ts on ts.job_id = j.id` : sql``;
  const rows = await db.execute<{ id: string | number; input_hash: string; fresh: boolean }>(sql`
    select j.id, ${hash} as input_hash, (v.job_id is null) as fresh
    from jobs j
    left join companies c on c.id = j.company_id
    ${trapJoin}
    left join job_visa v on v.job_id = j.id
    where ${only} and ${outdated}
    order by (v.job_id is null) desc, j.first_seen_at desc, j.id desc
    limit ${options.limit}
  `);
  return Array.from(rows, (r) => ({ jobId: Number(r.id), inputHash: r.input_hash, fresh: r.fresh }));
}

export interface VisaScanInput {
  jobId: number;
  description: string | null;
  companyNameNorm: string | null;
}

/** The JD and the company key of the given jobs (C1: only read). */
export async function loadVisaScanInputs(db: Executor, jobIds: readonly number[]): Promise<VisaScanInput[]> {
  if (jobIds.length === 0) return [];
  const rows = await db
    .select({ jobId: jobs.id, description: jobs.description, companyNameNorm: companies.nameNorm })
    .from(jobs)
    .leftJoin(companies, eq(companies.id, jobs.companyId))
    .where(inArray(jobs.id, [...new Set(jobIds)]));
  return rows;
}

export interface SaveVisaScanInput {
  jobId: number;
  status: VisaStatus;
  evidence: VisaEvidence[];
  inputHash: string;
}

/**
 * Stores a job's result (with `write: false`, only compares). Whether the status or the quotes differ from what was stored (a job
 * without a row always differs). The input hash and `checked_at` are updated either way.
 */
export async function saveVisaScan(db: Executor, input: SaveVisaScanInput, options: { write: boolean } = { write: true }): Promise<boolean> {
  if (!(await checkTableReady(db, "job_visa"))) return false;
  const evidence = visaEvidenceListSchema.parse(input.evidence);
  const [stored] = await db.select({ status: jobVisa.status, evidence: jobVisa.evidence }).from(jobVisa).where(eq(jobVisa.jobId, input.jobId)).limit(1);
  // both sides through the schema: jsonb returns the keys in its own order
  const changed = stored === undefined || stored.status !== input.status || JSON.stringify(parseEvidence(stored.evidence)) !== JSON.stringify(evidence);
  if (!options.write) return changed;
  await db
    .insert(jobVisa)
    .values({ jobId: input.jobId, status: input.status, evidence, inputHash: input.inputHash, checkedAt: sql`now()` })
    .onConflictDoUpdate({ target: jobVisa.jobId, set: { status: input.status, evidence, inputHash: input.inputHash, checkedAt: sql`now()` } });
  return changed;
}

// ---------------------------------------------------------------- what the pages read

const statusSchema = new Set<string>(VISA_STATUSES);

function parseEvidence(value: unknown): VisaEvidence[] {
  const parsed = visaEvidenceListSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

function parseStatus(value: string): VisaStatus | null {
  return statusSchema.has(value) ? (value as VisaStatus) : null;
}

export interface VisaOfJob {
  /** Only the clear results are listed. */
  status: "offered" | "not_offered";
  /** The `kind` of a `not_offered` result; null otherwise. */
  kind: VisaKind;
}

/** The result of the given jobs, for the list badge (jobs not checked yet are absent). Empty when the table is not there yet. */
export async function loadVisaStatuses(db: Executor, jobIds: readonly number[]): Promise<Map<number, VisaOfJob>> {
  const out = new Map<number, VisaOfJob>();
  if (jobIds.length === 0 || !(await checkTableReady(db, "job_visa"))) return out;
  const rows = await db
    .select({ jobId: jobVisa.jobId, status: jobVisa.status, evidence: jobVisa.evidence })
    .from(jobVisa)
    .where(and(inArray(jobVisa.jobId, [...new Set(jobIds)]), inArray(jobVisa.status, ["offered", "not_offered"])));
  for (const row of rows) {
    const status = parseStatus(row.status);
    if (status !== "offered" && status !== "not_offered") continue;
    out.set(row.jobId, { status, kind: visaKindOf({ status, evidence: parseEvidence(row.evidence) }) });
  }
  return out;
}

export interface VisaDetail {
  status: VisaStatus;
  kind: VisaKind;
  evidence: VisaEvidence[];
  checkedAt: Date;
}

/** One job's result with its quotes, for the detail page; null when the job is not checked yet or the table is not there. */
export async function getVisaOfJob(db: Executor, jobId: number): Promise<VisaDetail | null> {
  if (!(await checkTableReady(db, "job_visa"))) return null;
  const [row] = await db.select().from(jobVisa).where(eq(jobVisa.jobId, jobId)).limit(1);
  if (!row) return null;
  const status = parseStatus(row.status);
  if (status === null) return null;
  const evidence = parseEvidence(row.evidence);
  return { status, kind: visaKindOf({ status, evidence }), evidence, checkedAt: row.checkedAt };
}

export interface VisaStats {
  /** Open jobs by result. */
  byStatus: Record<VisaStatus, number>;
  /** `not_offered` jobs by kind. */
  notOfferedByKind: { no_sponsorship: number; permit_required: number };
  /** Open jobs not checked yet. */
  unchecked: number;
}

/** How the open jobs stand (for `pnpm visa:scan --json`); null when the table is not there yet. */
export async function countVisaStats(db: Executor): Promise<VisaStats | null> {
  if (!(await checkTableReady(db, "job_visa"))) return null;
  const rows = await db.execute<{ status: string | null; kind: string | null; n: string | number }>(sql`
    select v.status, case when v.status = 'not_offered' then coalesce((select e ->> 'kind' from jsonb_array_elements(v.evidence) e where e ->> 'status' = 'not_offered' limit 1), 'no_sponsorship') end as kind, count(*) as n
    from jobs j
    left join job_visa v on v.job_id = j.id
    where j.status <> 'closed' and ${notDormantSql(await dormancyReady(db), 'j')}
    group by 1, 2
  `);
  const stats: VisaStats = { byStatus: { offered: 0, not_offered: 0, unclear: 0, not_mentioned: 0 }, notOfferedByKind: { no_sponsorship: 0, permit_required: 0 }, unchecked: 0 };
  for (const row of rows) {
    const n = Number(row.n);
    const status = row.status === null ? null : parseStatus(row.status);
    if (status === null) {
      stats.unchecked += n;
      continue;
    }
    stats.byStatus[status] += n;
    if (status === "not_offered") stats.notOfferedByKind[row.kind === "permit_required" ? "permit_required" : "no_sponsorship"] += n;
  }
  return stats;
}
