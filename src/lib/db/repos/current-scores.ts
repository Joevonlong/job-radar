import { z } from "zod";
import { sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";

import { loadConfig } from "@/lib/config/load";
import type { Executor } from "../executor";
import type * as schema from "../schema";
import { latestScoreCte, latestScoreLateral } from "../queries/job-cards";

const scoreBrand: unique symbol = Symbol("score transaction");
type Transaction = PgTransaction<PostgresJsQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;
interface ScoreState { touched: Set<number>; owner: Executor }
/** Only scoreTransaction creates this capability. Refresh runs after the outer callback returns. */
export type ScoreTx = Transaction & { readonly [scoreBrand]: ScoreState; touch(jobIds: Iterable<number>): void };
const exists = new WeakSet<Executor>();
const ownerOf = (db: Executor): Executor => scoreBrand in db ? (db as ScoreTx)[scoreBrand].owner : db;
export function invalidateCurrentScores(db: Executor): void { exists.delete(ownerOf(db)); }
export function missingCurrentScores(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return ("code" in error && error.code === "42P01") || ("cause" in error && missingCurrentScores(error.cause));
}
/** Positive answers only: a migration can make the table appear without restarting a process. */
export async function currentScoresTableExists(db: Executor): Promise<boolean> {
  const owner = ownerOf(db);
  if (exists.has(owner)) return true;
  const [row] = await db.execute<{ present: boolean }>(sql`select to_regclass('job_current_scores') is not null as present`);
  if (row?.present) exists.add(owner);
  return row?.present === true;
}

export async function scoreTransaction<T>(db: Executor | ScoreTx, work: (tx: ScoreTx) => Promise<T>): Promise<T> {
  const nested = scoreBrand in db;
  const state: ScoreState = nested ? (db as ScoreTx)[scoreBrand] : { touched: new Set(), owner: db };
  return db.transaction(async (raw) => {
    const tx = Object.assign(raw, { [scoreBrand]: state, touch: (ids: Iterable<number>) => { for (const id of ids) state.touched.add(id); } });
    const result = await work(tx);
    if (!nested) await refreshCurrentScores(tx, [...state.touched]);
    return result;
  });
}

export const CURRENT_SCORE_COLUMNS = [
  "job_id", "newest_score_id", "scored_score_id", "filter_result", "filter_reasons", "score", "rank_value", "signal_bonus", "stale", "german_level", "summaries", "summary_zh", "summary_en", "output_lang",
] as const;
const columns = sql.join(CURRENT_SCORE_COLUMNS.map((name) => sql.identifier(name)), sql`, `);
const array = (ids: readonly number[]) => `{${ids.join(",")}}`;

/** Authoritative display rule; callers choose the indexed form only for a bounded set. */
export function currentScoreRule(db: Executor, jobIds?: readonly number[], lateral = false) {
  if (jobIds && lateral) {
    const latest = latestScoreLateral(db, jobIds, true);
    return db.select().from(latest);
  }
  const latest = latestScoreCte(db, jobIds, true);
  return db.with(latest).select().from(latest);
}

/** Last step only: lock in one statement, then calculate from a fresh READ COMMITTED snapshot. */
async function refreshCurrentScores(tx: ScoreTx, jobIds: readonly number[]): Promise<void> {
  if (jobIds.length === 0 || !(await currentScoresTableExists(tx))) return;
  await tx.execute(sql`select job_current_scores_lock(${array(jobIds)}::bigint[])`);
  const rule = currentScoreRule(tx, jobIds, jobIds.length <= loadConfig("currentScores").refresh.lateral_max_jobs);
  const assignments = sql.join(CURRENT_SCORE_COLUMNS.slice(1).map((name) => sql`${sql.identifier(name)} = excluded.${sql.identifier(name)}`), sql`, `);
  const oldValues = sql.join(CURRENT_SCORE_COLUMNS.slice(1).map((name) => sql`target.${sql.identifier(name)}`), sql`, `);
  const newValues = sql.join(CURRENT_SCORE_COLUMNS.slice(1).map((name) => sql`excluded.${sql.identifier(name)}`), sql`, `);
  await tx.execute(sql`with computed as (${rule}),
        written as (
          insert into job_current_scores as target (${columns}) select ${columns} from computed
          on conflict (job_id) do update set ${assignments}, refreshed_at = now()
          where row(${oldValues}) is distinct from row(${newValues}) returning job_id
        )
        delete from job_current_scores where job_id = any(${array(jobIds)}::bigint[])
          and not exists (select 1 from computed where computed.job_id = job_current_scores.job_id)`);
}

/** One snapshot, both directions: missing, incorrect and orphan projection rows all count. */
export async function checkCurrentScores(db: Executor): Promise<number[]> {
  if (!(await currentScoresTableExists(db))) return [];
  const rule = currentScoreRule(db);
  const rows = await db.execute<{ job_id: number }>(sql`with expected as (${rule}), differences as (
    (select ${columns} from expected except all select ${columns} from job_current_scores)
    union all
    (select ${columns} from job_current_scores except all select ${columns} from expected)
  ) select distinct job_id from differences order by job_id`);
  return rows.map((row) => Number(row.job_id));
}
export async function repairCurrentScores(db: Executor, jobIds: readonly number[]): Promise<void> {
  await scoreTransaction(db, async (tx) => { tx.touch(jobIds); });
}
/** Keyset batches include orphan rows, so a rebuild removes them as well as filling missing rows. */
export async function rebuildCurrentScores(db: Executor, options: { batchJobs: number }): Promise<number> {
  if (!Number.isSafeInteger(options.batchJobs) || options.batchJobs < 1) throw new Error("batchJobs must be a positive integer");
  if (!(await currentScoresTableExists(db))) return 0;
  let after = 0, total = 0;
  for (;;) {
    const rows = await db.execute<{ job_id: number }>(sql`select job_id from (
      select job_id from scores union select job_id from job_current_scores
    ) ids where job_id > ${after} order by job_id limit ${options.batchJobs}`);
    if (rows.length === 0) return total;
    const ids = rows.map((row) => Number(row.job_id));
    await repairCurrentScores(db, ids);
    after = ids[ids.length - 1]!;
    total += ids.length;
  }
}

export interface CurrentScoresHealth {
  present: boolean; rows: number; checkedAt: string | null; differences: number | null; remaining: number | null;
}
/** Read-only diagnostics; the last maintenance check survives process restarts. */
export async function currentScoresHealth(db: Executor): Promise<CurrentScoresHealth> {
  if (!(await currentScoresTableExists(db))) return { present: false, rows: 0, checkedAt: null, differences: null, remaining: null };
  const [count] = await db.execute<{ n: number }>(sql`select count(*)::int as n from job_current_scores`);
  const [row] = await db.execute<{ value: unknown; checked_at: string }>(sql`select value, updated_at::text as checked_at from runtime_state where key = 'current_scores_check'`);
  const parsed = healthValue.safeParse(row?.value);
  return { present: true, rows: count?.n ?? 0, checkedAt: row?.checked_at ?? null, differences: parsed.success ? parsed.data.differences : null, remaining: parsed.success ? parsed.data.remaining : null };
}

const healthValue = z.strictObject({ differences: z.number().int().nonnegative(), remaining: z.number().int().nonnegative() });
export async function recordCurrentScoresCheck(db: Executor, counts: { differences: number; remaining: number }): Promise<void> {
  await db.execute(sql`insert into runtime_state (key, value) values ('current_scores_check', ${JSON.stringify(healthValue.parse(counts))}::jsonb)
    on conflict (key) do update set value = excluded.value, updated_at = now()`);
}
