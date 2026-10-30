import { withRebuiltCurrentScores } from "../helpers/current-scores";
import { count, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, expect, inject, it } from "vitest";

import { closeDb, getDb, listJobs, schema } from "@/lib/db";
import { getSql } from "@/lib/db/client";
import { cardColumns, hydrateCards, latestScoreCte } from "@/lib/db/queries/job-cards";
import { countJobList, jobListWhere, jobOrderBy, type JobFilters, type ListJobsOptions } from "@/lib/db/queries/jobs";
import { lastListedSql } from "@/lib/db/queries/job-status";
import { policyCurrency } from "@/lib/db/queries/signal-filter";
import { dormancyReady } from "@/lib/db/repos/dormancy";
import { listingReady } from "@/lib/db/repos/listing";
import { uxTablesReady } from "@/lib/db/repos/ux-tables";
import { DEFAULT_SORT_DIR, JOB_SCOPES, JOB_SORTS, SORT_DIRS } from "@/lib/jobs/constants";

import { searchPlan } from "../fixtures/job-search";
import { addJob, addSource, ago, NOW } from "./dormant-fixture";

beforeAll(() => { process.env.DATABASE_URL = inject("testDatabaseUrl"); });
afterAll(closeDb);

beforeEach(async () => {
  const db = getDb();
  // Each scope has ties, missing dates/salaries, unscored jobs and two filtered jobs.
  for (const status of ["active", "closed"] as const) for (let index = 0; index < 10; index += 1) {
    const job = await addJob({
      status, firstSeenAt: ago(Math.floor(index / 2)), lastSeenAt: ago(1),
      postedAt: index === 4 ? null : ago(Math.floor(index / 2)),
      germanLevelRequired: index === 4 ? "B2" : "unknown",
      salaryJson: index === 4 ? null : { raw: "EUR 60000–80000 per year", currency: "EUR", period: "year", min: 60000, max: 80000,
        perYear: { min: 60000, max: 80000 }, periodAssumed: false, origin: "description", reasonCodes: [],
        baseCurrency: "EUR", basePerYear: { min: 60000, max: 80000 }, qualityStatus: index === 5 ? "review" : "valid",
        otherRegion: index === 6 ? "description" : null },
      skills: ["Python"],
    });
    if (index !== 4) await addSource(job.id, ago(Math.floor(index / 2)));
    if (index === 4) continue; // No score row at all.
    const filtered = index === 3 || index === 9;
    const pending = index === 2 || index === 5;
    if (index === 2 || index === 7 || index === 9) {
      // A timestamp tie must pick the higher score id; pending rows use this scored fallback.
      await withRebuiltCurrentScores(db, db.insert(schema.scores).values({ jobId: job.id, filterResult: "passed", score: 40, rankValue: 41, createdAt: ago(2) }));
      await withRebuiltCurrentScores(db, db.insert(schema.scores).values({ jobId: job.id, filterResult: "passed", score: 80, rankValue: 82.5,
        signalBonus: 2.5, germanLevel: "C1", summaryEn: "Fallback summary", summaryZh: "Fallback translation", outputLang: "en", createdAt: ago(2) }));
    }
    if (index !== 7) await withRebuiltCurrentScores(db, db.insert(schema.scores).values({
      jobId: job.id, filterResult: filtered ? "filtered_out" : "passed", filterReasons: filtered ? ["contract"] : [],
      score: filtered || pending ? null : 70, rankValue: filtered || pending ? null : 72.5, signalBonus: 2.5,
      germanLevel: pending ? "B1" : "A2", stale: index === 8,
      summaries: { en: `Summary ${index}`, zh: `Translation ${index}` }, outputLang: "en", createdAt: ago(1),
    }));
    await db.insert(schema.signals).values({ jobId: job.id, tier: "skills", kind: "kw", quote: "Python", extractor: "rule" });
    if (index === 0) {
      await db.insert(schema.jobFavorites).values({ jobId: job.id });
      await db.insert(schema.applications).values({ jobId: job.id, status: "applied" });
      await db.insert(schema.jobSeen).values({ jobId: job.id, via: "detail", seenAt: NOW });
      await db.update(schema.jobs).set({ relistedAt: NOW, relistCount: 2 }).where(eq(schema.jobs.id, job.id));
    }
    if (index === 1) await db.insert(schema.jobClosureOverrides).values({ jobId: job.id, action: status === "active" ? "closed" : "open" });
    if (status === "closed" && index === 8) await db.update(schema.jobs).set({ status: "possibly_closed", dormantAt: NOW }).where(eq(schema.jobs.id, job.id));
  }
});

/** The former single wide rows query, kept independent of the paginated implementation. */
async function singleQueryReference(options: ListJobsOptions) {
  const db = getDb();
  const latest = latestScoreCte(db);
  const ux = await uxTablesReady(db);
  const where = await jobListWhere(db, options.filters, options.timezone, latest, ux);
  const [row] = await db.with(latest).select({ total: count() }).from(schema.jobs)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.jobs.companyId))
    .leftJoin(latest, eq(latest.jobId, schema.jobs.id)).where(where);
  const total = row?.total ?? 0;
  const pageSize = Math.max(1, options.pageSize);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(options.page)), pageCount);
  const listing = await listingReady(db);
  const rows = await db.with(latest).select(cardColumns(latest, ux, await dormancyReady(db), listing))
    .from(schema.jobs).innerJoin(schema.companies, eq(schema.companies.id, schema.jobs.companyId))
    .leftJoin(latest, eq(latest.jobId, schema.jobs.id)).where(where)
    .orderBy(...jobOrderBy(options.sort, options.dir ?? DEFAULT_SORT_DIR[options.sort], latest, policyCurrency(options.filters), lastListedSql(listing), options.filters))
    .limit(pageSize).offset((page - 1) * pageSize);
  return { jobs: await hydrateCards(db, rows, { visa: options.visa ?? true, ghost: options.ghost === true }), total, page, pageCount, pageSize };
}

it.each(JOB_SCOPES.flatMap((scope) => [false, true].map((includeFiltered) => ({ scope, includeFiltered }))))(
  "matches the single-query cards for every sort/direction and both pages: $scope, includeFiltered=$includeFiltered",
  async ({ scope, includeFiltered }) => {
    for (const sort of JOB_SORTS) for (const dir of SORT_DIRS) {
      const pageIds: number[] = [];
      for (const page of [1, 2]) {
        const options = { filters: { scope, includeFiltered }, sort, dir, page, pageSize: 5, timezone: "UTC" };
        const expected = await singleQueryReference(options);
        const actual = await listJobs(getDb(), options);
        expect(actual, `${scope}/${includeFiltered}/${sort}/${dir}/${page}`).toEqual(expected);
        expect(actual.page).toBe(page);
        expect(actual.jobs).toHaveLength(!includeFiltered && scope !== "all" && page === 2 ? 3 : 5);
        pageIds.push(...actual.jobs.map(({ id }) => id));
      }
      expect(new Set(pageIds).size).toBe(pageIds.length);
    }
  },
);

it("retains score-dependent filters, clamping and hydration options", async () => {
  const filters: JobFilters[] = [
    { scope: "all", includeFiltered: true, hideGermanLevels: ["C1", "B2"] },
    { scope: "all", minRank: 75 },
    { scope: "all", filteredOnly: true },
    { scope: "all", includeFiltered: true, highValue: { amountId: null, amountHighValue: false, otherIds: ["skills"], minAnnualEur: null, rates: {}, otherRegionPoints: 0 } },
    { scope: "all", unseenOnly: true },
    { companyIds: [] },
  ];
  for (const filter of filters) for (const sort of JOB_SORTS) for (const dir of SORT_DIRS) for (const page of [1, 2, 999]) {
    const options = { filters: filter, sort, dir, page, pageSize: 3, timezone: "UTC", visa: false, ghost: true };
    expect(await listJobs(getDb(), options)).toEqual(await singleQueryReference(options));
  }
});

it("matches the single-query cards for searches, with relevance and every other sort", async () => {
  const db = getDb();
  const rows = await db.select({ id: schema.jobs.id }).from(schema.jobs).orderBy(schema.jobs.id);
  // Titles, descriptions and countries vary so relevance has distinct levels as well as ties.
  for (const [index, { id }] of rows.entries()) {
    await db.update(schema.jobs).set({
      title: index % 3 === 0 ? "AI Platform Engineer" : index % 3 === 1 ? `Engineer ${index}` : "Data Analyst",
      description: index % 2 === 0 ? "Build AI systems in Berlin." : "Build reliable systems with Python.",
      locationsJson: [{ city: index % 4 === 0 ? "Berlin" : "Paris", label: "", countryCode: index % 4 === 0 ? "DE" : "FR", isPrimary: true }],
    }).where(eq(schema.jobs.id, id));
  }
  const searches: JobFilters[] = [
    { scope: "all", includeFiltered: true, search: searchPlan("AI engineer") },
    { scope: "all", search: searchPlan("ai"), searchIn: "all" },
    { scope: "current", search: searchPlan("Germany") },
    { scope: "all", includeFiltered: true, search: searchPlan("engineer"), countries: ["FR"] },
    { scope: "all", search: searchPlan("!!!") },
  ];
  for (const filters of searches) for (const sort of JOB_SORTS) for (const dir of SORT_DIRS) for (const page of [1, 2, 999]) {
    const options = { filters, sort, dir, page, pageSize: 3, timezone: "UTC" };
    const actual = await listJobs(getDb(), options);
    expect(actual, `${JSON.stringify(filters.search?.terms?.map((t) => t.text))}/${sort}/${dir}/${page}`).toEqual(await singleQueryReference(options));
    expect(actual.total).toBe(await countJobList(getDb(), options));
  }
  // Not vacuous: relevance puts the title hits for both words first, and differs from rank order.
  const relevance = await listJobs(getDb(), { filters: searches[0]!, sort: "relevance", page: 1, pageSize: 20, timezone: "UTC" });
  const rank = await listJobs(getDb(), { filters: searches[0]!, sort: "rank", page: 1, pageSize: 20, timezone: "UTC" });
  expect(relevance.total).toBeGreaterThan(3);
  expect(relevance.jobs[0]!.title).toBe("AI Platform Engineer");
  expect(relevance.jobs.map(({ id }) => id)).not.toEqual(rank.jobs.map(({ id }) => id));
});

it("clamps a page beyond the last page to the same cards as requesting the last page directly", async () => {
  const options: ListJobsOptions = { filters: { scope: "all", includeFiltered: true }, sort: "rank", page: 1, pageSize: 3, timezone: "UTC" };
  const total = await countJobList(getDb(), options);
  const lastPage = Math.ceil(total / options.pageSize);
  expect(lastPage).toBeGreaterThan(1);
  for (const sort of JOB_SORTS) for (const dir of SORT_DIRS) {
    const direct = await listJobs(getDb(), { ...options, sort, dir, page: lastPage });
    const clamped = await listJobs(getDb(), { ...options, sort, dir, page: lastPage + 10 });
    expect(clamped).toEqual(direct);
    expect(clamped.page).toBe(lastPage);
    expect(clamped.total).toBe(total);
    expect(clamped.jobs).toHaveLength(total % options.pageSize);
  }
});

it.each([1, 3])("returns an empty first page when page %i has no matching jobs", async (page) => {
  const actual = await listJobs(getDb(), { filters: { companyIds: [] }, sort: "rank", page, pageSize: 3, timezone: "UTC" });
  expect(actual).toEqual({ jobs: [], total: 0, page: 1, pageCount: 1, pageSize: 3 });
});

it("returns totals matching countJobList across filter sets and requested pages", async () => {
  const filters: JobFilters[] = [
    {},
    { scope: "all", includeFiltered: true },
    { scope: "archive" },
    { scope: "all", minRank: 75 },
    { scope: "all", includeFiltered: true, hideGermanLevels: ["C1", "B2"] },
    { scope: "all", filteredOnly: true },
    { scope: "all", favoritesOnly: true },
    { scope: "all", unseenOnly: true },
    { companyIds: [] },
  ];
  for (const filter of filters) {
    const total = await countJobList(getDb(), { filters: filter, timezone: "UTC" });
    for (const page of [1, 2, 999]) {
      const actual = await listJobs(getDb(), { filters: filter, sort: "rank", page, pageSize: 3, timezone: "UTC" });
      expect(actual.total).toBe(total);
    }
  }
});

it("paginates ids without wide score values in the PostgreSQL plan and fetches only the page cards", async () => {
  const queries: { query: string; params: unknown[] }[] = [];
  const db = drizzle(getSql(), { schema, logger: { logQuery(query, params) { queries.push({ query, params }); } } });
  const options: ListJobsOptions = { filters: { scope: "all", includeFiltered: true, hideGermanLevels: ["B2"] }, sort: "rank", page: 2, pageSize: 3, timezone: "UTC" };
  for (const sort of JOB_SORTS) for (const dir of SORT_DIRS) {
    queries.length = 0;
    const actual = await listJobs(db, { ...options, sort, dir });
    expect(queries.filter(({ query }) => query.includes('select "jobs"."id", count(*) over () from "jobs"'))).toHaveLength(1);
    expect(queries.some(({ query }) => query.includes('select count(*) from "jobs"'))).toBe(false);
    const cardQueries = queries.filter(({ query }) => query.includes("left join lateral"));
    expect(cardQueries).toHaveLength(1);
    const cardQuery = cardQueries[0]!;
    const idPredicate = 'where "jobs"."id" in (';
    expect(cardQuery.query).toContain(idPredicate);
    const idParams = Array.from(cardQuery.query.slice(cardQuery.query.lastIndexOf(idPredicate)).matchAll(/\$(\d+)/g),
      ([, position]) => cardQuery.params[Number(position) - 1]);
    expect(idParams).toEqual(actual.jobs.map(({ id }) => id));

    const latest = latestScoreCte(db);
    const idsQuery = db.with(latest).select({ id: schema.jobs.id, total: sql<number>`count(*) over ()`.mapWith(Number) }).from(schema.jobs)
      .innerJoin(schema.companies, eq(schema.companies.id, schema.jobs.companyId))
      .leftJoin(latest, eq(latest.jobId, schema.jobs.id))
      .where(await jobListWhere(db, options.filters, options.timezone, latest, true))
      .orderBy(...jobOrderBy(sort, dir, latest, "EUR", lastListedSql(true)))
      .limit(options.pageSize).offset(options.pageSize);
    const plan = await db.execute(sql`explain (verbose, format json) ${idsQuery}`);
    const text = JSON.stringify(plan);
    expect(text, `${sort}/${dir}`).not.toContain("CTE Scan");
    expect(text, `${sort}/${dir}`).not.toMatch(/scores(?:_\d+)?\.(?:summaries|summary_zh|summary_en|output_lang|filter_reasons|signal_bonus|stale)/);
  }

  queries.length = 0;
  expect((await listJobs(db, { ...options, filters: { companyIds: [] } })).jobs).toEqual([]);
  expect(queries.some(({ query }) => query.includes("left join lateral"))).toBe(false);
});
