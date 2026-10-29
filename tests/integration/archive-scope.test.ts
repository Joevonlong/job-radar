import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, inject, it } from "vitest";

import { closeDb, countJobList, countJobListSeen, getDb, getJobDetail, listJobs, listUnseenJobIds, schema, type JobFilters } from "@/lib/db";
import { latestScoreCte } from "@/lib/db/queries/job-cards";
import { buildJobConditions } from "@/lib/db/queries/jobs";
import { archiveReasonSql, closedReasonSql, dormantSql, effectiveStatusSql, jobScopeSql, lastListedSql, notDormantSql } from "@/lib/db/queries/job-status";
import { resetDormancyCache } from "@/lib/db/repos/dormancy";
import { recordLinkCheck } from "@/lib/db/repos/jobs";
import { effectiveJobStatus } from "@/lib/jobs/closure";
import { ARCHIVE_REASONS, JOB_SCOPES, JOB_STATUSES, type JobSort, type SortDir } from "@/lib/jobs/constants";
import { resolveJobScope } from "@/lib/jobs/scope";
import { loadJobsSearchParams } from "@/lib/jobs/search-params";
import { resolveSort } from "@/lib/jobs/sort";

import { addJob, addSource, ago, NOW } from "./dormant-fixture";

const timezone = "UTC";
beforeAll(() => { process.env.DATABASE_URL = inject("testDatabaseUrl"); resetDormancyCache(); });
afterAll(closeDb);

const list = (filters: JobFilters = {}, sort: JobSort | null = null, dir: SortDir | null = null, page = 1, pageSize = 100) => listJobs(getDb(), {
  filters, sort: resolveSort({ sort, q: filters.q ?? null, scope: resolveJobScope(filters.scope, filters.statuses) }),
  dir, page, pageSize, timezone, visa: false, ghost: false,
});
const ids = (rows: { jobs: { id: number }[] }) => rows.jobs.map((job) => job.id);

async function fixture() {
  const active = await addJob({ status: "active", workplace: "remote" });
  const possible = await addJob();
  const phrase = await addJob({ linkCheckJson: { outcome: "phrase" } });
  const dormant = await addJob({ dormantAt: ago(1), workplace: "remote" });
  const dormantPhrase = await addJob({ dormantAt: ago(1), linkCheckJson: { outcome: "phrase" } });
  const gone = await addJob({ status: "closed", workplace: "remote", linkCheckJson: { outcome: "gone", httpStatus: 404 } });
  const manual = await addJob({ status: "active" });
  const reopened = await addJob({ status: "closed" });
  await getDb().insert(schema.jobClosureOverrides).values([
    { jobId: manual.id, action: "closed" }, { jobId: reopened.id, action: "open" },
  ]);
  const filtered = await addJob({ status: "closed" });
  await getDb().insert(schema.scores).values({ jobId: filtered.id, filterResult: "filtered_out" });
  return { active, possible, phrase, dormant, dormantPhrase, gone, manual, reopened, filtered };
}

/** Frozen pre-scope list conditions and rank ordering: compares legacy links without using the new scope helper. */
async function legacyIds(filters: JobFilters) {
  const db = getDb();
  const latest = latestScoreCte(db);
  const rows = await db.with(latest).select({ id: schema.jobs.id }).from(schema.jobs)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.jobs.companyId))
    .leftJoin(latest, eq(latest.jobId, schema.jobs.id))
    .where(and(
      buildJobConditions(db, filters, timezone, latest, true),
      filters.includeFiltered ? undefined : or(isNull(latest.filterResult), ne(latest.filterResult, "filtered_out")),
      filters.statuses?.length ? undefined : sql`${effectiveStatusSql(true)} <> 'closed'`,
      filters.statuses?.length ? undefined : notDormantSql(true),
    ))
    .orderBy(sql`coalesce(${latest.filterResult} = 'filtered_out', false) asc`, sql`${latest.rankValue} desc nulls last`, sql`${schema.jobs.postedAt} desc nulls last`, desc(schema.jobs.firstSeenAt), desc(schema.jobs.id));
  return rows.map((row) => row.id);
}

it("keeps the default and every legacy status-only result, ordering and count unchanged", async () => {
  await fixture();
  for (const statuses of [undefined, [], ["active"], ["possibly_closed"], ["closed"], ["closed", "possibly_closed"]] as const) {
    for (const includeFiltered of [false, true]) {
      const filters: JobFilters = { statuses, includeFiltered };
      const expected = await legacyIds(filters);
      const actual = await list(filters);
      expect(ids(actual)).toEqual(expected);
      expect(actual.total).toBe(expected.length);
      expect(await countJobList(getDb(), { filters, timezone })).toBe(expected.length);
    }
  }
});

it("partitions every filtered set, including search, with matching list, switch and seen counts", async () => {
  await fixture();
  const selections: JobFilters[] = [{}, { q: "Python" }, { q: "no-match" }, { q: "Engineer", workplaces: ["remote"] }, { includeFiltered: true }, { statuses: ["possibly_closed"] }, { closedReasons: ["gone", "dormant"] }];
  for (const filters of selections) {
    const current = await list({ ...filters, scope: "current" });
    const archive = await list({ ...filters, scope: "archive" });
    const all = await list({ ...filters, scope: "all" });
    expect(ids(current).filter((id) => ids(archive).includes(id))).toEqual([]);
    expect(new Set([...ids(current), ...ids(archive)])).toEqual(new Set(ids(all)));
    expect(current.total + archive.total).toBe(all.total);
    for (const [scope, result] of [["current", current], ["archive", archive], ["all", all]] as const) {
      const selected = { ...filters, scope };
      expect(await countJobList(getDb(), { filters: selected, timezone })).toBe(result.total);
      expect((await countJobListSeen(getDb(), { filters: selected, timezone, since: null })).unseen).toBe(result.total);
      expect(new Set(await listUnseenJobIds(getDb(), { filters: selected, timezone }))).toEqual(new Set(ids(result)));
    }
  }
});

it("archives manual/gone and effective dormant jobs, but keeps undormant and phrase-only jobs current", async () => {
  const f = await fixture();
  expect(new Set(ids(await list({ scope: "archive" })))).toEqual(new Set([f.manual.id, f.gone.id, f.dormant.id, f.dormantPhrase.id]));
  expect(new Set(ids(await list({ scope: "current", statuses: ["possibly_closed"] })))).toEqual(new Set([f.possible.id, f.phrase.id]));
  expect((await list({ scope: "current", statuses: ["closed"] })).total).toBe(0);
  const expected = { manual: [f.manual.id], gone: [f.gone.id], dormant: [f.dormant.id, f.dormantPhrase.id] };
  for (const reason of ["manual", "gone", "dormant"] as const) {
    expect(new Set(ids(await list({ scope: "archive", closedReasons: [reason] })))).toEqual(new Set(expected[reason]));
  }
  expect(new Set(ids(await list({ scope: "all", closedReasons: ["manual", "dormant"] })))).toEqual(new Set([...expected.manual, ...expected.dormant]));
  expect((await list({ scope: "archive", statuses: ["closed"], closedReasons: ["dormant"] })).total).toBe(0);
});

it("direct archive URLs use last-listed descending with id ties, nulls last and stable pagination; explicit sorts win", async () => {
  const older = await addJob({ status: "closed", firstSeenAt: ago(1), salaryJson: { min: 120000, max: 140000, currency: "EUR", period: "year", basePerYear: { min: 120000, max: 140000 }, baseCurrency: "EUR" } });
  const newer = await addJob({ status: "closed", firstSeenAt: ago(2) });
  const tied = await addJob({ status: "closed", firstSeenAt: ago(3) });
  const unknown = await addJob({ status: "closed", firstSeenAt: ago(4) });
  await addSource(older.id, ago(20));
  await addSource(newer.id, ago(10));
  await addSource(tied.id, ago(10));
  const fromUrl = (query: string) => {
    const params = loadJobsSearchParams(query);
    return list({ scope: params.scope, statuses: params.status, q: params.q }, params.sort, params.dir);
  };
  const expected = [tied.id, newer.id, older.id, unknown.id];
  for (const query of ["?scope=archive", "?scope=archive&q=Engineer", "?scope=archive&sort=bad"]) expect(ids(await fromUrl(query))).toEqual(expected);
  expect(ids(await fromUrl("?scope=archive&dir=asc"))).toEqual([older.id, newer.id, tied.id, unknown.id]);
  expect(ids(await fromUrl("?scope=archive&sort=rank"))).toEqual([older.id, newer.id, tied.id, unknown.id]);
  expect(ids(await fromUrl("?scope=archive&sort=first_seen&dir=asc"))).toEqual([unknown.id, tied.id, newer.id, older.id]);
  expect(ids(await fromUrl("?scope=archive&sort=salary"))[0]).toBe(older.id);
  expect([...ids(await list({ scope: "archive" }, null, null, 1, 2)), ...ids(await list({ scope: "archive" }, null, null, 2, 2))]).toEqual(expected);
});

it("reads max source fetched_at in cards and details, unchanged after alive then gone link checks", async () => {
  const job = await addJob({ status: "active" });
  await addSource(job.id, ago(30));
  const [latest] = await getDb().insert(schema.rawPostings).values({ channelId: "fx", externalId: "another-source", payloadJson: {}, fetchedAt: ago(20) }).returning();
  await getDb().insert(schema.jobSources).values({ jobId: job.id, rawPostingId: latest!.id, channelId: "fx" });
  const [before] = await getDb().select({ at: lastListedSql(false) }).from(schema.jobs).where(eq(schema.jobs.id, job.id));
  expect(before?.at).toEqual(ago(20));
  await recordLinkCheck(getDb(), job.id, { outcome: "alive", at: ago(1) });
  expect((await getJobDetail(getDb(), job.id))?.lastListedAt).toEqual(before?.at);
  await recordLinkCheck(getDb(), job.id, { outcome: "gone", at: NOW });
  expect((await getJobDetail(getDb(), job.id))).toMatchObject({ lastListedAt: ago(20), relistedAt: null, relistCount: 0, lastSeenAt: ago(1), closure: { reason: "gone" } });
  expect((await list({ scope: "archive" })).jobs[0]).toMatchObject({ id: job.id, lastListedAt: ago(20), relistedAt: null, relistCount: 0, lastSeenAt: ago(1), closedReason: "gone" });
  const missing = await addJob({ status: "closed" });
  expect((await getJobDetail(getDb(), missing.id))?.lastListedAt).toBeNull();
  const [aliased] = await getDb().execute<{ at: string | null }>(sql`select ${lastListedSql(false, "j")} as at from ${schema.jobs} j where j.id = ${job.id}`);
  expect(new Date(aliased!.at!)).toEqual(ago(20));
});

it("scope SQL matches the legacy TypeScript predicate across all status, override and dormancy combinations", async () => {
  const sqlIds = (rows: { id: number | string }[]) => rows.map((row) => Number(row.id));
  const combinations = [];
  for (const status of JOB_STATUSES) for (const override of [null, "open", "closed"] as const) {
    for (const dormantAt of [null, ago(61), ago(60), ago(1)]) for (const phrase of [false, true]) {
      const job = await addJob({ status, dormantAt, linkCheckJson: phrase ? { outcome: "phrase" } : null });
      if (override) await getDb().insert(schema.jobClosureOverrides).values({ jobId: job.id, action: override });
      combinations.push({ job, status, override, dormantAt });
    }
  }
  const reasonSubsets = Array.from({ length: (1 << ARCHIVE_REASONS.length) - 1 }, (_, index) =>
    ARCHIVE_REASONS.filter((_, bit) => ((index + 1) & (1 << bit)) !== 0));
  for (const ux of [false, true]) for (const dormantReady of [false, true]) {
    for (const alias of [undefined, "j"]) {
      const from = alias ? sql`${schema.jobs} j` : sql`${schema.jobs}`;
      const id = sql`${sql.identifier(alias ?? "jobs")}.id`;
      expect(archiveReasonSql([], ux, dormantReady, alias)).toBeUndefined();
      for (const scope of JOB_SCOPES) {
        const condition = jobScopeSql(scope, ux, dormantReady, alias);
        if (scope === "all") expect(condition).toBeUndefined();
        const legacy = scope === "all" ? sql`true` : scope === "current"
          ? sql`(${effectiveStatusSql(ux, alias)} <> 'closed' and ${notDormantSql(dormantReady, alias)})`
          : sql`(${effectiveStatusSql(ux, alias)} = 'closed' or ${dormantSql(dormantReady, alias)})`;
        const actual = await getDb().execute<{ id: number | string }>(sql`select ${id} as id from ${from} where ${condition ?? sql`true`}`);
        const expected = await getDb().execute<{ id: number | string }>(sql`select ${id} as id from ${from} where ${legacy}`);
        const context = `${ux}/${dormantReady}/${alias}/${scope}`;
        expect(new Set(sqlIds(actual)), context).toEqual(new Set(sqlIds(expected)));
        const typescript = combinations.filter(({ job, status, override, dormantAt }) => {
          const isDormant = dormantReady && status === "possibly_closed" && dormantAt !== null && dormantAt > job.lastSeenAt;
          const current = effectiveJobStatus(status, ux ? override : null) !== "closed" && !isDormant;
          return scope === "all" || (scope === "current" ? current : !current);
        });
        expect(new Set(sqlIds(actual)), context).toEqual(new Set(typescript.map(({ job }) => job.id)));
      }
      for (const reasons of reasonSubsets) {
        const actual = await getDb().execute<{ id: number | string }>(sql`select ${id} as id from ${from} where ${archiveReasonSql(reasons, ux, dormantReady, alias)}`);
        const expected = await getDb().execute<{ id: number | string }>(sql`select ${id} as id from ${from} where ${inArray(closedReasonSql(ux, dormantReady, alias), reasons)}`);
        expect(new Set(sqlIds(actual)), `${ux}/${dormantReady}/${alias}/${reasons.join(",")}`).toEqual(new Set(sqlIds(expected)));
      }
    }
  }
});
