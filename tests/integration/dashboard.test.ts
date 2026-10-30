import { withRebuiltCurrentScores } from "../helpers/current-scores";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from "vitest";

import { searchPlan } from "../fixtures/job-search";
import {
  closeDb,
  getApplicationByJobId,
  getDb,
  getJobDetail,
  getJobFilterOptions,
  getLatestCycleSummary,
  getVisitState,
  jobExists,
  listApplicationEvents,
  listJobs,
  listTodayCycleSummaries,
  listTodayJobs,
  readPipelineCounts,
  recordVisit,
  schema,
  setApplicationNotes,
  setApplicationStatus,
  type ListJobsOptions,
} from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { seedDatabase } from "@/lib/db/seed";
import { describeWatchedCompanies } from "@/lib/interests/service";
import { resolveCompanyName } from "@/lib/pipeline/company";
import { loadPipeline } from "@/lib/market";

const url = inject("testDatabaseUrl");
const TZ = "Europe/Berlin";
// 14:00 Berlin on a fixed day: "today" is 2026-10-07 and there is room for jobs "earlier today"
const NOW = new Date("2026-10-07T12:00:00Z");

const base = (over: Partial<ListJobsOptions> = {}): ListJobsOptions => ({ filters: {}, sort: "rank", page: 1, pageSize: 50, timezone: TZ, ...over });

async function jobIdByTitle(title: string): Promise<number> {
  const [row] = await getDb().select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.title, title));
  if (!row) throw new Error(`no seeded job ${title}`);
  return row.id;
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

// Every test starts from the same freshly seeded database, so none depends on what an earlier test wrote
// (the tests are order independent: `--sequence.shuffle` passes).
beforeEach(async () => {
  await getDb().execute(
    sql`truncate table jobs, companies, raw_postings, runs, cycles, channels, applications, runtime_state restart identity cascade`,
  );
  await seedDatabase(getDb(), { now: NOW, timezone: TZ });
});

afterAll(async () => {
  // the test files share one database: leave it empty for the next file (applications reference jobs without a cascade)
  await getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels, applications restart identity cascade`);
  await closeDb();
});

describe("seed", () => {
  it("is idempotent: a second run replaces the first without piling up rows", async () => {
    const count = async () => {
      const [r] = await getDb().execute<{ jobs: string; raw: string; cycles: string; apps: string }>(
        sql`select (select count(*) from jobs) as jobs, (select count(*) from raw_postings) as raw, (select count(*) from cycles) as cycles, (select count(*) from applications) as apps`,
      );
      return r;
    };
    const before = await count();
    const result = await seedDatabase(getDb(), { now: NOW, timezone: TZ });
    expect(result.replacedJobs).toBe(Number(before?.jobs));
    expect(await count()).toEqual(before);
    // 25 regular fixtures (including Maplewick's dormant, gone and seen-again roles), plus the salary-origin job.
    expect(Number(before?.jobs)).toBe(26);
    const dormant = await getDb().select({ title: schema.jobs.title, status: schema.jobs.status })
      .from(schema.jobs).where(sql`${schema.jobs.dormantAt} is not null`);
    expect(dormant).toEqual([{ title: "Research Engineer, Document Retrieval", status: "possibly_closed" }]);
  });

  it("stores the company keys the pipeline computes, so seeded companies round-trip", async () => {
    const db = getDb();
    const pipeline = loadPipeline();
    const rows = await db.select({ name: schema.companies.name, nameNorm: schema.companies.nameNorm }).from(schema.companies);
    // Maplewick adds one company; the salary-origin job reuses its target's company.
    expect(rows).toHaveLength(23);
    expect(rows).toContainEqual({ name: "Maplewick Research", nameNorm: "maplewick-research" });
    for (const row of rows) expect(row.nameNorm, row.name).toBe(resolveCompanyName(row.name, pipeline).nameNorm);
    // the legal form is not part of the key
    expect(rows.find((row) => row.name === "Orbitrail AG")?.nameNorm).toBe("orbitrail");
    expect(rows.find((row) => row.name === "Wiesel & Wolf Consulting")?.nameNorm).toBe("wiesel-and-wolf-consulting");
    // what the watched-company panel and the push step do with a name of interests.yaml finds the seeded company and its job
    const [orbitrail] = await describeWatchedCompanies(["Orbitrail AG", "orbitrail"]);
    expect(orbitrail?.match).toEqual({ name: "Orbitrail AG", jobCount: 1 });
    expect((await describeWatchedCompanies(["orbitrail"]))[0]?.match?.name).toBe("Orbitrail AG");
  });

  it("replaces companies an older seed stored under non-pipeline keys, without duplicates", async () => {
    const db = getDb();
    await db.execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels, applications restart identity cascade`);
    await db.insert(schema.companies).values({ name: "Orbitrail AG", nameNorm: "orbitrail ag" });
    await seedDatabase(db, { now: NOW, timezone: TZ });
    const rows = await db.select({ nameNorm: schema.companies.nameNorm }).from(schema.companies).where(eq(schema.companies.name, "Orbitrail AG"));
    expect(rows).toEqual([{ nameNorm: "orbitrail" }]);
  });

  it("rewrites its activity fixtures in place, also after the seeded cycles were removed behind its back", async () => {
    const db = getDb();
    const count = async () => (await db.execute<Record<string, number>>(sql`select
      (select count(*)::int from activity_spans) as spans, (select count(*)::int from activity_events) as events,
      (select count(*)::int from control_requests) as requests, (select count(*)::int from run_deliveries) as deliveries`))[0];
    const before = await count();
    expect(before?.spans).toBeGreaterThan(0);
    await seedDatabase(db, { now: NOW, timezone: TZ });
    expect(await count()).toEqual(before);
    // Cycle ids restart, so the new cycle root reuses an id; the activity tables were not truncated.
    await db.execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels, applications restart identity cascade`);
    await seedDatabase(db, { now: NOW, timezone: TZ });
    expect(await count()).toEqual(before);
  });

  it("leaves rows it did not create alone", async () => {
    const db = getDb();
    const [company] = await db.insert(schema.companies).values({ name: "Real Co", nameNorm: "real co" }).returning();
    await db.insert(schema.jobs).values({ companyId: company!.id, title: "Real job", titleNorm: "real job" });
    await seedDatabase(db, { now: NOW, timezone: TZ });
    expect((await db.select().from(schema.jobs).where(eq(schema.jobs.title, "Real job"))).length).toBe(1);
  });

  it("gives one score reason sources (each JD quote at its place in the JD) and leaves the others without", async () => {
    const sourced = await getJobDetail(getDb(), await jobIdByTitle("AI Engineer (Agents)"));
    const evidence = sourced?.score?.reasonEvidence;
    expect(evidence?.fit.map((s) => s.basis)).toEqual(["inferred", "jd", "jd"]);
    expect(evidence?.gaps.map((s) => s.basis)).toEqual(["unstated"]);
    for (const s of evidence?.fit ?? []) if (s.quote !== null) expect(sourced?.description?.slice(s.offset!, s.offset! + s.quote.length)).toBe(s.quote);
    const legacy = await getJobDetail(getDb(), await jobIdByTitle("Applied Scientist, Clinical NLP"));
    expect(legacy?.score?.fitReasons.length).toBeGreaterThan(0);
    expect(legacy?.score?.reasonEvidence).toBeNull();
  });
});

describe("listJobs", () => {
  it("paginates server-side and clamps the page", async () => {
    const first = await listJobs(getDb(), base({ pageSize: 5 }));
    expect(first.jobs).toHaveLength(5);
    expect(first.pageCount).toBe(Math.ceil(first.total / 5));
    const last = await listJobs(getDb(), base({ pageSize: 5, page: 999 }));
    expect(last.page).toBe(first.pageCount);
    expect(last.jobs.length).toBeGreaterThan(0);
    const ids = new Set([...first.jobs, ...(await listJobs(getDb(), base({ pageSize: 5, page: 2 }))).jobs].map((j) => j.id));
    expect(ids.size).toBe(10);
  });

  it("sorts by rank value, best first, unscored last", async () => {
    const { jobs } = await listJobs(getDb(), base());
    const ranks = jobs.map((j) => j.rank?.rankValue ?? null);
    const scored = ranks.filter((r): r is number => r !== null);
    expect(scored).toEqual([...scored].sort((a, b) => b - a));
    const firstNull = ranks.indexOf(null);
    expect(ranks.slice(firstNull).every((r) => r === null)).toBe(true);
  });

  it("sorts by posted and first-seen time", async () => {
    const posted = (await listJobs(getDb(), base({ sort: "posted" }))).jobs;
    const times = posted.map((j) => j.postedAt?.getTime() ?? null);
    const known = times.filter((t): t is number => t !== null);
    expect(known).toEqual([...known].sort((a, b) => b - a));
    expect(times.indexOf(null)).toBeGreaterThanOrEqual(known.length);
    const seen = (await listJobs(getDb(), base({ sort: "first_seen" }))).jobs.map((j) => j.firstSeenAt.getTime());
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
  });

  it("search matches summary by default and descriptions only when requested", async () => {
    const byTitle = await listJobs(getDb(), base({ filters: { search: searchPlan("forward deployed") } }));
    expect(byTitle.jobs.map((j) => j.title)).toContain("Forward Deployed Engineer");
    const byCompany = await listJobs(getDb(), base({ filters: { search: searchPlan("quillfeath") } }));
    expect(byCompany.jobs.every((j) => j.companyName === "Quillfeather Labs")).toBe(true);
    expect(byCompany.total).toBe(1);
    const byDescription = await listJobs(getDb(), base({ filters: { search: searchPlan("Deutschlandticket") } }));
    expect(byDescription.total).toBe(0);
    expect((await listJobs(getDb(), base({ filters: { search: searchPlan("Deutschlandticket"), searchIn: "all" } }))).total).toBeGreaterThan(0);
    expect((await listJobs(getDb(), base({ filters: { search: searchPlan("zzzznothing") } }))).total).toBe(0);
    // Punctuation alone has no usable search term
    expect((await listJobs(getDb(), base({ filters: { search: searchPlan("%") } }))).total).toBe(0);
  });

  it("filters by source family", async () => {
    const xing = await listJobs(getDb(), base({ filters: { sources: ["xing"] } }));
    expect(xing.total).toBeGreaterThan(0);
    expect(xing.jobs.every((j) => j.sources.some((s) => s.family === "xing"))).toBe(true);
    const all = await listJobs(getDb(), base());
    expect(xing.total).toBeLessThan(all.total);
  });

  it("filters by city, workplace, contract, status, salary and date range", async () => {
    const munich = await listJobs(getDb(), base({ filters: { cities: ["München"] } }));
    expect(munich.total).toBeGreaterThan(0);
    expect(munich.jobs.every((j) => j.locations.some((l) => l.city === "München"))).toBe(true);

    const remote = await listJobs(getDb(), base({ filters: { workplaces: ["remote"] } }));
    expect(remote.jobs.every((j) => j.workplace === "remote")).toBe(true);

    const freelance = await listJobs(getDb(), base({ filters: { contracts: ["freelance"] } }));
    expect(freelance.jobs.map((j) => j.title)).toEqual(["Freelance ML Engineer (6 months)"]);

    const closed = await listJobs(getDb(), base({ filters: { statuses: ["possibly_closed"] } }));
    // An explicit status filter includes the dormant example; the default list hides it.
    expect(closed.total).toBe(3);
    expect(closed.jobs.map((j) => j.title).sort()).toEqual([
      "Computer Vision Engineer", "Research Engineer, Document Retrieval", "Security Engineer, Cloud",
    ]);
    expect(closed.jobs.every((j) => j.status === "possibly_closed")).toBe(true);
    expect(closed.jobs.find((j) => j.title === "Research Engineer, Document Retrieval")?.closedReason).toBe("dormant");
    const defaultList = await listJobs(getDb(), base());
    expect(defaultList.jobs.map((j) => j.title)).not.toContain("Research Engineer, Document Retrieval");

    const paid = await listJobs(getDb(), base({ filters: { salaryDisclosed: true } }));
    expect(paid.jobs.length).toBeGreaterThan(0);
    expect(paid.jobs.every((j) => j.salaryDisclosed && j.salary !== null)).toBe(true);

    const today = await listJobs(getDb(), base({ filters: { from: "2026-10-07", to: "2026-10-07" } }));
    const yesterday = await listJobs(getDb(), base({ filters: { from: "2026-10-06", to: "2026-10-06" } }));
    expect(today.total).toBeGreaterThan(0);
    expect(yesterday.total).toBeGreaterThan(0);
    expect(today.jobs.every((j) => j.firstSeenAt >= new Date("2026-10-06T22:00:00Z"))).toBe(true);
    const ids = new Set(today.jobs.map((j) => j.id));
    expect(yesterday.jobs.some((j) => ids.has(j.id))).toBe(false);
  });

  it("combines filters (AND)", async () => {
    const result = await listJobs(getDb(), base({ filters: { cities: ["Berlin"], workplaces: ["hybrid"], salaryDisclosed: true } }));
    expect(result.total).toBeGreaterThan(0);
    expect(result.jobs.every((j) => j.workplace === "hybrid" && j.salaryDisclosed && j.locations.some((l) => l.city === "Berlin"))).toBe(true);
  });

  it("attaches sources best-first, the application status and signals", async () => {
    const { jobs } = await listJobs(getDb(), base({ filters: { search: searchPlan("Forward Deployed") } }));
    const job = jobs[0];
    expect(job?.sources.map((s) => s.priority)).toEqual([...(job?.sources.map((s) => s.priority) ?? [])].sort((a, b) => a - b));
    expect(job?.sources[0]?.family).toBe("ats");
    expect(job?.applicationStatus).toBe("interested");
    expect(job?.signals.map((s) => s.tier)).toEqual(["T1", "T2"]);
    expect(job?.rank?.rankValue).toBe(97);
  });

  it("offers filter options taken from the data", async () => {
    const options = await getJobFilterOptions(getDb());
    expect(options.families).toEqual(expect.arrayContaining(["ats", "linkedin", "xing"]));
    expect(options.contracts).toEqual(expect.arrayContaining(["permanent", "freelance"]));
  });
});

describe("listTodayJobs", () => {
  it("lists jobs first seen today, ranked, hiding ignored and filtered ones", async () => {
    const today = await listTodayJobs(getDb(), { now: NOW, timezone: TZ });
    expect(today.length).toBeGreaterThan(0);
    expect(today.every((j) => j.firstSeenAt >= new Date("2026-10-06T22:00:00Z") && j.firstSeenAt < new Date("2026-10-07T22:00:00Z"))).toBe(true);
    const titles = today.map((j) => j.title);
    expect(titles).not.toContain("ML Platform Engineer"); // application archived (ignored)
    expect(titles).not.toContain("Site Reliability Engineer"); // hard-filtered
    const ranks = today.map((j) => j.rank?.rankValue ?? -1);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });

  it("includes filtered jobs on request, after the others", async () => {
    const withFiltered = await listTodayJobs(getDb(), { now: NOW, timezone: TZ, includeFiltered: true });
    const titles = withFiltered.map((j) => j.title);
    expect(titles).toContain("Site Reliability Engineer");
    expect(withFiltered.at(-1)?.rank?.filterResult).toBe("filtered_out");
  });

  it("uses the calendar day in the given time zone", async () => {
    // 22:30 UTC on Oct 6 is already Oct 7 in Berlin, but still Oct 6 in UTC
    const lateEvening = new Date("2026-10-06T22:30:00Z");
    await seedDatabase(getDb(), { now: lateEvening, timezone: TZ });
    const berlin = await listTodayJobs(getDb(), { now: lateEvening, timezone: TZ });
    const utc = await listTodayJobs(getDb(), { now: lateEvening, timezone: "UTC" });
    expect(berlin.length).toBeGreaterThan(0);
    expect(berlin.map((j) => j.id)).not.toEqual(utc.map((j) => j.id));
    await seedDatabase(getDb(), { now: NOW, timezone: TZ });
  });
});

describe("getLatestCycleSummary", () => {
  it("summarizes the latest cycle per channel, including failure and open circuit", async () => {
    const summary = await getLatestCycleSummary(getDb());
    expect(summary?.kind).toBe("weekday_morning");
    expect(summary?.status).toBe("partial");
    const byId = new Map(summary?.channels.map((c) => [c.channelId, c]));
    expect(byId.get("greenhouse")).toMatchObject({ outcome: "ok", fetched: 120, newCount: 6 });
    expect(byId.get("xing")).toMatchObject({ outcome: "circuit_open", errorCode: "blocked" });
    expect(byId.get("xing")?.circuitOpenUntil).toBeInstanceOf(Date);
    expect(byId.get("linkedin-guest")).toMatchObject({ outcome: "skipped", errorCode: "rate_limited" });
    expect(summary?.failedChannels).toBe(1);
    // new = jobs the pipeline created (not the 27 new raw postings the runs report): every job of today's seed is first seen inside this
    // cycle's window; merged = folded into existing jobs
    expect(summary?.newCount).toBe(9);
    expect(summary?.mergedCount).toBe(3);
    expect(summary?.fetched).toBe(120 + 80 + 31 + 22 + 18);
    expect(summary?.channels.reduce((sum, c) => sum + c.newCount, 0)).toBe(27);
  });

  it("seeded jobs are first seen inside the seeded cycles' windows, so every summary block has something to count", async () => {
    const db = getDb();
    const summary = await getLatestCycleSummary(db, { qualifiedMinRank: 70 });
    expect(summary?.steps.map((step) => [step.name, step.status])).toContainEqual(["collect", "partial"]);
    expect(summary?.unprocessed).toBe(0);
    const [inside] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from jobs j join cycles c on c.id = ${summary!.id} where j.first_seen_at between c.started_at and c.finished_at`,
    );
    expect(inside?.n).toBe(summary?.newCount);
    expect(summary?.passedCount).toBeGreaterThan(0);
    expect(summary?.qualifiedCount).toBeGreaterThan(0);
    const [pushed] = await db.execute<{ n: number }>(sql`select count(*)::int as n from notifications where kind = 'job' and sent_at is not null and cycle_id = ${summary!.id}`);
    expect(pushed?.n).toBe(1);
  });

  it("a cycle whose pipeline failed reports its failed steps and the postings still waiting", async () => {
    const db = getDb();
    const [cycle] = await db
      .insert(schema.cycles)
      .values({
        kind: "weekday_morning",
        status: "partial",
        startedAt: new Date(NOW.getTime() + 60_000),
        finishedAt: new Date(NOW.getTime() + 120_000),
        summaryJson: { steps: [{ name: "collect", status: "ok" }, { name: "pipeline", status: "failed", error: "ConfigError: x" }, { name: "filter", status: "failed" }] },
      })
      .returning();
    const [run] = await db.insert(schema.runs).values({ cycleId: cycle!.id, channelId: "lever", status: "succeeded", fetched: 50, newCount: 3 }).returning();
    await db.insert(schema.rawPostings).values([1, 2, 3].map((n) => ({ channelId: "lever", externalId: `pending-${n}`, payloadJson: {}, parseStatus: "pending" as const, runId: run!.id })));
    const summary = await getLatestCycleSummary(db);
    expect(summary?.id).toBe(cycle!.id);
    expect(summary?.steps.filter((step) => step.status === "failed").map((step) => step.name)).toEqual(["pipeline", "filter"]);
    expect(summary?.unprocessed).toBe(3);
  });

  it("without a pipeline summary, counts the jobs first seen inside the cycle window", async () => {
    const db = getDb();
    const startedAt = new Date("2031-01-01T10:00:00Z");
    const [cycle] = await db
      .insert(schema.cycles)
      .values({ kind: "manual", status: "succeeded", startedAt, finishedAt: new Date("2031-01-01T10:05:00Z"), summaryJson: { steps: [{ name: "collect" }] } })
      .returning();
    const [company] = await db.select().from(schema.companies).limit(1);
    const job = (title: string, firstSeenAt: string) => ({ companyId: company!.id, title, titleNorm: title, firstSeenAt: new Date(firstSeenAt) });
    await db.insert(schema.jobs).values([job("window-in-1", "2031-01-01T10:01:00Z"), job("window-in-2", "2031-01-01T10:04:00Z"), job("window-out", "2031-01-01T10:30:00Z")]);
    const summary = await getLatestCycleSummary(db);
    expect(summary?.id).toBe(cycle?.id);
    expect(summary).toMatchObject({ newCount: 2, mergedCount: null });
    await db.delete(schema.jobs).where(sql`${schema.jobs.title} like 'window-%'`);
    await db.delete(schema.cycles).where(eq(schema.cycles.id, cycle!.id));
  });

  it("reads created / merged from a pipeline step result", () => {
    expect(readPipelineCounts({ steps: [{ name: "pipeline", result: { created: 4, merged: { same_source: 1, exact_key: 2, simhash: 3 } } }] })).toEqual({ created: 4, merged: 6 });
    expect(readPipelineCounts({ steps: [{ name: "pipeline", result: { oops: true } }] })).toBeNull();
    expect(readPipelineCounts(null)).toBeNull();
  });

  it("ignores skipped cycles and returns null before any cycle", async () => {
    const db = getDb();
    await db.insert(schema.cycles).values({ kind: "manual", status: "skipped", finishedAt: new Date(), startedAt: new Date("2030-01-01T00:00:00Z") });
    expect((await getLatestCycleSummary(db))?.kind).toBe("weekday_morning");
    await db.delete(schema.runs);
    await db.delete(schema.cycles);
    expect(await getLatestCycleSummary(db)).toBeNull();
    await seedDatabase(db, { now: NOW, timezone: TZ });
  });
});

describe("getJobDetail", () => {
  it("returns the full job with sources, signals, score, application and events", async () => {
    const id = await jobIdByTitle("Forward Deployed Engineer");
    const detail = await getJobDetail(getDb(), id);
    expect(detail?.company).toMatchObject({ name: "Quillfeather Labs", watched: true });
    expect(detail?.description).toContain("What we offer");
    expect(detail?.salary).toMatchObject({ min: 85000, max: 105000, currency: "EUR", period: "year" });
    expect(detail?.sources).toHaveLength(3);
    expect(detail?.signals).toHaveLength(2);
    expect(detail?.signals[0]?.quote).toContain("85,000");
    expect(detail?.score?.fitReasons.length).toBeGreaterThan(0);
    expect(detail?.application?.status).toBe("interested");
    expect(detail?.applicationEvents.length).toBeGreaterThan(0);
  });

  it("carries the pipeline columns: apply links, agency flag, skills, per-year salary, contract and German level", async () => {
    const fde = await getJobDetail(getDb(), await jobIdByTitle("Forward Deployed Engineer"));
    expect(fde?.skills).toEqual(["Python", "TypeScript", "RAG"]);
    expect(fde?.sources[0]).toMatchObject({ family: "ats", applyUrl: expect.stringMatching(/\/apply$/) });
    expect(fde?.sources.at(-1)?.applyUrl).toBeNull();
    expect(fde?.germanLevelRequired).toBe("none");
    expect(fde?.isAgency).toBe(false);

    const tidewater = await getJobDetail(getDb(), await jobIdByTitle("Machine Learning Engineer, Perception"));
    expect(tidewater?.salary).toMatchObject({ period: "month", min: 7200, perYear: { min: 86400, max: 86400 } });

    const agency = await getJobDetail(getDb(), await jobIdByTitle("AI Consultant (via agency)"));
    expect(agency?.isAgency).toBe(true);
    const student = await listJobs(getDb(), base({ filters: { contracts: ["student"], includeFiltered: true } }));
    expect(student.jobs.map((j) => j.contract)).toEqual(["student"]);
    expect(student.jobs[0]?.germanLevelRequired).toBe("C1");
  });

  it("shows undisclosed salary as null and no score as null (C3)", async () => {
    const detail = await getJobDetail(getDb(), await jobIdByTitle("Security Engineer, Cloud"));
    expect(detail?.salary).toBeNull();
    expect(detail?.score).toBeNull();
    expect(detail?.application).toBeNull();
    expect(detail?.signals).toEqual([]);
  });

  it("returns null for an unknown job", async () => {
    expect(await getJobDetail(getDb(), 999_999_999)).toBeNull();
    expect(await jobExists(getDb(), 999_999_999)).toBe(false);
  });
});

describe("applications", () => {
  it("creates the application with one event on the first status change", async () => {
    const db = getDb();
    const id = await jobIdByTitle("Security Engineer, Cloud");
    expect(await getApplicationByJobId(db, id)).toBeNull();

    const change = await setApplicationStatus(db, id, "interested");
    expect(change).toMatchObject({ previous: null, status: "interested", changed: true });
    const events = await listApplicationEvents(db, change.applicationId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStatus: null, toStatus: "interested" });
  });

  it("writes an event per real change and none for a repeat", async () => {
    const db = getDb();
    const id = await jobIdByTitle("Security Engineer, Cloud");
    await setApplicationStatus(db, id, "interested");
    const first = await setApplicationStatus(db, id, "applied");
    expect(first).toMatchObject({ previous: "interested", changed: true });
    const again = await setApplicationStatus(db, id, "applied");
    expect(again.changed).toBe(false);
    const events = await listApplicationEvents(db, first.applicationId);
    expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual([
      ["interested", "applied"],
      [null, "interested"],
    ]);
    const application = await getApplicationByJobId(db, id);
    expect(application?.status).toBe("applied");
  });

  it("saves notes, creating the application when needed, and clears blank notes", async () => {
    const db = getDb();
    const id = await jobIdByTitle("Data Engineer");
    expect(await getApplicationByJobId(db, id)).toBeNull();
    await setApplicationNotes(db, id, "call on Monday");
    expect(await getApplicationByJobId(db, id)).toMatchObject({ status: "new", notesMd: "call on Monday" });
    await setApplicationNotes(db, id, "   ");
    expect((await getApplicationByJobId(db, id))?.notesMd).toBeNull();
    const detail = await getJobDetail(db, id);
    expect(detail?.applicationEvents).toHaveLength(1); // only the creation event
  });

  it("survives concurrent first changes: one application, still consistent", async () => {
    const db = getDb();
    const id = await jobIdByTitle("AI Consultant (via agency)");
    await Promise.all([setApplicationStatus(db, id, "interested"), setApplicationStatus(db, id, "interested"), setApplicationNotes(db, id, "n")]);
    const rows = await db.select().from(schema.applications).where(eq(schema.applications.jobId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("interested");
  });
});

// ---------------------------------------------------------------- list filters, summaries, today's cycles, visits

/** `jobs.salary_json` as the pipeline stores it, for the salary-filter tests. */
const salaryJson = (over: Record<string, unknown>) => ({
  raw: "x",
  currency: "EUR",
  period: "year",
  min: null,
  max: null,
  perYear: null,
  eurPerYear: null,
  periodAssumed: false,
  origin: "text",
  qualityStatus: "valid",
  reasonCodes: [],
  ...over,
});

describe("list filters", () => {
  const titles = async (filters: ListJobsOptions["filters"]) => (await listJobs(getDb(), base({ filters, pageSize: 200 }))).jobs.map((j) => j.title);

  it("filters by application status: several at once, `new` also means no application, `archived` finds ignored jobs", async () => {
    expect(await titles({ applicationStatuses: ["archived"] })).toEqual(["ML Platform Engineer"]);
    const interestedOrApplied = await titles({ applicationStatuses: ["interested", "applied"] });
    expect(interestedOrApplied).toContain("Forward Deployed Engineer");
    expect(interestedOrApplied).not.toContain("ML Platform Engineer");
    const all = (await listJobs(getDb(), base({ pageSize: 200 }))).total;
    const fresh = await listJobs(getDb(), base({ filters: { applicationStatuses: ["new"] }, pageSize: 200 }));
    // jobs without an application are "new": most of the seed
    expect(fresh.jobs.every((j) => j.applicationStatus === null || j.applicationStatus === "new")).toBe(true);
    expect(fresh.total).toBeGreaterThan(all / 2);
    // every status together is everything
    const every = await listJobs(getDb(), base({ filters: { applicationStatuses: ["new", "interested", "preparing", "applied", "interviewing", "offer", "rejected", "withdrawn", "archived"] }, pageSize: 200 }));
    expect(every.total).toBe(all);
    // an empty list is no filter
    expect((await listJobs(getDb(), base({ filters: { applicationStatuses: [] }, pageSize: 200 }))).total).toBe(all);
  });

  it("filters by minimum rank value: unscored and filtered-out jobs drop out", async () => {
    const result = await listJobs(getDb(), base({ filters: { minRank: 80 }, pageSize: 200 }));
    expect(result.total).toBeGreaterThan(0);
    expect(result.jobs.every((j) => (j.rank?.rankValue ?? -1) >= 80)).toBe(true);
    const lower = await listJobs(getDb(), base({ filters: { minRank: 0 }, pageSize: 200 }));
    expect(lower.total).toBeGreaterThan(result.total);
    // 0 is a real bound: it still needs a rank
    expect(lower.jobs.every((j) => j.rank?.rankValue !== null && j.rank !== null)).toBe(true);
  });

  it("filters by minimum annual salary from the normalized EUR figures only", async () => {
    const db = getDb();
    const [company] = await db.select().from(schema.companies).limit(1);
    const make = (title: string, salary: unknown) => ({ companyId: company!.id, title, titleNorm: title, salaryJson: salary as never });
    await db.insert(schema.jobs).values([
      make("sal-range-100k", salaryJson({ eurPerYear: { min: 90000, max: 100000 } })),
      make("sal-cap-only-120k", salaryJson({ eurPerYear: { min: null, max: 120000 } })),
      make("sal-open-from-80k", salaryJson({ eurPerYear: { min: 80000, max: null } })),
      make("sal-low-60k", salaryJson({ eurPerYear: { min: 55000, max: 60000 } })),
      make("sal-review-200k", salaryJson({ eurPerYear: { min: 190000, max: 200000 }, qualityStatus: "review" })),
      make("sal-usd-no-rate", salaryJson({ currency: "USD", eurPerYear: null, perYear: { min: 180000, max: 250000 } })),
      make("sal-none", null),
    ]);
    try {
      const at70 = (await titles({ minAnnualSalary: 70000 })).filter((t) => t.startsWith("sal-"));
      // cap 100k and 120k and an open "from 80k" qualify; 60k does not; a review salary, a USD one without a rate and no salary never do
      expect(at70.sort()).toEqual(["sal-cap-only-120k", "sal-open-from-80k", "sal-range-100k"]);
      const at110 = (await titles({ minAnnualSalary: 110000 })).filter((t) => t.startsWith("sal-"));
      expect(at110).toEqual(["sal-cap-only-120k"]);
      // without the filter, jobs without a salary are in
      expect(await titles({})).toContain("sal-none");
      // the seeded jobs that state a salary are honoured too (EUR 85-105k)
      expect(await titles({ minAnnualSalary: 100000 })).toContain("Forward Deployed Engineer");
      expect(await titles({ minAnnualSalary: 105001 })).not.toContain("Forward Deployed Engineer");
    } finally {
      await db.delete(schema.jobs).where(sql`${schema.jobs.title} like 'sal-%'`);
    }
  });

  it("combines the new filters with each other (AND)", async () => {
    const combined = await listJobs(getDb(), base({ filters: { applicationStatuses: ["interested"], minRank: 90 }, pageSize: 200 }));
    expect(combined.jobs.map((j) => j.title)).toEqual(["Forward Deployed Engineer"]);
    expect((await listJobs(getDb(), base({ filters: { applicationStatuses: ["interested"], minRank: 99 }, pageSize: 200 }))).total).toBe(0);
  });

  it("carries the AI summary of the newest score in both languages", async () => {
    const [job] = (await listJobs(getDb(), base({ filters: { search: searchPlan("Forward Deployed") } }))).jobs;
    expect(job?.summary).toEqual({ texts: { zh: "Forward Deployed Engineer 的虚构摘要。", en: "Fictional summary for Forward Deployed Engineer." }, outputLang: "zh" });
    // a job without a score has no summary
    const unscored = (await listJobs(getDb(), base({ pageSize: 200 }))).jobs.find((j) => j.rank === null);
    if (unscored) expect(unscored.summary).toBeNull();
  });

  it("Today applies the same filters of a saved view, and lets ignored jobs back in when asked for by status", async () => {
    const options = { now: NOW, timezone: TZ };
    const high = await listTodayJobs(getDb(), { ...options, extra: { minRank: 85 } });
    expect(high.length).toBeGreaterThan(0);
    expect(high.every((j) => (j.rank?.rankValue ?? -1) >= 85)).toBe(true);
    expect((await listTodayJobs(getDb(), options)).map((j) => j.title)).not.toContain("ML Platform Engineer");
    expect((await listTodayJobs(getDb(), { ...options, extra: { applicationStatuses: ["archived"] } })).map((j) => j.title)).toEqual(["ML Platform Engineer"]);
    expect((await listTodayJobs(getDb(), { ...options, extra: { applicationStatuses: ["interested"] } })).map((j) => j.applicationStatus)).toEqual(expect.arrayContaining(["interested"]));
  });
});

const DAY = new Date("2031-03-05T12:00:00Z");

describe("today's cycles", () => {
  it("lists every cycle of the day, newest first, with new / passed / qualified counts and the failed channels", async () => {
    const db = getDb();
    // a day with no seeded jobs or cycles, so the counts are exactly the ones made here
    const [company] = await db.select().from(schema.companies).limit(1);
    const early = new Date("2031-03-05T04:50:00Z");
    const late = new Date("2031-03-05T10:25:00Z");
    const [morning, manual, skipped, yesterday] = await db
      .insert(schema.cycles)
      .values([
        { kind: "weekday_morning", status: "succeeded", startedAt: early, finishedAt: new Date("2031-03-05T05:07:00Z"), summaryJson: { steps: [{ name: "pipeline", result: { created: 3, merged: { same_source: 0, exact_key: 0, simhash: 0 } } }] } },
        { kind: "manual", status: "partial", startedAt: late, finishedAt: new Date("2031-03-05T10:30:00Z"), summaryJson: null },
        { kind: "manual", status: "skipped", startedAt: new Date("2031-03-05T11:00:00Z"), finishedAt: new Date("2031-03-05T11:00:01Z") },
        { kind: "weekday_evening", status: "succeeded", startedAt: new Date("2031-03-04T16:00:00Z"), finishedAt: new Date("2031-03-04T16:05:00Z") },
      ])
      .returning();
    await db.insert(schema.runs).values({ cycleId: manual!.id, channelId: "xing", status: "failed", fetched: 0, newCount: 0, errorCode: "blocked", error: "blocked" });
    const job = (title: string, firstSeenAt: string) => ({ companyId: company!.id, title, titleNorm: title, firstSeenAt: new Date(firstSeenAt) });
    const created = await db
      .insert(schema.jobs)
      .values([job("cyc-a", "2031-03-05T04:55:00Z"), job("cyc-b", "2031-03-05T05:00:00Z"), job("cyc-c", "2031-03-05T05:03:00Z"), job("cyc-d", "2031-03-05T10:27:00Z"), job("cyc-e", "2031-03-01T08:00:00Z")])
      .returning({ id: schema.jobs.id, title: schema.jobs.title });
    const id = (title: string) => created.find((j) => j.title === title)!.id;
    const score = (title: string, filterResult: "passed" | "filtered_out", rankValue: number | null) => ({ jobId: id(title), filterResult, rankValue, score: rankValue, filterReasons: [] });
    await withRebuiltCurrentScores(db, db.insert(schema.scores).values([score("cyc-a", "passed", 82), score("cyc-b", "passed", 55), score("cyc-c", "filtered_out", null), score("cyc-d", "passed", 71), { ...score("cyc-e", "passed", 80), scoredAt: new Date("2031-03-05T10:28:00Z") }]));
    try {
      const list = await listTodayCycleSummaries(db, { now: DAY, timezone: TZ, qualifiedMinRank: 70 });
      // yesterday's cycle and the skipped one are not part of the day
      expect(list.map((c) => c.id)).not.toContain(skipped!.id);
      expect(list.map((c) => c.id)).not.toContain(yesterday!.id);
      expect(list.map((c) => c.startedAt.getTime())).toEqual([...list.map((c) => c.startedAt.getTime())].sort((a, b) => b - a));
      expect(list.map((c) => c.id)).toEqual([manual!.id, morning!.id]);

      const [m, e] = list;
      // manual: no pipeline summary, so new = jobs first seen in its window (cyc-d); cyc-d (71) and the backlog job cyc-e scored during the cycle (80) both pass and qualify
      expect(m).toMatchObject({ kind: "manual", newCount: 1, passedCount: 2, qualifiedCount: 2, failedChannels: 1 });
      // (the seed leaves xing's circuit open, which wins over the failed run)
      expect(m?.channels.find((c) => c.channelId === "xing")).toMatchObject({ outcome: "circuit_open", errorCode: "blocked" });
      // morning: pipeline created 3; of the jobs first seen in its window 2 passed (82 and 55), 1 is above 70
      expect(e).toMatchObject({ kind: "weekday_morning", newCount: 3, passedCount: 2, qualifiedCount: 1, failedChannels: 0 });

      // without a threshold nothing is "qualified"
      const noThreshold = await listTodayCycleSummaries(db, { now: DAY, timezone: TZ });
      expect(noThreshold.every((c) => c.qualifiedCount === null)).toBe(true);
      // the latest-cycle summary carries the counts as well
      expect(await getLatestCycleSummary(db, { qualifiedMinRank: 70 })).toMatchObject({ id: manual!.id, passedCount: 2, qualifiedCount: 2 });
    } finally {
      await db.delete(schema.jobs).where(sql`${schema.jobs.title} like 'cyc-%'`);
      await db.delete(schema.runs).where(eq(schema.runs.cycleId, manual!.id));
      await db.delete(schema.cycles).where(sql`${schema.cycles.id} in (${morning!.id}, ${manual!.id}, ${skipped!.id}, ${yesterday!.id})`);
    }
  });

  it("uses the calendar day of the time zone", async () => {
    const db = getDb();
    const [cycle] = await db.insert(schema.cycles).values({ kind: "manual", status: "succeeded", startedAt: new Date("2026-10-06T22:30:00Z"), finishedAt: new Date("2026-10-06T22:40:00Z") }).returning();
    try {
      // 22:30 UTC on Oct 6 is already Oct 7 in Berlin
      expect((await listTodayCycleSummaries(db, { now: NOW, timezone: TZ })).map((c) => c.id)).toContain(cycle!.id);
      expect((await listTodayCycleSummaries(db, { now: NOW, timezone: "UTC" })).map((c) => c.id)).not.toContain(cycle!.id);
    } finally {
      await db.delete(schema.cycles).where(eq(schema.cycles.id, cycle!.id));
    }
  });
});

describe("visits", () => {
  const at = (iso: string) => new Date(iso);

  it("remembers the last visit across opens and moves the marker only after a break", async () => {
    const db = getDb();
    await db.execute(sql`delete from runtime_state where key = 'ui:visit'`);
    expect(await getVisitState(db)).toBeNull();

    // first visit: everything before it is seen
    expect(await recordVisit(db, at("2026-10-07T08:00:00Z"))).toEqual({ seenUpTo: at("2026-10-07T08:00:00Z"), lastActiveAt: at("2026-10-07T08:00:00Z") });
    // a reload ten minutes later is the same visit: the marker stays
    expect(await recordVisit(db, at("2026-10-07T08:10:00Z"))).toEqual({ seenUpTo: at("2026-10-07T08:00:00Z"), lastActiveAt: at("2026-10-07T08:10:00Z") });
    // two hours later is a new visit: what arrived after the last activity is new
    expect(await recordVisit(db, at("2026-10-07T10:30:00Z"))).toEqual({ seenUpTo: at("2026-10-07T08:10:00Z"), lastActiveAt: at("2026-10-07T10:30:00Z") });
    expect(await getVisitState(db)).toEqual({ seenUpTo: at("2026-10-07T08:10:00Z"), lastActiveAt: at("2026-10-07T10:30:00Z") });
    await db.execute(sql`delete from runtime_state where key = 'ui:visit'`);
  });

  it("treats an unreadable stored value as no visit", async () => {
    const db = getDb();
    await db.execute(sql`insert into runtime_state (key, value) values ('ui:visit', '{"nope":1}'::jsonb) on conflict (key) do update set value = excluded.value`);
    expect(await getVisitState(db)).toBeNull();
    await db.execute(sql`delete from runtime_state where key = 'ui:visit'`);
  });
});
