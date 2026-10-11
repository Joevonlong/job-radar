/** Reads and writes of `salary_benchmarks` and the salary figures it is built from (C9). */
import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";

import { jobLocationSchema, type JobLocation } from "@/lib/domain/types";

import type { Executor } from "../executor";
import { annualBaseFigureSql, comparableSalaryWhere } from "../queries/salary-figure";
import { jobs, runtimeState, salaryBenchmarks } from "../schema";

// ---------------------------------------------------------------- availability

let tablesSeen = false;

/**
 * Whether the salary tables exist (a process that started before the migration must not fail because of a missing table;
 * the card then says the benchmark is not built yet). `to_regclass` never throws; once seen, the answer is cached.
 */
export async function salaryTablesReady(db: Executor): Promise<boolean> {
  if (tablesSeen) return true;
  const [row] = await db.execute<{ benchmarks: string | null; lookups: string | null }>(
    sql`select to_regclass('salary_benchmarks')::text as benchmarks, to_regclass('salary_lookups')::text as lookups`,
  );
  tablesSeen = typeof row?.benchmarks === "string" && typeof row.lookups === "string";
  return tablesSeen;
}

/** For tests: forget that the tables were seen. */
export function resetSalaryTablesCache(): void {
  tablesSeen = false;
}

// ---------------------------------------------------------------- inputs

/** One posting with a comparable annual figure in the base currency (`annualBaseFigure`), for the benchmark. */
export interface SalaryFigureRow {
  jobId: number;
  companyId: number;
  title: string;
  seniority: string;
  /** The first location of the posting (null when it names none). */
  location: JobLocation | null;
  figure: number;
}

const firstLocation = (value: unknown): JobLocation | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const parsed = jobLocationSchema.safeParse(value[0]);
  return parsed.success ? parsed.data : null;
};

/** Postings first seen since `since` whose salary is comparable (not under review, not another region's) in `currency`. */
export async function listSalaryFigures(db: Executor, input: { currency: string; since: Date; companyId?: number }): Promise<SalaryFigureRow[]> {
  const figure = annualBaseFigureSql(input.currency);
  const rows = await db
    .select({ jobId: jobs.id, companyId: jobs.companyId, title: jobs.title, seniority: jobs.seniority, locations: jobs.locationsJson, figure: sql<string | number | null>`${figure}` })
    .from(jobs)
    .where(and(gte(jobs.firstSeenAt, input.since), comparableSalaryWhere, sql`${figure} is not null`, input.companyId !== undefined ? eq(jobs.companyId, input.companyId) : undefined));
  return rows.flatMap((row) => {
    const value = Number(row.figure);
    return Number.isFinite(value) && value > 0
      ? [{ jobId: row.jobId, companyId: row.companyId, title: row.title, seniority: row.seniority, location: firstLocation(row.locations), figure: value }]
      : [];
  });
}

// ---------------------------------------------------------------- the stored benchmark

export type SalaryBenchmarkRow = typeof salaryBenchmarks.$inferSelect;

export interface SalaryBenchmarkInput {
  roleFamily: string;
  seniority: string;
  geoLevel: "city" | "country" | "all";
  geoKey: string;
  currency: string;
  n: number;
  nAi: number;
  median: number;
  quantiles: number[];
}

/** `runtime_state` key of the last rebuild: a rebuild that found no group leaves the table empty but still counts as done. */
export const SALARY_BENCHMARK_STATE_KEY = "salary:benchmark";

/** Replace the whole benchmark in one transaction (readers see the old or the new one, never a half). */
export async function replaceSalaryBenchmarks(db: Executor, rows: readonly SalaryBenchmarkInput[], at: Date = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const value = { refreshedAt: at.toISOString(), groups: rows.length };
    await tx.insert(runtimeState).values({ key: SALARY_BENCHMARK_STATE_KEY, value }).onConflictDoUpdate({ target: runtimeState.key, set: { value, updatedAt: sql`now()` } });
    await tx.delete(salaryBenchmarks);
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((row) => ({ ...row, median: Math.round(row.median * 100) / 100, refreshedAt: at }));
      if (chunk.length > 0) await tx.insert(salaryBenchmarks).values(chunk);
    }
  });
}

export async function listSalaryBenchmarks(db: Executor): Promise<SalaryBenchmarkRow[]> {
  return db.select().from(salaryBenchmarks).orderBy(salaryBenchmarks.roleFamily, salaryBenchmarks.seniority, salaryBenchmarks.geoLevel, salaryBenchmarks.geoKey);
}

/** The candidate groups of one job (its family in `currency`, the given seniority or any): the card picks the narrowest. */
export async function findSalaryBenchmarks(db: Executor, input: { family: string; seniorities: readonly string[]; currency: string }): Promise<SalaryBenchmarkRow[]> {
  return db
    .select()
    .from(salaryBenchmarks)
    .where(and(eq(salaryBenchmarks.roleFamily, input.family), eq(salaryBenchmarks.currency, input.currency), inArray(salaryBenchmarks.seniority, [...input.seniorities])));
}

/** When the benchmark was last rebuilt (null: never, e.g. right after an upgrade and before the first cycle). */
export async function salaryBenchmarkRefreshedAt(db: Executor): Promise<Date | null> {
  const [state] = await db.select({ value: runtimeState.value }).from(runtimeState).where(eq(runtimeState.key, SALARY_BENCHMARK_STATE_KEY)).limit(1);
  const stored = state?.value as { refreshedAt?: unknown } | undefined;
  if (typeof stored?.refreshedAt === "string" && !Number.isNaN(Date.parse(stored.refreshedAt))) return new Date(stored.refreshedAt);
  // rebuilt by a version that did not record the time yet: the rows carry it
  const [row] = await db.select({ at: salaryBenchmarks.refreshedAt }).from(salaryBenchmarks).orderBy(desc(salaryBenchmarks.refreshedAt)).limit(1);
  return row?.at ?? null;
}

/** The comparable figures of the other postings of one company in the window (for "same company in your data"). */
export async function listCompanySalaryFigures(db: Executor, input: { companyId: number; excludeJobId: number; currency: string; since: Date }): Promise<number[]> {
  const figure = annualBaseFigureSql(input.currency);
  const rows = await db
    .select({ figure: sql<string | number | null>`${figure}` })
    .from(jobs)
    .where(and(eq(jobs.companyId, input.companyId), ne(jobs.id, input.excludeJobId), gte(jobs.firstSeenAt, input.since), comparableSalaryWhere, isNotNull(jobs.salaryJson), sql`${figure} is not null`));
  return rows.map((row) => Number(row.figure)).filter((value) => Number.isFinite(value) && value > 0);
}
