import { sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { closeDb, countTodayJobs, countTodayQuickViews, getDb, listCycleNewJobs, listRecentCycleKpis, listTodayCycleSummaries, listTodayJobs, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { latestScoreLateral } from "@/lib/db/queries/job-cards";
import { hasListableSalary } from "@/lib/db/queries/jobs";
import { policyCurrency } from "@/lib/db/queries/signal-filter";

/*
 * The Today queries read the latest score of a few jobs through a LATERAL join, and the cycle counts collect
 * the jobs of each cycle from the two indexes instead of an `or exists` join. The oracles below are the
 * queries as they were before, written out in SQL: on a small dataset with the awkward cases (ties in
 * `created_at`, rows without a score, jobs without rows, several snapshots, overlapping and running cycles,
 * a job counted twice in a window) the new queries must return exactly what the old ones did.
 */

const url = inject("testDatabaseUrl");
const TZ = "Europe/Berlin";
// all fixtures lie in the past, so a running cycle's window (up to now()) holds all its jobs
const NOW = new Date("2026-01-15T15:00:00Z");
const DAY_START = new Date("2026-01-14T23:00:00Z");
const DAY_END = new Date("2026-01-15T23:00:00Z");
const PUSH_LINE = 70;
const at = (iso: string): Date => new Date(iso);

/** The latest score as the lists computed it for every job at once (two DISTINCT ON over all of `scores`). */
const OLD_LATEST_SCORE = sql.raw(`
  latest_score as (
    select n.job_id, n.filter_result, n.filter_reasons,
      case when (n.score is null and n.filter_result = 'passed' and s.job_id is not null) then s.rank_value else n.rank_value end as rank_value,
      case when (n.score is null and n.filter_result = 'passed' and s.job_id is not null) then s.score else n.score end as score,
      case when (n.score is null and n.filter_result = 'passed' and s.job_id is not null) then s.signal_bonus else n.signal_bonus end as signal_bonus,
      case when (n.score is null and n.filter_result = 'passed' and s.job_id is not null) then true else (n.score is not null and n.stale) end as stale,
      case when (n.score is null and n.filter_result = 'passed' and s.job_id is not null) then s.german_level else n.german_level end as german_level,
      case when (n.score is null and n.filter_result = 'passed' and s.job_id is not null) then s.summary_zh else n.summary_zh end as summary_zh,
      case when (n.score is null and n.filter_result = 'passed' and s.job_id is not null) then s.summary_en else n.summary_en end as summary_en,
      case when (n.score is null and n.filter_result = 'passed' and s.job_id is not null) then s.summaries else n.summaries end as summaries,
      case when (n.score is null and n.filter_result = 'passed' and s.job_id is not null) then s.output_lang else n.output_lang end as output_lang
    from (select distinct on (job_id) job_id, filter_result, filter_reasons, score, rank_value, signal_bonus, stale, german_level, summaries, summary_zh, summary_en, output_lang
          from scores order by job_id, created_at desc, id desc) n
    left join (select distinct on (job_id) job_id, score, rank_value, signal_bonus, german_level, summaries, summary_zh, summary_en, output_lang
          from scores where score is not null order by job_id, created_at desc, id desc) s on s.job_id = n.job_id
  )`);

/** The old cycle-to-jobs join: first seen inside the cycle window, or scored during it. */
const OLD_HANDLED = sql.raw(`(
  (jobs.first_seen_at >= cycles.started_at and jobs.first_seen_at <= coalesce(cycles.finished_at, now()))
  or exists (select 1 from scores where scores.job_id = jobs.id and scores.scored_at >= cycles.started_at and scores.scored_at <= coalesce(cycles.finished_at, now()))
)`);

const OLD_SHOWN_STATUS = sql.raw(`(case (select o.action::text from job_closure_overrides o where o.job_id = jobs.id) when 'closed' then 'closed' when 'open' then 'active' else jobs.status::text end)`);
const OLD_NOT_IGNORED = sql.raw(`not exists (select 1 from applications a where a.job_id = jobs.id and a.status = 'archived')`);

async function rows<T extends Record<string, unknown>>(query: SQL) {
  return Array.from(await getDb().execute<T>(query));
}

let cycleIds: { morning: number; overlap: number; running: number; skipped: number };

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

// every test starts on empty tables (setup.ts): arrange the dataset for each
beforeEach(async () => {
  const db = getDb();

  const [company] = await db.insert(schema.companies).values({ name: "Acme", nameNorm: "acme" }).returning();
  const snapshots = await db
    .insert(schema.profileSnapshots)
    .values([1, 2, 3].map((n) => ({ kind: "preferences" as const, contentYaml: `v${n}`, hash: `h${n}`, savedAt: at(`2026-01-0${n}T00:00:00Z`) })))
    .returning();
  const snap = (n: 1 | 2 | 3): number => snapshots[n - 1]!.id;

  const [morning, overlap, running, skipped] = await db
    .insert(schema.cycles)
    .values([
      { kind: "weekday_morning", status: "succeeded", startedAt: at("2026-01-15T05:00:00Z"), finishedAt: at("2026-01-15T05:30:00Z") },
      { kind: "manual", status: "succeeded", startedAt: at("2026-01-15T05:20:00Z"), finishedAt: at("2026-01-15T06:00:00Z") },
      { kind: "manual", status: "running", startedAt: at("2026-01-15T14:00:00Z"), finishedAt: null },
      { kind: "manual", status: "skipped", startedAt: at("2026-01-15T14:30:00Z"), finishedAt: at("2026-01-15T14:30:01Z") },
    ])
    .returning();
  cycleIds = { morning: morning!.id, overlap: overlap!.id, running: running!.id, skipped: skipped!.id };

  const jobs = await db
    .insert(schema.jobs)
    .values(
      (
        [
          ["tie", "2026-01-15T05:05:00Z"], // two rows with the same created_at: the higher id wins
          ["overlap", "2026-01-15T05:25:00Z"], // in the windows of both morning cycles
          ["backlog", "2026-01-10T09:00:00Z"], // old, scored during the overlap cycle
          ["no rows", "2026-01-15T05:40:00Z"], // never filtered
          ["stale", "2026-01-15T05:45:00Z"], // newest row passed without a score: shows the older scored row
          ["filtered now", "2026-01-15T05:50:00Z"], // newest row filtered out: no fallback
          ["never scored", "2026-01-15T05:55:00Z"], // passed, no scored row at all
          ["scored twice", "2026-01-15T05:10:00Z"], // first seen and scored twice inside the morning window: counted once
          ["outside", "2026-01-12T09:00:00Z"], // in no window, not today
          ["ignored", "2026-01-15T05:15:00Z"], // archived application
          ["closed", "2026-01-15T05:16:00Z"], // closed
          ["user closed", "2026-01-15T05:17:00Z"], // closed by the user
          ["snapshots", "2026-01-15T05:18:00Z"], // the newest row (by created_at) belongs to an older snapshot
          ["late", "2026-01-15T14:10:00Z"], // inside the running cycle
          ["yesterday", "2026-01-14T21:00:00Z"], // not today, scored in the running cycle
          ["high, no score row today", "2026-01-15T10:00:00Z"], // today, outside every cycle
        ] as const
      ).map(([title, firstSeen]) => ({
        companyId: company!.id,
        title,
        titleNorm: title,
        firstSeenAt: at(firstSeen),
        status: title === "closed" ? ("closed" as const) : title === "overlap" ? ("possibly_closed" as const) : ("active" as const),
        salaryJson: title === "tie" || title === "stale" ? { currency: "EUR", period: "year", min: 80000, max: 90000, eurPerYear: { min: 80000, max: 90000 }, qualityStatus: "valid" } : null,
      })),
    )
    .returning({ id: schema.jobs.id, title: schema.jobs.title });
  const job = (title: string): number => jobs.find((j) => j.title === title)!.id;

  type Row = { title: string; snapshot: 1 | 2 | 3 | null; result?: "passed" | "filtered_out"; score?: number | null; created: string; scored?: string; stale?: boolean; level?: string };
  const fixtures: Row[] = [
    { title: "tie", snapshot: 1, score: 60, created: "2026-01-15T05:06:00Z", scored: "2026-01-15T05:07:00Z", level: "B1" },
    { title: "tie", snapshot: 2, score: 85, created: "2026-01-15T05:06:00Z", scored: "2026-01-15T05:07:00Z", level: "none" },
    { title: "overlap", snapshot: 3, score: 72, created: "2026-01-15T05:26:00Z", scored: "2026-01-15T05:27:00Z" },
    { title: "backlog", snapshot: 2, score: 40, created: "2026-01-10T09:01:00Z", scored: "2026-01-10T09:02:00Z" },
    { title: "backlog", snapshot: 3, score: 91, created: "2026-01-15T05:35:00Z", scored: "2026-01-15T05:36:00Z" },
    { title: "stale", snapshot: 2, score: 77, created: "2026-01-15T05:46:00Z", scored: "2026-01-15T05:47:00Z", level: "C1" },
    { title: "stale", snapshot: 3, score: null, created: "2026-01-15T05:48:00Z" },
    { title: "filtered now", snapshot: 2, score: 88, created: "2026-01-15T05:51:00Z", scored: "2026-01-15T05:52:00Z" },
    { title: "filtered now", snapshot: 3, result: "filtered_out", score: null, created: "2026-01-15T05:53:00Z" },
    { title: "never scored", snapshot: 3, score: null, created: "2026-01-15T05:56:00Z" },
    { title: "scored twice", snapshot: 1, score: 50, created: "2026-01-15T05:11:00Z", scored: "2026-01-15T05:12:00Z", stale: true },
    { title: "scored twice", snapshot: 2, score: 74, created: "2026-01-15T05:13:00Z", scored: "2026-01-15T05:14:00Z" },
    { title: "outside", snapshot: 3, score: 99, created: "2026-01-12T09:01:00Z", scored: "2026-01-12T09:02:00Z" },
    { title: "ignored", snapshot: 3, score: 95, created: "2026-01-15T05:15:30Z", scored: "2026-01-15T05:15:40Z" },
    { title: "closed", snapshot: 3, score: 93, created: "2026-01-15T05:16:30Z", scored: "2026-01-15T05:16:40Z" },
    { title: "user closed", snapshot: 3, score: 92, created: "2026-01-15T05:17:30Z", scored: "2026-01-15T05:17:40Z" },
    { title: "snapshots", snapshot: 3, score: 30, created: "2026-01-15T05:18:30Z", scored: "2026-01-15T05:18:40Z" },
    { title: "snapshots", snapshot: 1, score: 81, created: "2026-01-15T05:19:00Z", scored: "2026-01-15T05:19:10Z" },
    { title: "snapshots", snapshot: null, result: "filtered_out", score: null, created: "2026-01-15T05:18:50Z" },
    { title: "late", snapshot: 3, score: 71, created: "2026-01-15T14:11:00Z", scored: "2026-01-15T14:12:00Z" },
    { title: "yesterday", snapshot: 3, score: 89, created: "2026-01-14T21:01:00Z", scored: "2026-01-15T14:20:00Z" },
    { title: "high, no score row today", snapshot: 3, score: 97, created: "2026-01-15T10:01:00Z", scored: "2026-01-15T10:02:00Z" },
  ];
  await db.insert(schema.scores).values(
    fixtures.map((f): typeof schema.scores.$inferInsert => ({
      jobId: job(f.title),
      profileSnapshotId: f.snapshot === null ? null : snap(f.snapshot),
      filterResult: f.result ?? "passed",
      score: f.score ?? null,
      rankValue: f.score ?? null,
      signalBonus: f.score ? 1.5 : 0,
      stale: f.stale ?? false,
      germanLevel: f.level ?? null,
      summaries: f.score ? { en: `${f.title} ${f.snapshot}` } : {},
      outputLang: f.score ? "en" : null,
      scoredAt: f.scored ? at(f.scored) : null,
      createdAt: at(f.created),
    })),
  );
  await db.insert(schema.applications).values([
    { jobId: job("ignored"), status: "archived" },
    { jobId: job("stale"), status: "applied" },
  ]);
  await db.insert(schema.jobClosureOverrides).values({ jobId: job("user closed"), action: "closed" });
});

afterAll(async () => {
  await closeDb();
});

describe("the latest score through LATERAL", () => {
  it("is, for every job, the same row the all-jobs CTE gives (every column)", async () => {
    const db = getDb();
    const latest = latestScoreLateral(db);
    const lateral = db
      .select({
        id: schema.jobs.id,
        title: schema.jobs.title,
        jobId: latest.jobId,
        filterResult: latest.filterResult,
        filterReasons: latest.filterReasons,
        rankValue: latest.rankValue,
        score: latest.score,
        signalBonus: latest.signalBonus,
        stale: latest.stale,
        germanLevel: latest.germanLevel,
        summaryZh: latest.summaryZh,
        summaryEn: latest.summaryEn,
        summaries: latest.summaries,
        outputLang: latest.outputLang,
      })
      .from(schema.jobs)
      .leftJoinLateral(latest, sql`true`);
    const [diff] = await rows<{ old_only: string; new_only: string; n: string }>(sql`
      with ${OLD_LATEST_SCORE},
        old as (select jobs.id, l.job_id, l.filter_result, l.filter_reasons, l.rank_value, l.score, l.signal_bonus, l.stale, l.german_level, l.summary_zh, l.summary_en, l.summaries::text, l.output_lang
                from jobs left join latest_score l on l.job_id = jobs.id),
        new as (select id, job_id, filter_result, filter_reasons, rank_value, score, signal_bonus, stale, german_level, summary_zh, summary_en, summaries::text, output_lang from (${lateral}) x)
      select (select count(*) from (select * from old except all select * from new) a) as old_only,
             (select count(*) from (select * from new except all select * from old) b) as new_only,
             (select count(*) from new) as n
    `);
    expect(diff).toEqual({ old_only: "0", new_only: "0", n: "16" });

    // and the awkward cases are what the lists have always shown
    const byTitle = new Map((await lateral).map((r) => [r.title, r]));
    expect(byTitle.get("tie")).toMatchObject({ score: 85, germanLevel: "none" });
    expect(byTitle.get("stale")).toMatchObject({ score: 77, stale: true, filterResult: "passed" });
    expect(byTitle.get("filtered now")).toMatchObject({ score: null, stale: false, filterResult: "filtered_out" });
    expect(byTitle.get("never scored")).toMatchObject({ score: null, rankValue: null, filterResult: "passed" });
    expect(byTitle.get("no rows")).toMatchObject({ score: null, stale: null, filterResult: null, jobId: null });
    expect(byTitle.get("snapshots")).toMatchObject({ score: 81, rankValue: 81, signalBonus: 1.5 });
  });
});

describe("the cycle counts of Today", () => {
  const qualifies = (line: number | null): SQL => (line === null ? sql`false` : sql`(l.rank_value >= ${line} or (l.rank_value >= ${line} and false))`);

  async function oldKpis(line: number | null) {
    return rows<{ id: number; passed: number; qualified: number; salary_stated: number }>(sql`
      with ${OLD_LATEST_SCORE}
      select cycles.id::int as id,
        count(jobs.id) filter (where l.filter_result = 'passed')::int as passed,
        count(jobs.id) filter (where l.filter_result = 'passed' and ${qualifies(line)})::int as qualified,
        count(jobs.id) filter (where l.filter_result = 'passed' and ${hasListableSalary(policyCurrency(undefined))})::int as salary_stated
      from cycles left join jobs on ${OLD_HANDLED} left join latest_score l on l.job_id = jobs.id
      where cycles.status <> 'skipped'
      group by cycles.id order by cycles.started_at, cycles.id
    `);
  }

  it("listRecentCycleKpis counts the same jobs per cycle as the old join", async () => {
    for (const line of [PUSH_LINE, 80, null]) {
      const old = await oldKpis(line);
      const kpis = await listRecentCycleKpis(getDb(), { limit: 10, qualifiedMinRank: line });
      expect(kpis.map((k) => ({ id: k.cycleId, passed: k.passed, qualified: k.qualified, salary_stated: k.salaryStated }))).toEqual(
        old.map((o) => ({ ...o, qualified: line === null ? null : o.qualified })),
      );
    }
    // the dataset is not trivial: overlapping windows, a backlog job, a job scored twice, the running cycle
    expect((await oldKpis(PUSH_LINE)).map((o) => [o.passed, o.qualified])).toEqual([
      [7, 7], // morning: tie, overlap, scored twice, ignored, closed, user closed, snapshots
      [4, 3], // overlap: overlap, stale (shows its scored row), never scored (no rank), backlog; filtered now and no rows do not pass
      [2, 2], // running: late, and yesterday's job scored during it
    ]);
  });

  it("the summary of each cycle counts the same jobs as the old query", async () => {
    const summaries = await listTodayCycleSummaries(getDb(), { now: NOW, timezone: TZ, qualifiedMinRank: PUSH_LINE });
    const old = await rows<{ id: number; passed: number; qualified: number }>(sql`
      with ${OLD_LATEST_SCORE}
      select cycles.id::int as id,
        (select count(*) filter (where l.filter_result = 'passed') from jobs left join latest_score l on l.job_id = jobs.id where ${OLD_HANDLED})::int as passed,
        (select count(*) filter (where l.filter_result = 'passed' and ${qualifies(PUSH_LINE)}) from jobs left join latest_score l on l.job_id = jobs.id where ${OLD_HANDLED})::int as qualified
      from cycles where cycles.status <> 'skipped' order by cycles.started_at desc, cycles.id desc
    `);
    expect(summaries.map((s) => ({ id: s.id, passed: s.passedCount, qualified: s.qualifiedCount }))).toEqual(old);
    expect(old.map((o) => o.id)).toEqual([cycleIds.running, cycleIds.overlap, cycleIds.morning]);
  });
});

describe("the Today list, its tabs and the ticker", () => {
  const cycle = () => ({ startedAt: at("2026-01-15T05:20:00Z"), finishedAt: at("2026-01-15T06:00:00Z") });

  async function oldToday(options: { includeFiltered: boolean; withCycle: boolean }) {
    const window = options.withCycle ? sql`or (jobs.first_seen_at >= ${cycle().startedAt.toISOString()}::timestamptz and jobs.first_seen_at <= ${cycle().finishedAt.toISOString()}::timestamptz)` : sql``;
    const filtered = options.includeFiltered ? sql`` : sql`and (l.filter_result is null or l.filter_result <> 'filtered_out')`;
    return rows<{ id: number; filter_result: string | null; rank_value: string | null; score: number | null; stale: boolean | null }>(sql`
      with ${OLD_LATEST_SCORE}
      select jobs.id::int as id, l.filter_result, l.rank_value, l.score, l.stale
      from jobs inner join companies on companies.id = jobs.company_id left join latest_score l on l.job_id = jobs.id
      where ((jobs.first_seen_at >= ${DAY_START.toISOString()}::timestamptz and jobs.first_seen_at < ${DAY_END.toISOString()}::timestamptz) ${window})
        and ${OLD_NOT_IGNORED} ${filtered} and ${OLD_SHOWN_STATUS} <> 'closed'
      order by coalesce(l.filter_result = 'filtered_out', false) asc, l.rank_value desc nulls last, jobs.posted_at desc nulls last, jobs.first_seen_at desc, jobs.id desc
    `);
  }

  it("listTodayJobs, countTodayQuickViews and countTodayJobs select and order the jobs as before", async () => {
    for (const includeFiltered of [false, true]) {
      for (const withCycle of [false, true]) {
        const options = { now: NOW, timezone: TZ, cycle: withCycle ? cycle() : null, includeFiltered };
        const old = await oldToday({ includeFiltered, withCycle });
        const cards = await listTodayJobs(getDb(), options);
        expect(cards.map((c) => ({ id: c.id, rank: c.rank && { filterResult: c.rank.filterResult, rankValue: c.rank.rankValue, score: c.rank.score, stale: c.rank.stale } }))).toEqual(
          // `toRank`: no rank without a filter result; stale only with a score
          old.map((o) => ({ id: o.id, rank: o.filter_result === null ? null : { filterResult: o.filter_result, rankValue: o.rank_value === null ? null : Number(o.rank_value), score: o.score, stale: o.score !== null && (o.stale ?? false) } })),
        );
        const tabs = await countTodayQuickViews(getDb(), { ...options, quickLines: { qualifiedMinRank: PUSH_LINE } });
        expect(tabs.all).toBe(old.length);
        expect(tabs.high).toBe(old.filter((o) => o.rank_value !== null && Number(o.rank_value) >= PUSH_LINE).length);
        expect(await countTodayJobs(getDb(), options)).toBe(old.length);
      }
    }
    expect((await oldToday({ includeFiltered: false, withCycle: true })).length).toBeGreaterThan(5);
  });

  it("listCycleNewJobs gives the jobs of the cycle window in the old order", async () => {
    const old = await rows<{ id: number; rank_value: string | null }>(sql`
      with ${OLD_LATEST_SCORE}
      select jobs.id::int as id, l.rank_value
      from jobs inner join companies on companies.id = jobs.company_id left join latest_score l on l.job_id = jobs.id
      where jobs.first_seen_at >= ${cycle().startedAt.toISOString()}::timestamptz and jobs.first_seen_at <= ${cycle().finishedAt.toISOString()}::timestamptz
        and (l.filter_result is null or l.filter_result <> 'filtered_out') and ${OLD_NOT_IGNORED}
        and not exists (select 1 from job_closure_overrides o where o.job_id = jobs.id and o.action = 'closed')
      order by l.rank_value desc nulls last, jobs.first_seen_at desc, jobs.id desc
    `);
    for (const limit of [3, 100]) {
      const ticker = await listCycleNewJobs(getDb(), cycle(), limit);
      expect(ticker.map((t) => ({ id: t.id, rank_value: t.rankValue }))).toEqual(old.slice(0, limit).map((o) => ({ id: o.id, rank_value: o.rank_value === null ? null : Number(o.rank_value) })));
    }
    expect(old.length).toBeGreaterThan(3);
  });
});
