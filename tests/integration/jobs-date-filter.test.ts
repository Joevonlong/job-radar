import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { closeDb, countJobList, getDb, listJobs, listUnseenJobIds, type JobFilters } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { effectiveDateRange, parseWithin } from "@/lib/jobs/date-range";
import { viewFiltersFromParams, viewFiltersToParams } from "@/lib/interests/view-filters";
import { jobsListHref, loadJobsSearchParams } from "@/lib/jobs/search-params";

/**
 * The date filter of /jobs: quick ranges and custom dates, compared by the posted date (the first-seen date where a posting has none)
 * or by the first-seen date. Time is pinned (`now`), the zone is not UTC.
 */

const url = inject("testDatabaseUrl");
const BERLIN = "Europe/Berlin";
const NOW = new Date("2026-10-20T12:00:00Z");
const HOUR = 3_600_000;
const ago = (hours: number, from: Date = NOW) => new Date(from.getTime() - hours * HOUR).toISOString();

const ids = new Map<string, number>();

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

beforeEach(async () => {
  await getDb().execute(sql`truncate jobs, companies restart identity cascade`);
  ids.clear();
});

afterAll(async () => {
  await closeDb();
});

async function addJobs(rows: { key: string; posted: string | null; seen: string }[]): Promise<void> {
  const db = getDb();
  const [company] = await db.execute<{ id: number }>(sql`insert into companies (name, name_norm) values ('Acme', 'acme') returning id`);
  for (const row of rows) {
    const [job] = await db.execute<{ id: string }>(sql`
      insert into jobs (company_id, title, title_norm, posted_at, first_seen_at, last_seen_at)
      values (${company!.id}, ${`Job ${row.key}`}, ${`job ${row.key}`}, ${row.posted}::timestamptz, ${row.seen}::timestamptz, ${row.seen}::timestamptz)
      returning id`);
    ids.set(row.key, Number(job!.id));
  }
}

const keyOf = (id: number) => [...ids.entries()].find(([, v]) => v === id)?.[0] ?? `?${id}`;

async function keys(filters: JobFilters, timezone = BERLIN): Promise<string[]> {
  const page = await listJobs(getDb(), { filters: { scope: "all", ...filters }, sort: "first_seen", dir: "desc", page: 1, pageSize: 100, timezone });
  return page.jobs.map((job) => keyOf(job.id)).sort();
}

const within = (token: string) => {
  const range = parseWithin(token);
  if (!range) throw new Error(`bad range ${token}`);
  return range;
};

describe("rolling quick ranges", () => {
  it("1 day is the last 24 hours, not today: 23 hours ago is in, 25 hours ago is out", async () => {
    await addJobs([
      { key: "in", posted: ago(23), seen: ago(23) },
      { key: "out", posted: ago(25), seen: ago(25) },
    ]);
    for (const dateField of ["posted", "seen"] as const) expect(await keys({ within: within("1d"), dateField, now: NOW })).toEqual(["in"]);
  });

  it("N days is N×24 hours back from now", async () => {
    await addJobs([
      { key: "d6", posted: ago(6 * 24), seen: ago(6 * 24) },
      { key: "d8", posted: ago(8 * 24), seen: ago(8 * 24) },
    ]);
    expect(await keys({ within: within("7d"), dateField: "posted", now: NOW })).toEqual(["d6"]);
    expect(await keys({ within: within("14d"), dateField: "posted", now: NOW })).toEqual(["d6", "d8"]);
  });

  it("a posting without a posted date counts by its first-seen date in posted mode", async () => {
    await addJobs([
      { key: "no-posted-recent", posted: null, seen: ago(3 * 24) },
      { key: "no-posted-old", posted: null, seen: ago(30 * 24) },
    ]);
    expect(await keys({ within: within("7d"), dateField: "posted", now: NOW })).toEqual(["no-posted-recent"]);
  });

  it("posted mode follows the posted date, seen mode the first-seen date", async () => {
    await addJobs([
      { key: "posted-recent", posted: ago(2 * 24), seen: ago(20 * 24) },
      { key: "seen-recent", posted: ago(10 * 24), seen: ago(1 * 24) },
    ]);
    expect(await keys({ within: within("7d"), dateField: "posted", now: NOW })).toEqual(["posted-recent"]);
    expect(await keys({ within: within("7d"), dateField: "seen", now: NOW })).toEqual(["seen-recent"]);
  });

  it("a posted date a little in the future still counts (a source's typo is not special-cased)", async () => {
    await addJobs([{ key: "future", posted: ago(-48), seen: ago(1) }]);
    expect(await keys({ within: within("7d"), dateField: "posted", now: NOW })).toEqual(["future"]);
  });

  it("the time a range counts back from is the one passed in, not the clock", async () => {
    await addJobs([{ key: "a", posted: "2026-10-10T12:00:00Z", seen: "2026-10-10T12:00:00Z" }]);
    expect(await keys({ within: within("7d"), dateField: "posted", now: new Date("2026-10-15T12:00:00Z") })).toEqual(["a"]);
    expect(await keys({ within: within("7d"), dateField: "posted", now: new Date("2026-10-20T12:00:00Z") })).toEqual([]);
  });
});

describe("this month, in the display time zone", () => {
  it("starts at local midnight of the 1st when UTC is already the new month but the zone is still the old one", async () => {
    // 2026-11-01T05:00Z is 22:00 on Oct 31 in Los Angeles (PDT): the month is October there, from Oct 1 00:00 PDT = 07:00Z
    const now = new Date("2026-11-01T05:00:00Z");
    await addJobs([
      { key: "oct-late", posted: "2026-10-01T07:30:00Z", seen: "2026-10-01T07:30:00Z" },
      { key: "sep-late", posted: "2026-10-01T06:30:00Z", seen: "2026-10-01T06:30:00Z" },
    ]);
    expect(await keys({ within: within("month"), dateField: "posted", now }, "America/Los_Angeles")).toEqual(["oct-late"]);
    // the same moment read in UTC is the new month: nothing in October counts
    expect(await keys({ within: within("month"), dateField: "posted", now }, "UTC")).toEqual([]);
  });

  it("starts at local midnight of the 1st when the zone is already the new month but UTC is still the old one", async () => {
    // 2026-11-30T23:30Z is 00:30 on Dec 1 in Berlin (CET): the month is December from 2026-11-30T23:00Z
    const now = new Date("2026-11-30T23:30:00Z");
    await addJobs([
      { key: "dec", posted: "2026-11-30T23:15:00Z", seen: "2026-11-30T23:15:00Z" },
      { key: "nov", posted: "2026-11-30T22:30:00Z", seen: "2026-11-30T22:30:00Z" },
    ]);
    expect(await keys({ within: within("month"), dateField: "posted", now }, BERLIN)).toEqual(["dec"]);
    expect(await keys({ within: within("month"), dateField: "posted", now }, "UTC")).toEqual(["dec", "nov"]);
  });

  it("compares the first-seen date in seen mode", async () => {
    await addJobs([
      { key: "a", posted: "2026-09-01T00:00:00Z", seen: "2026-10-05T10:00:00Z" },
      { key: "b", posted: "2026-10-05T10:00:00Z", seen: "2026-09-01T00:00:00Z" },
    ]);
    expect(await keys({ within: within("month"), dateField: "seen", now: NOW })).toEqual(["a"]);
    expect(await keys({ within: within("month"), dateField: "posted", now: NOW })).toEqual(["b"]);
  });
});

describe("custom dates", () => {
  it("compare first seen as before when no date is named (old links, MCP since / until)", async () => {
    await addJobs([
      { key: "seen-in", posted: "2026-08-01T00:00:00Z", seen: "2026-10-05T10:00:00Z" },
      { key: "posted-in", posted: "2026-10-05T10:00:00Z", seen: "2026-08-01T00:00:00Z" },
    ]);
    expect(await keys({ from: "2026-10-01", to: "2026-10-15" })).toEqual(["seen-in"]);
    expect(await keys({ from: "2026-10-01", to: "2026-10-15", dateField: "seen" })).toEqual(["seen-in"]);
  });

  it("compare the posted date, or the first-seen date where there is none, in posted mode; both ends are whole local days", async () => {
    await addJobs([
      { key: "posted-in", posted: "2026-10-05T10:00:00Z", seen: "2026-08-01T00:00:00Z" },
      { key: "no-posted-in", posted: null, seen: "2026-10-06T10:00:00Z" },
      { key: "no-posted-out", posted: null, seen: "2026-08-01T10:00:00Z" },
      // 2026-10-15 22:30Z is Oct 16 00:30 in Berlin: past the end of the 15th
      { key: "after-end", posted: "2026-10-15T22:30:00Z", seen: "2026-10-15T22:30:00Z" },
      { key: "last-minute", posted: "2026-10-15T21:30:00Z", seen: "2026-10-15T21:30:00Z" },
    ]);
    expect(await keys({ from: "2026-10-01", to: "2026-10-15", dateField: "posted" })).toEqual(["last-minute", "no-posted-in", "posted-in"]);
  });
});

describe("counts and mark-all-seen use the same condition as the list", () => {
  it("agree on the posted-date range", async () => {
    await addJobs([
      { key: "a", posted: ago(24), seen: ago(24) },
      { key: "b", posted: null, seen: ago(48) },
      { key: "c", posted: ago(30 * 24), seen: ago(24) },
    ]);
    const filters: JobFilters = { scope: "all", within: within("7d"), dateField: "posted", now: NOW };
    const listed = await keys(filters);
    expect(listed).toEqual(["a", "b"]);
    expect(await countJobList(getDb(), { filters, timezone: BERLIN })).toBe(listed.length);
    const unseen = await listUnseenJobIds(getDb(), { filters, timezone: BERLIN });
    expect(unseen.map(keyOf).sort()).toEqual(listed);
    // the other date selects another set, in all three
    const seenFilters: JobFilters = { ...filters, dateField: "seen" };
    expect(await keys(seenFilters)).toEqual(["a", "b", "c"]);
    expect(await countJobList(getDb(), { filters: seenFilters, timezone: BERLIN })).toBe(3);
    expect((await listUnseenJobIds(getDb(), { filters: seenFilters, timezone: BERLIN })).map(keyOf).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("no date condition", () => {
  it("lists everything, whatever date is named", async () => {
    await addJobs([
      { key: "a", posted: ago(24), seen: ago(24) },
      { key: "b", posted: null, seen: ago(5000) },
    ]);
    expect(await keys({ dateField: "posted", now: NOW })).toEqual(["a", "b"]);
  });
});

describe("a saved view recomputes its quick range for the day it is opened", () => {
  /** Save the filters of `query` as a view, open that view as a /jobs link, and read the date condition the list would query with. */
  function openedView(query: string, now: Date): JobFilters {
    const saved = viewFiltersFromParams(loadJobsSearchParams(query));
    const href = jobsListHref(viewFiltersToParams(saved));
    const { within, from, to, dateField } = effectiveDateRange(loadJobsSearchParams(href.slice(href.indexOf("?"))));
    return { within, from, to, dateField, now };
  }

  it("keeps the range, not the dates: the same view lists other jobs a few days later", async () => {
    await addJobs([
      { key: "old", posted: ago(10 * 24), seen: ago(10 * 24) },
      { key: "mid", posted: ago(5 * 24), seen: ago(5 * 24) },
      { key: "new", posted: ago(2 * 24), seen: ago(2 * 24) },
    ]);
    const view = "?within=7d&dateBy=posted";
    expect(await keys(openedView(view, NOW))).toEqual(["mid", "new"]);
    const later = new Date(NOW.getTime() + 4 * 24 * HOUR);
    expect(await keys(openedView(view, later))).toEqual(["new"]);
    const muchLater = new Date(NOW.getTime() + 30 * 24 * HOUR);
    expect(await keys(openedView(view, muchLater))).toEqual([]);
  });

  it("recomputes this month in the display time zone on each opening", async () => {
    await addJobs([
      { key: "september", posted: "2026-09-28T10:00:00Z", seen: "2026-09-28T10:00:00Z" },
      { key: "october", posted: "2026-10-15T10:00:00Z", seen: "2026-10-15T10:00:00Z" },
    ]);
    expect(await keys(openedView("?within=month&dateBy=posted", new Date("2026-10-20T12:00:00Z")))).toEqual(["october"]);
    expect(await keys(openedView("?within=month&dateBy=posted", new Date("2026-11-05T12:00:00Z")))).toEqual([]);
    expect(await keys(openedView("?within=month&dateBy=posted", new Date("2026-10-05T12:00:00Z")))).toEqual(["october"]);
  });

  it("compares the date the view names: first seen when it says so or says nothing", async () => {
    await addJobs([{ key: "reposted", posted: ago(40 * 24), seen: ago(24) }]);
    expect(await keys(openedView("?within=7d&dateBy=posted", NOW))).toEqual([]);
    expect(await keys(openedView("?within=7d&dateBy=seen", NOW))).toEqual(["reposted"]);
    expect(await keys(openedView("?within=7d", NOW))).toEqual(["reposted"]);
  });
});
