import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Executor } from "../executor";
import { scores, signalScans, signals } from "../schema";

/** A signal to store; `SignalDraft` of `@/lib/signals` fits. C7: the quote is never empty. */
export interface SignalInsert {
  tier: (typeof signals.$inferInsert)["tier"];
  kind: string;
  value: unknown;
  quote: string;
  quoteOffset: number | null;
  /** Default `description`. */
  quoteSource?: (typeof signals.$inferInsert)["quoteSource"];
  extractor: (typeof signals.$inferInsert)["extractor"];
}

export type SignalScan = typeof signalScans.$inferSelect;

/**
 * The signals of one job, in category order (`order`: the active category ids of interests.yaml; unknown and
 * retired ids last), then by place in the JD. Without `order` by id text (the default ids T1-T4, tag sort as listed).
 */
export async function listSignalsOfJob(db: Executor, jobId: number, order: readonly string[] = []): Promise<Array<SignalInsert & { id: number }>> {
  const position = order.length > 0 ? sql`coalesce(array_position(${toTextArray(order)}, ${signals.tier}), ${order.length + 1})` : asc(signals.tier);
  const rows = await db
    .select({
      id: signals.id,
      tier: signals.tier,
      kind: signals.kind,
      value: signals.valueJson,
      quote: signals.quote,
      quoteOffset: signals.quoteOffset,
      quoteSource: signals.quoteSource,
      extractor: signals.extractor,
    })
    .from(signals)
    .where(eq(signals.jobId, jobId))
    .orderBy(position, sql`${signals.quoteOffset} asc nulls first`, asc(signals.id)); // the source field's quote has no offset: first
  return rows;
}

/**
 * The signals of one job (category id and `value_json`): what a scorer feeds to `signalBonus` to add the
 * bonus to its score (`signalBonus` decides which categories count and whether an amount is high-pay).
 */
export async function listBonusSignalsOfJob(db: Executor, jobId: number): Promise<Array<{ tier: string; value: unknown }>> {
  const rows = await db.select({ tier: signals.tier, value: signals.valueJson }).from(signals).where(eq(signals.jobId, jobId));
  return rows;
}

/** A `text[]` parameter (array_position / any). */
function toTextArray(values: readonly string[]) {
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

/** Delete condition of a rescan / AI review: the job's rows of the active categories only (retired and unknown ids stay). */
function activeRowsOf(jobId: number, activeIds: readonly string[]) {
  return activeIds.length > 0 ? and(eq(signals.jobId, jobId), inArray(signals.tier, [...activeIds])) : sql`false`;
}

export async function getSignalScan(db: Executor, jobId: number): Promise<SignalScan | null> {
  const [row] = await db.select().from(signalScans).where(eq(signalScans.jobId, jobId)).limit(1);
  return row ?? null;
}

export interface ScanCandidate {
  id: number;
  title: string;
  description: string;
  /** `jobs.salary_json`: the salary signal is made from it. */
  salaryJson: unknown;
  /** md5 of `salary_json::text` (empty text when there is none), computed by the database. */
  salaryHash: string;
}

/**
 * Jobs whose rule signals are missing or stale: never scanned, JD text changed since, or computed
 * with another vocabulary (`rulesHash`). Ordered by id; `afterId` pages through them.
 */
export async function listJobsToScan(db: Executor, options: { rulesHash: string; afterId: number; limit: number }): Promise<ScanCandidate[]> {
  const rows = await db.execute<{ id: string; title: string; description: string; salary_json: unknown; salary_hash: string }>(sql`
    select j.id, j.title, j.description, j.salary_json, md5(coalesce(j.salary_json::text, '')) as salary_hash
    from jobs j
    left join signal_scans s on s.job_id = j.id
    where j.id > ${options.afterId}
      and j.description is not null and btrim(j.description) <> ''
      and (s.job_id is null or s.description_hash <> md5(j.description) or s.rules_hash <> ${options.rulesHash})
    order by j.id
    limit ${options.limit}
  `);
  return Array.from(rows, (r) => ({ id: Number(r.id), title: r.title, description: r.description, salaryJson: r.salary_json, salaryHash: r.salary_hash }));
}

export interface RuleScanInput {
  jobId: number;
  descriptionHash: string;
  rulesHash: string;
  /** `ScanCandidate.salaryHash` of the salary the signals were made from. */
  salaryHash: string;
  candidateCount: number;
  /** The active category ids: only their rows are replaced. */
  activeIds: readonly string[];
  signals: readonly SignalInsert[];
}

const toRow = (jobId: number, s: SignalInsert): typeof signals.$inferInsert => ({
  jobId,
  tier: s.tier,
  kind: s.kind,
  valueJson: s.value ?? null,
  quote: s.quote,
  quoteOffset: s.quoteOffset,
  quoteSource: s.quoteSource ?? "description",
  extractor: s.extractor,
});

/**
 * Store the result of a rule scan. A rescan replaces what the job had of the active categories (rule
 * signals, AI signals) and clears the AI review state: the AI reviews the new situation again. Rows of
 * retired or unknown categories stay (they are hidden, and come back when the category is restored).
 */
export async function saveRuleScan(db: Executor, input: RuleScanInput): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(signals).where(activeRowsOf(input.jobId, input.activeIds));
    if (input.signals.length > 0) await tx.insert(signals).values(input.signals.map((s) => toRow(input.jobId, s)));
    const state = {
      descriptionHash: input.descriptionHash,
      rulesHash: input.rulesHash,
      salaryHash: input.salaryHash,
      candidateCount: input.candidateCount,
      scannedAt: sql`now()`,
      aiDescriptionHash: null,
      aiPromptVersion: null,
      aiProvider: null,
      aiModel: null,
      aiScannedAt: null,
    };
    await tx
      .insert(signalScans)
      .values({ jobId: input.jobId, ...state })
      .onConflictDoUpdate({ target: signalScans.jobId, set: state });
  });
}

export interface ReviewCandidate {
  id: number;
  title: string;
  description: string;
  salaryJson: unknown;
  candidateCount: number;
}

/** The conditions of `listJobsToReview` (`countJobsToReview` counts with the same ones). */
function reviewConditions(options: { promptVersion: string; withoutCandidates: boolean; jobIds?: readonly number[] }) {
  const only = options.jobIds ? sql`and j.id in (${sql.join(options.jobIds.map((id) => sql`${id}`), sql`, `)})` : sql``;
  return sql`s.description_hash = md5(j.description)
      and (s.ai_description_hash is null or s.ai_description_hash <> s.description_hash or s.ai_prompt_version is distinct from ${options.promptVersion})
      and j.status in ('active', 'possibly_closed')
      and not exists (
        select 1 from (select filter_result from scores sc where sc.job_id = j.id order by sc.created_at desc, sc.id desc limit 1) latest
        where latest.filter_result = 'filtered_out'
      )
      ${options.withoutCandidates ? sql`` : sql`and s.candidate_count > 0`}
      ${only}`;
}

/**
 * Jobs the AI should read next: rule-scanned with the current JD, not reviewed yet (or reviewed with
 * another prompt version), not filtered out, not closed. Jobs with rule candidates first, then the newest.
 */
export async function listJobsToReview(
  db: Executor,
  options: { promptVersion: string; limit: number; withoutCandidates: boolean; jobIds?: readonly number[] },
): Promise<ReviewCandidate[]> {
  const rows = await db.execute<{ id: string; title: string; description: string; salary_json: unknown; candidate_count: number }>(sql`
    select j.id, j.title, j.description, j.salary_json, s.candidate_count
    from jobs j
    join signal_scans s on s.job_id = j.id
    where ${reviewConditions(options)}
    order by (s.candidate_count > 0) desc, j.first_seen_at desc, j.id desc
    limit ${options.limit}
  `);
  return Array.from(rows, (r) => ({ id: Number(r.id), title: r.title, description: r.description, salaryJson: r.salary_json, candidateCount: r.candidate_count }));
}

/**
 * How many jobs `listJobsToReview` would hand the AI with this prompt version, without a limit (the /interests
 * preview estimates what saving a changed definition costs). With a prompt version no job was reviewed with, that is
 * every rule-scanned open job that is not filtered out.
 */
export async function countJobsToReview(db: Executor, options: { promptVersion: string; withoutCandidates: boolean }): Promise<number> {
  const rows = await db.execute<{ n: string }>(sql`
    select count(*) as n
    from jobs j
    join signal_scans s on s.job_id = j.id
    where ${reviewConditions(options)}
  `);
  return Number(Array.from(rows)[0]?.n ?? 0);
}

export interface PreviewJob {
  id: number;
  title: string;
  description: string;
}

/**
 * The newest open jobs with a description (not filtered out), for the /interests hit preview: the rule stage of
 * a draft category runs over them in memory. Read only.
 */
export async function listRecentJobsForPreview(db: Executor, limit: number): Promise<PreviewJob[]> {
  const rows = await db.execute<{ id: string; title: string; description: string }>(sql`
    select j.id, j.title, j.description
    from jobs j
    where j.status in ('active', 'possibly_closed')
      and j.description is not null and btrim(j.description) <> ''
      and not exists (
        select 1 from (select filter_result from scores sc where sc.job_id = j.id order by sc.created_at desc, sc.id desc limit 1) latest
        where latest.filter_result = 'filtered_out'
      )
    order by j.first_seen_at desc, j.id desc
    limit ${limit}
  `);
  return Array.from(rows, (r) => ({ id: Number(r.id), title: r.title, description: r.description }));
}

/** One stored amount with its job's JD (`revalueSignals`). */
export interface StoredAmount {
  id: number;
  jobId: number;
  value: unknown;
  description: string | null;
}

/** Signals of the amount category with an id above `afterId`, by id: the amounts whose EUR figures follow pipeline.yaml's rates. */
export async function listAmountSignals(db: Executor, options: { amountId: string; afterId: number; limit: number }): Promise<StoredAmount[]> {
  const rows = await db.execute<{ id: string; job_id: string; value_json: unknown; description: string | null }>(sql`
    select s.id, s.job_id, s.value_json, j.description
    from signals s
    join jobs j on j.id = s.job_id
    where s.tier = ${options.amountId} and s.id > ${options.afterId}
    order by s.id
    limit ${options.limit}
  `);
  return Array.from(rows, (r) => ({ id: Number(r.id), jobId: Number(r.job_id), value: r.value_json, description: r.description }));
}

/** Replace the `value_json` of one signal (quote, tier and review state stay). */
export async function setSignalValue(db: Executor, id: number, value: unknown): Promise<void> {
  await db.update(signals).set({ valueJson: value }).where(eq(signals.id, id));
}

/** A job whose JD is scanned but whose salary changed since (or was never looked at): only its salary signal is out of date. */
export async function listJobsToSyncSalary(db: Executor, options: { afterId: number; limit: number }): Promise<ScanCandidate[]> {
  const rows = await db.execute<{ id: string; title: string; description: string; salary_json: unknown; salary_hash: string }>(sql`
    select j.id, j.title, j.description, j.salary_json, md5(coalesce(j.salary_json::text, '')) as salary_hash
    from jobs j
    join signal_scans s on s.job_id = j.id
    where j.id > ${options.afterId}
      and j.description is not null and btrim(j.description) <> ''
      and s.description_hash = md5(j.description)
      and s.salary_hash is distinct from md5(coalesce(j.salary_json::text, ''))
    order by j.id
    limit ${options.limit}
  `);
  return Array.from(rows, (r) => ({ id: Number(r.id), title: r.title, description: r.description, salaryJson: r.salary_json, salaryHash: r.salary_hash }));
}

/**
 * Bring a job's signals in line with a new salary without touching the rest (no rescan, no new AI
 * review): the listed signals go, the new salary signal (if any) is added, the salary hash is noted.
 */
export async function replaceSalarySignals(db: Executor, input: { jobId: number; salaryHash: string; deleteIds: readonly number[]; insert: SignalInsert | null }): Promise<void> {
  await db.transaction(async (tx) => {
    if (input.deleteIds.length > 0) await tx.delete(signals).where(and(eq(signals.jobId, input.jobId), inArray(signals.id, [...input.deleteIds])));
    if (input.insert) await tx.insert(signals).values(toRow(input.jobId, input.insert));
    await tx.update(signalScans).set({ salaryHash: input.salaryHash }).where(eq(signalScans.jobId, input.jobId));
  });
}

export interface AiReviewInput {
  jobId: number;
  descriptionHash: string;
  promptVersion: string;
  provider: string;
  model: string;
  /** The active category ids: only their rows are replaced. */
  activeIds: readonly string[];
  /** The complete final signals of the job (rule tags included): they replace what the job had of the active categories. */
  signals: readonly SignalInsert[];
}

/**
 * Store the AI's review. Skipped (false) when the JD changed while the AI was working: the rule
 * stage rescans it next cycle and the AI reviews the new text.
 */
export async function saveAiReview(db: Executor, input: AiReviewInput): Promise<boolean> {
  return db.transaction(async (tx) => {
    const current = await tx.execute<{ same: boolean }>(sql`
      select s.description_hash = ${input.descriptionHash} and md5(j.description) = ${input.descriptionHash} as same
      from signal_scans s join jobs j on j.id = s.job_id where s.job_id = ${input.jobId}
    `);
    if (!Array.from(current)[0]?.same) return false;
    await tx.delete(signals).where(activeRowsOf(input.jobId, input.activeIds));
    if (input.signals.length > 0) await tx.insert(signals).values(input.signals.map((s) => toRow(input.jobId, s)));
    await tx
      .update(signalScans)
      .set({
        aiDescriptionHash: input.descriptionHash,
        aiPromptVersion: input.promptVersion,
        aiProvider: input.provider,
        aiModel: input.model,
        aiScannedAt: sql`now()`,
      })
      .where(eq(signalScans.jobId, input.jobId));
    return true;
  });
}

export interface BonusRow {
  jobId: number;
  signals: Array<{ tier: string; value: unknown }>;
  /** One of the job's `scores` rows (a job has one per profile snapshot). */
  score: { id: number; score: number | null; signalBonus: number; rankValue: number | null };
}

/**
 * Every `scores` row of a job that has signals (with their values; `signalBonus` decides which count), plus every row
 * that still carries a bonus although its job has no signals any more: the rows whose bonus may need to change.
 * The rows themselves are made by the hard filter step, one per (job, snapshot).
 */
export async function listBonusRows(db: Executor): Promise<BonusRow[]> {
  const rows = await db.execute<{
    job_id: string;
    signals: Array<{ tier: string; value: unknown }> | null;
    score_id: string;
    score: number | null;
    signal_bonus: string;
    rank_value: string | null;
  }>(sql`
    select s.job_id, t.signals, s.id as score_id, s.score, s.signal_bonus, s.rank_value
    from scores s
    left join (
      select job_id, jsonb_agg(jsonb_build_object('tier', tier, 'value', value_json)) as signals
      from signals group by job_id
    ) t on t.job_id = s.job_id
    where t.job_id is not null or s.signal_bonus <> 0
  `);
  return Array.from(rows, (r) => ({
    jobId: Number(r.job_id),
    signals: r.signals ?? [],
    score: { id: Number(r.score_id), score: r.score, signalBonus: Number(r.signal_bonus), rankValue: r.rank_value === null ? null : Number(r.rank_value) },
  }));
}

/** The new bonus (and, when the row has a match score, the rank value) of a `scores` row. */
export interface ScoreBonusUpdate {
  scoreId: number;
  signalBonus: number;
  rankValue: number | null;
}

/** Rows per statement of `setScoreBonuses`. */
const BONUS_CHUNK = 500;

/** A Postgres array literal of numbers (`null` for a missing value), sent as one parameter. */
const numberArray = (values: ReadonlyArray<number | null>): string => `{${values.map((v) => (v === null ? "NULL" : String(v))).join(",")}}`;

/** Write the bonuses (and rank values) of many `scores` rows: one statement per `BONUS_CHUNK` rows, not one per row. */
export async function setScoreBonuses(db: Executor, updates: readonly ScoreBonusUpdate[]): Promise<void> {
  for (let i = 0; i < updates.length; i += BONUS_CHUNK) {
    const part = updates.slice(i, i + BONUS_CHUNK);
    await db.execute(sql`
      update ${scores} set signal_bonus = v.signal_bonus, rank_value = v.rank_value
      from (
        select unnest(${numberArray(part.map((u) => u.scoreId))}::bigint[]) as id,
          unnest(${numberArray(part.map((u) => u.signalBonus))}::numeric[]) as signal_bonus,
          unnest(${numberArray(part.map((u) => u.rankValue))}::numeric[]) as rank_value
      ) v
      where ${scores.id} = v.id
    `);
  }
}
