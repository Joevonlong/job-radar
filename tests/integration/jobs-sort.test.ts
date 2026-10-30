import { withRebuiltCurrentScores } from "../helpers/current-scores";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { closeDb, getDb, listJobs, type JobFilters } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import type { JobSort, SortDir } from "@/lib/jobs/constants";

/**
 * The column-head sorts of /jobs: score, comparable annual salary and first-seen time in both directions. Missing values stay
 * last in both directions, ties fall back to fixed keys so pages never repeat or skip a job.
 */

const url = inject("testDatabaseUrl");
const TZ = "Europe/Berlin";

interface Row {
  key: string;
  rank?: number | null;
  filtered?: boolean;
  salary?: unknown;
  seen: string;
}

const salary = (min: number, max: number, extra: Record<string, unknown> = {}) => ({ min, max, currency: "EUR", period: "year", basePerYear: { min, max }, baseCurrency: "EUR", ...extra });

// keys sort out the ids
const ROWS: Row[] = [
  { key: "a", rank: 90, salary: salary(80000, 100000), seen: "2026-10-01T10:00:00Z" }, // fig 90k
  { key: "b", rank: 70, salary: salary(60000, 70000), seen: "2026-10-02T10:00:00Z" }, // fig 65k
  { key: "c", rank: null, salary: salary(120000, 140000), seen: "2026-10-03T10:00:00Z" }, // unscored, fig 130k
  { key: "d", rank: 85, salary: null, seen: "2026-10-04T10:00:00Z" }, // no salary
  { key: "e", rank: 60, salary: salary(150000, 170000, { qualityStatus: "review" }), seen: "2026-10-05T10:00:00Z" }, // under review
  { key: "f", rank: 75, salary: salary(200000, 220000, { otherRegion: "currency" }), seen: "2026-10-06T10:00:00Z" }, // another region's pay
  { key: "g", rank: 95, salary: salary(50000, 60000, { baseCurrency: "USD" }), seen: "2026-10-07T10:00:00Z" }, // worked out in another base currency
  { key: "h", filtered: true, salary: salary(40000, 50000), seen: "2026-10-08T10:00:00Z" }, // hard-filtered, fig 45k
  { key: "i", rank: 70, salary: salary(60000, 70000), seen: "2026-10-02T10:00:00Z" }, // tie with b on everything but the id
];

const ids = new Map<string, number>();

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

beforeEach(async () => {
  const db = getDb();
  const [company] = await db.execute<{ id: number }>(sql`insert into companies (name, name_norm) values ('Acme', 'acme') returning id`);
  ids.clear();
  for (const row of ROWS) {
    const salaryJson = row.salary === undefined || row.salary === null ? null : JSON.stringify(row.salary);
    const [job] = await db.execute<{ id: string }>(sql`
      insert into jobs (company_id, title, title_norm, salary_json, first_seen_at, last_seen_at)
      values (${company!.id}, ${`Job ${row.key}`}, ${`job ${row.key}`}, ${salaryJson}::jsonb, ${row.seen}::timestamptz, ${row.seen}::timestamptz)
      returning id`);
    const id = Number(job!.id);
    ids.set(row.key, id);
    if (row.filtered) await withRebuiltCurrentScores(db, db.execute(sql`insert into scores (job_id, filter_result) values (${id}, 'filtered_out')`));
    else if (row.rank !== undefined) await withRebuiltCurrentScores(db, db.execute(sql`insert into scores (job_id, filter_result, score, rank_value) values (${id}, 'passed', ${row.rank}, ${row.rank})`));
  }
});

afterAll(async () => {
  await closeDb();
});

const keyOf = (id: number) => [...ids.entries()].find(([, v]) => v === id)?.[0] ?? `?${id}`;

async function order(sort: JobSort, dir: SortDir | null, filters: JobFilters = { includeFiltered: true, baseCurrency: "EUR" }, page = 1, pageSize = 50): Promise<string[]> {
  const result = await listJobs(getDb(), { filters, sort, dir, page, pageSize, timezone: TZ });
  return result.jobs.map((job) => keyOf(job.id));
}

describe("column-head sorts", () => {
  it("rank: best first by default, worst first ascending; unscored and filtered stay last both ways", async () => {
    // b and i tie on rank: the newer posting / first-seen, then the higher id
    expect(await order("rank", null)).toEqual(["g", "a", "d", "f", "i", "b", "e", "c", "h"]);
    expect(await order("rank", "desc")).toEqual(await order("rank", null));
    expect(await order("rank", "asc")).toEqual(["e", "i", "b", "f", "d", "a", "g", "c", "h"]);
  });

  it("salary: highest comparable figure first; another region's pay after them; none (unstated, review, other base) last both ways", async () => {
    const desc = await order("salary", null);
    expect(desc.slice(0, 5)).toEqual(["c", "a", "i", "b", "h"]);
    expect(desc[5]).toBe("f");
    // no comparable figure: rank desc, then first seen desc
    expect(desc.slice(6)).toEqual(["g", "d", "e"]);
    const asc = await order("salary", "asc");
    expect(asc.slice(0, 5)).toEqual(["h", "i", "b", "a", "c"]);
    expect(asc[5]).toBe("f");
    expect(asc.slice(6)).toEqual(["g", "d", "e"]);
  });

  it("salary compares in the market's base currency: under USD only the USD figure counts", async () => {
    const usd = await order("salary", null, { includeFiltered: true, baseCurrency: "USD" });
    expect(usd[0]).toBe("g");
  });

  it("first seen: newest first by default, oldest first ascending, ties by id", async () => {
    expect(await order("first_seen", null)).toEqual(["h", "g", "f", "e", "d", "c", "i", "b", "a"]);
    expect(await order("first_seen", "asc")).toEqual(["a", "b", "i", "c", "d", "e", "f", "g", "h"]);
  });

  it("pages never repeat or skip a job, in every sort and direction", async () => {
    for (const sort of ["rank", "salary", "first_seen", "posted"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        const all = await order(sort, dir);
        const paged = [...(await order(sort, dir, undefined, 1, 4)), ...(await order(sort, dir, undefined, 2, 4)), ...(await order(sort, dir, undefined, 3, 4))];
        expect(paged, `${sort} ${dir}`).toEqual(all);
      }
    }
  });

  it("filtered jobs stay hidden by default whatever the sort", async () => {
    expect(await order("salary", "asc", { baseCurrency: "EUR" })).not.toContain("h");
  });
});
