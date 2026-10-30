// Frozen pre-projection query baseline.
import { asc, count, desc, eq, ilike, sql } from "drizzle-orm";

import type { CompanySort } from "@/lib/companies/search-params";
import type { SortDir } from "@/lib/jobs/constants";
import type { CompanyMatchRow } from "@/lib/pipeline/company";

import type { Db } from "@/lib/db/client";
import type { Executor } from "@/lib/db/executor";
import { uxTablesReady } from "@/lib/db/repos/ux-tables";
import { companies, jobs } from "@/lib/db/schema";
import { latestScoreCte } from "./job-cards";
import { escapeLike, jobListWhere } from "./jobs";

/** Every stored company as the company filter compares it (the table is small: one row per employer). */
export async function listCompanyMatchRows(db: Executor): Promise<CompanyMatchRow[]> {
  return db.select({ id: companies.id, name: companies.name, nameNorm: companies.nameNorm, aliases: companies.aliases }).from(companies).orderBy(asc(companies.id));
}

export interface CompanyOverviewOptions {
  q: string;
  sort: CompanySort;
  dir: SortDir;
  page: number;
  pageSize: number;
  timezone: string;
}

export interface CompanyOverviewRow extends CompanyMatchRow {
  watched: boolean;
  blacklisted: boolean;
  jobCount: number;
  topRank: number | null;
  lastFirstSeenAt: Date;
}

export interface CompanyOverviewPage {
  rows: CompanyOverviewRow[];
  total: number;
  page: number;
  pageCount: number;
}

/** One row per stored company with jobs in the default /jobs list, even when a company-name link matches several records. */
export async function listCompanyOverview(db: Db, options: CompanyOverviewOptions): Promise<CompanyOverviewPage> {
  const latest = latestScoreCte(db);
  const ux = await uxTablesReady(db);
  // Aggregate the jobs first: joining company names/aliases to every job makes the group unnecessarily wide.
  const grouped = db.$with("company_jobs").as(
    db.select({
      companyId: jobs.companyId,
      jobCount: count().as("job_count"),
      topRank: sql<number | null>`max(${latest.rankValue})`.mapWith((value: unknown) => value === null ? null : Number(value)).as("top_rank"),
      lastFirstSeenAt: sql<Date>`max(${jobs.firstSeenAt})`.mapWith(jobs.firstSeenAt).as("last_first_seen_at"),
    })
      .from(jobs)
      .leftJoin(latest, eq(latest.jobId, jobs.id))
      .where(await jobListWhere(db, {}, options.timezone, latest, ux))
      .groupBy(jobs.companyId),
  );
  const q = options.q.trim();
  const where = q ? ilike(companies.name, `%${escapeLike(q)}%`) : undefined;
  const [countRow] = await db.with(latest, grouped)
    .select({ total: count() })
    .from(grouped)
    .innerJoin(companies, eq(companies.id, grouped.companyId))
    .where(where);
  const total = countRow?.total ?? 0;
  const pageSize = Math.max(1, Math.floor(options.pageSize));
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(options.page)), pageCount);
  if (total === 0) return { rows: [], total, page, pageCount };

  const primary = { jobs: grouped.jobCount, score: grouped.topRank, recent: grouped.lastFirstSeenAt }[options.sort];
  const way = options.dir === "asc" ? sql`asc` : sql`desc`;
  const rows = await db.with(latest, grouped)
    .select({
      id: companies.id,
      name: companies.name,
      nameNorm: companies.nameNorm,
      aliases: companies.aliases,
      watched: companies.watched,
      blacklisted: companies.blacklisted,
      jobCount: grouped.jobCount,
      topRank: grouped.topRank,
      lastFirstSeenAt: grouped.lastFirstSeenAt,
    })
    .from(grouped)
    .innerJoin(companies, eq(companies.id, grouped.companyId))
    .where(where)
    .orderBy(sql`${primary} ${way} nulls last`, desc(grouped.jobCount), asc(companies.name), asc(companies.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { rows, total, page, pageCount };
}
